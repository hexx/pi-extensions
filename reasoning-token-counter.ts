/**
 * Reasoning トークン常時表示拡張 for pi coding agent.
 *
 * pi がモデルから受け取った Reasoning（思考）トークン数を、フッターの
 * 拡張ステータス行に常時表示する。ビルトインフッター（↑input / ↓output /
 * キャッシュ / cost / context%）には推論トークンの内訳がないため、
 * `usage.reasoning`（出力トークンの内数）を拾って表示を補完する。
 *
 * 設計: docs/reasoning-token-counter-spec.md / CONTEXT.md を参照。
 *
 * - 表示: `🧠 1.2k (72%) / 45k`（左=直近ターン＋出力比、右=セッション累計）
 * - ストリーミング中は直前ターンの確定値を出し続け、usage が届いたら
 *   今ターンの値に置き換わる（プロバイダの usage はストリーム末尾に届く
 *   ため、実質ターン確定時に値が入る。推定値は使わない）
 * - 出力比は今ターンのみ（分母=出力トークン。出力 100 未満は省略）
 * - 値が無いとき（非対応プロバイダ・thinking off）は非表示
 * - セッション累計は /new で 0 にリセット、/resume では全エントリを
 *   リプレイして再集計（ビルトインフッターと同基準: アシスタント/ツール
 *   結果の usage に加え、コンパクション・ブランチサマリの usage も含む）
 * - 設定・コマンドなし（常時ON。外したい場合は読み込み元から外す）
 *
 * npm 依存なし（Node.js 組み込み + pi extension API のみ）。
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/** フッター拡張ステータス行のキー（アルファベット順で並ぶ） */
const STATUS_KEY = "reasoning";

/**
 * ビルトインフッターの formatTokens と同じ省略ルール。
 * 1k 未満は生値、1万未満は小数1桁の k、100万未満は丸め k、以上は M。
 */
function formatCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** usage から Reasoning トークン数を取り出す。undefined と 0 は「値なし」として 0 を返す。 */
function reasoningOf(usage: { reasoning?: number } | undefined): number {
	return usage && typeof usage.reasoning === "number" && usage.reasoning > 0 ? usage.reasoning : 0;
}

/** usage から出力トークン数を取り出す（reasoning は出力の内数）。undefined と 0 は 0 を返す。 */
function outputOf(usage: { output?: number } | undefined): number {
	return usage && typeof usage.output === "number" && usage.output > 0 ? usage.output : 0;
}

/**
 * 出力トークンのうち Reasoning が占める割合（整数%）。
 * 出力 100 未満の小さいターンでは比率が不安定なため省略する。
 * reasoning が output を超える値はプロバイダ異常として扱い省略する。
 */
function reasoningPct(reasoning: number, output: number): number | undefined {
	if (reasoning <= 0 || output < 100 || reasoning > output) return undefined;
	const pct = Math.round((reasoning / output) * 100);
	// 極小の比率（例: 出力300で reasoning 1 → 0.3%）は丸めると 0% になるため省略する
	return pct > 0 ? pct : undefined;
}

/**
 * セッション全エントリから累計 Reasoning トークンを再集計する。
 * ビルトインフッターの集計対象（assistant / toolResult の usage、
 * compaction / branch_summary の usage）と同じ基準。
 */
function computeSessionReasoning(entries: SessionEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "assistant" || role === "toolResult") {
				total += reasoningOf(entry.message.usage);
			}
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			total += reasoningOf(entry.usage);
		}
	}
	return total;
}

export default function (pi: ExtensionAPI) {
	/** 直近ターンで確定済みの Reasoning トークン（message_end で加算） */
	let turnReasoning = 0;
	/** 直近ターンで確定済みの出力トークン（出力比の分母。message_end で加算） */
	let turnOutput = 0;
	/** 確定済みの直前ターン値。ストリーミング中は今ターンの実測値が入るまでこれを表示し続ける */
	let lastTurnReasoning = 0;
	/** 直前ターンの出力トークン（直前ターン値の出力比の分母） */
	let lastTurnOutput = 0;
	/** ストリーミング中のメッセージに usage が届いた場合のライブ値（確定前） */
	let liveReasoning = 0;
	/** ストリーミング中のライブ出力トークン（確定前） */
	let liveOutput = 0;
	/** セッション累計 */
	let sessionReasoning = 0;
	/** turn_start 〜 turn_end の間 true（ターン未確定） */
	let streaming = false;

	function update(ctx: ExtensionContext) {
		// JSON / print モードでは ctx.ui が利用できないため、TUI / RPC のみ更新する
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		const inProgressReasoning = turnReasoning + liveReasoning;
		const inProgressOutput = turnOutput + liveOutput;

		// 今ターン欄に出す値: ストリーミング中は今ターンの実測値（確定分＋ライブ値）が
		// 入り始めるまで、直前ターンの確定値を出し続ける（スピナーより視認性が高いため）。
		// 出力比は表示する値と対になるデータ（同じターンの出力）から計算する。
		let turnValue: number;
		let pct: number | undefined;
		if (streaming) {
			if (inProgressReasoning > 0) {
				turnValue = inProgressReasoning;
				pct = reasoningPct(inProgressReasoning, inProgressOutput);
			} else {
				turnValue = lastTurnReasoning;
				pct = reasoningPct(lastTurnReasoning, lastTurnOutput);
			}
		} else {
			turnValue = turnReasoning;
			pct = reasoningPct(turnReasoning, turnOutput);
		}

		if (turnValue > 0) {
			const pctStr = pct !== undefined ? ` (${pct}%)` : "";
			const left = theme.fg("accent", `🧠 ${formatCount(turnValue)}${pctStr}`);
			const total =
				sessionReasoning > 0 ? ` / ${theme.fg("dim", formatCount(sessionReasoning))}` : "";
			ctx.ui.setStatus(STATUS_KEY, left + total);
			return;
		}

		if (sessionReasoning > 0) {
			// 今ターンは値なし・累計のみ: 背景情報として dim で表示
			ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", `🧠 ${formatCount(sessionReasoning)}`));
			return;
		}

		// 値が一つも無い（非対応プロバイダ・thinking off など）: 非表示
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	// セッション開始（起動 /new /resume /fork）: 全エントリのリプレイで累計を再集計
	pi.on("session_start", (_event, ctx) => {
		sessionReasoning = computeSessionReasoning(ctx.sessionManager.getEntries());
		turnReasoning = 0;
		turnOutput = 0;
		lastTurnReasoning = 0;
		lastTurnOutput = 0;
		liveReasoning = 0;
		liveOutput = 0;
		streaming = false;
		update(ctx);
	});

	// ターン開始: 今ターンをリセット。直前ターンの確定値を表示し続ける
	pi.on("turn_start", (_event, ctx) => {
		turnReasoning = 0;
		turnOutput = 0;
		liveReasoning = 0;
		liveOutput = 0;
		streaming = true;
		update(ctx);
	});

	// ストリーミング中: usage が届いたらライブ表示（実質ストリーム末尾で確定値に置き換わる）
	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		liveReasoning = reasoningOf(event.message.usage);
		liveOutput = outputOf(event.message.usage);
		update(ctx);
	});

	// メッセージ確定: assistant / toolResult の usage を今ターンに加算する
	// （累計には加算しない。累計は turn_end で全エントリから導出するため）
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant" || event.message.role === "toolResult") {
			turnReasoning += reasoningOf(event.message.usage);
			turnOutput += outputOf(event.message.usage);
		}
		liveReasoning = 0;
		liveOutput = 0;
		update(ctx);
	});

	// ターン終了: 直前ターン値（Reasoning・出力）を確定させ、累計を全エントリから再集計する。
	// セッション累計は常に永続化済みエントリから導出する方式（ビルトインフッターと同じ）。
	// message_end で累計に加算しないのは、イベントの再発火などが起きても二重加算しないため。
	pi.on("turn_end", (_event, ctx) => {
		streaming = false;
		lastTurnReasoning = turnReasoning;
		lastTurnOutput = turnOutput;
		sessionReasoning = computeSessionReasoning(ctx.sessionManager.getEntries());
		update(ctx);
	});

	// コンパクション: サマリ生成の usage も累計に含めるため再集計
	pi.on("session_compact", (event, ctx) => {
		sessionReasoning = computeSessionReasoning(ctx.sessionManager.getEntries());
		update(ctx);
	});
}
