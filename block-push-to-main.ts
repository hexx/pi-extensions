/**
 * Block Push to Main Extension
 *
 * GitHub の main ブランチ（および master ブランチ）への直接 push / 削除を禁止します。
 * `git push` コマンドをインターセプトし、対象 ref が main/master の場合にブロックします。
 * git push --force, --force-with-lease も検出対象です。
 *
 * 対応パターン:
 * - git push origin main                       → ブロック（main への push）
 * - git push origin +main                      → ブロック（先頭 + の force push も検知）
 * - git push                                   → カレントブランチが main/master ならブロック
 * - git push --all / --mirror                  → 全ブランチ（main 含む）をチェックしブロック
 * - git push origin --delete main              → ブロック（main の削除）
 * - git push origin --delete feature-x         → 許可（別ブランチの削除は影響なし）
 * - git push origin feature-x                  → 許可（別ブランチの push は影響なし）
 * - git push --force origin main               → ブロック
 * - git push --force                           → 確認ダイアログ
 *
 * 注意:
 * この拡張機能は「git push コマンドの引数」をパースして判定するため、
 * `git push origin --delete <別ブランチ>` のように保護ブランチに関係ない操作を
 * 誤ってブロックすることはありません。また、複数の git push を含む複合コマンドや
 * echo 内の文字列のみの `git push` も適切に扱います。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

const PROTECTED_BRANCHES = ["main", "master"];

/** 保護ブランチへの直接 push / 削除を判定するための ref 正規化 */
function isProtectedRef(ref: string): boolean {
  const r = ref.trim();
  if (PROTECTED_BRANCHES.includes(r)) return true;
  // refs/heads/main, refs/heads/master, heads/main など
  if (/^(?:refs\/)?heads\/(main|master)$/.test(r)) return true;
  return false;
}

/** URL 等、明らかにリモートを示すトークン（実際の remote 名は getAllRemotes で補完） */
function isRemoteLike(token: string): boolean {
  return (
    token.includes("@") ||
    token.includes("://") ||
    /\.git$/.test(token)
  );
}

type PushParse =
  | { kind: "implicit" } // ref 指定なし → カレントブランチを push
  | { kind: "push"; refs: string[] } // push 対象の destination ref 一覧
  | { kind: "delete"; refs: string[] } // 削除対象の ref 一覧
  | { kind: "all" }; // --all / --mirror（全ブランチを push）

/**
 * `git push` の後続引数をパースし、操作の種類と対象 ref を返します。
 * `remotes` は `git remote` で得られる実際のリモート名一覧で、これと isRemoteLike で
 * リモート名と ref を区別します（カスタムリモート名でも誤判定しません）。
 *
 * - `--delete` / `-d` がある場合は削除モード
 * - `--all` / `--mirror` がある場合は全ブランチ push（main を含む可能性あり）
 * - それ以外は push モード。refspec の `:` より後（destination）を対象とし、
 *   refspec 先頭の `+`（force フラグ）は除去してから判定する
 * - ref 指定が無い場合は implicit（カレントブランチ）
 */
function parseGitPush(
  rest: string,
  remotes: string[],
  localBranches: string[],
): PushParse {
  // git の規約: 最初の位置引数がリモート名（実際の remote 名、または URL 等）。
  // remote 名か ref かが曖昧な場合（git remote 取得失敗時など）は、ローカルブランチ一覧でも
  // 判定する。refspec っぽくない（`:`/`/` を含まず、ローカルブランチでもない）トークンを remote とみなす。
  const looksLikeRef = (t: string) => t.includes(":") || t.includes("/");
  const isRemoteName = (t: string) =>
    t === "origin" ||
    t === "upstream" ||
    remotes.includes(t) ||
    isRemoteLike(t) ||
    (!looksLikeRef(t) && !localBranches.includes(t));

  const tokens = rest.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];

  let deleteMode = false;
  const positionals: string[] = [];
  for (const t of tokens) {
    if (t === "--delete" || t === "-d") {
      deleteMode = true;
      continue;
    }
    // --all / --mirror は全ブランチ（main を含む）を push するため別扱い
    if (t === "--all" || t === "--mirror") {
      return { kind: "all" };
    }
    // その他のオプション（-f, --force, -u, --force-with-lease 等）は除外
    if (t.startsWith("-")) continue;
    // シェル演算子・リダイレクトは除外
    if (/^[;&|`<>()]+$/.test(t)) continue;
    if (t.includes(">") || t.includes("<")) continue;
    positionals.push(t);
  }

  // 最初の位置引数がリモート名ならそれを remote とみなし、残りが refspec / 削除対象。
  // 最初の引数がリモート名でなければ（remote 省略時）、全位置引数が refspec。
  const remoteGiven =
    positionals.length > 0 && isRemoteName(positionals[0]);
  const refTokens = remoteGiven ? positionals.slice(1) : positionals;

  if (deleteMode) {
    const targets = refTokens.map((t) =>
      t.startsWith("+") ? t.slice(1) : t,
    );
    return { kind: "delete", refs: targets };
  }

  if (refTokens.length === 0) {
    // remote のみ指定、または引数なし → カレントブランチの暗黙的 push
    return { kind: "implicit" };
  }

  const refs = refTokens
    .map((r) => {
      const stripped = r.startsWith("+") ? r.slice(1) : r;
      if (!stripped.includes(":")) return stripped;
      const idx = stripped.indexOf(":");
      const dst = stripped.slice(idx + 1);
      // コロン記法の削除（`:main`）は先頭の `:` を残し、呼び側で「削除」と判定できるようにする
      if (idx === 0) return stripped;
      // `<src>:<dst>` 形式。dst が空（例: `main:`）の場合は git と同様に src を宛先とする
      return dst || stripped.slice(0, idx);
    })
    .filter((r): r is string => Boolean(r));

  if (refs.length === 0) return { kind: "implicit" };
  return { kind: "push", refs };
}

/** カレントブランチを取得（失敗時は "" を返す） */
function getCurrentBranch(cwd: string): string {
  try {
    return execSync("git branch --show-current", {
      encoding: "utf-8",
      cwd,
    }).trim();
  } catch {
    return "";
  }
}

/** 全ローカルブランチを取得（--all / --mirror 用。失敗時は [] を返す） */
function getAllLocalBranches(cwd: string): string[] {
  try {
    return execSync("git branch --format=%(refname:short)", {
      encoding: "utf-8",
      cwd,
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 設定されているリモート名一覧を取得（失敗時は [] を返す） */
function getAllRemotes(cwd: string): string[] {
  try {
    return execSync("git remote", { encoding: "utf-8", cwd })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  // force push フラグ（--force / --force-with-lease / -f）
  const forceFlagPattern = /(--force\b(?!-)|--force-with-lease\b|-f\b)/;

  // git が「実際に実行されるコマンド」として現れる文脈のみを対象とし、
  // 1 つのコマンド文字列内の複数の git push をすべて検査する（g フラグ）。
  // 直前がシェル区切り文字、または if/while/for/then/do/else/{ 等の制御構文
  // （ただし区切り文字または行頭の直後にある場合のみ。echo 等の引数内は除外）の場合にマッチする。
  const GIT_PUSH_RE =
    /(?:^|[\n;&|`<(){}]|\s&&|\s\|\||(?:[\n;&|`<(){}]|^)\s*(?:if|then|else|elif|do|while|for|case|function|fi|done|esac)\s+)(?:\s*(?:sudo|time|env|nice|nohup|setsid)\b)*\s*git\s+push\b([\s\S]*?)(?=$|[\n;&|`<(){}]|\s&&|\s\|\|)/g;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const input = event.input as { command?: string } | undefined;
    const command = input?.command;
    if (!command) return undefined;

    const matches = [...command.matchAll(GIT_PUSH_RE)];
    if (matches.length === 0) return undefined;

    const remotes = getAllRemotes(ctx.cwd);
    const localBranches = getAllLocalBranches(ctx.cwd);
    const parsedList = matches.map((m) => ({
      rest: m[1],
      parsed: parseGitPush(m[1], remotes, localBranches),
    }));

    // コマンド内のすべての git push をチェック
    for (const { rest, parsed } of parsedList) {
      // チェック対象の ref を確定
      let refsToCheck: string[] = [];
      if (parsed.kind === "implicit") {
        const current = getCurrentBranch(ctx.cwd);
        if (current) refsToCheck = [current];
      } else if (parsed.kind === "all") {
        // --all / --mirror は全ローカルブランチを push するため全件チェック
        refsToCheck = getAllLocalBranches(ctx.cwd);
      } else {
        refsToCheck = parsed.refs;
      }

      for (const rawRef of refsToCheck) {
        let ref = rawRef;
        // `:main` はコロン記法による削除（git push origin :main）
        const isColonDelete = ref.startsWith(":");
        if (isColonDelete) ref = ref.slice(1);
        // HEAD はカレントブランチへ解決
        if (ref === "HEAD") {
          const current = getCurrentBranch(ctx.cwd);
          if (!current) continue;
          ref = current;
        }
        if (isProtectedRef(ref)) {
          const op =
            parsed.kind === "delete" || isColonDelete
              ? "削除"
              : parsed.kind === "all"
                ? "一括 push"
                : "push";
          if (ctx.hasUI) {
            ctx.ui.notify(
              `🚫 GitHub の保護ブランチ「${ref}」への直接 ${op} は禁止されています。別のブランチを使用するか、PR を作成してください。`,
              "error",
            );
          }
          return {
            block: true,
            reason: `Blocked ${parsed.kind} to protected branch: ${ref}`,
          };
        }
      }

      // force push の警告は「この git push コマンド自体」の引数内のみに限定して評価
      // （複合コマンド内の別の --delete に影響されないよう、マッチごとに判定）
      if (parsed.kind !== "delete" && forceFlagPattern.test(rest)) {
        if (ctx.hasUI) {
          try {
            const choice = await ctx.ui.select(
              `⚠️ Force push が検出されました:\n\n  ${command}\n\n実行しますか？`,
              ["いいえ（ブロック）", "はい（許可）"],
            );

            if (choice !== "はい（許可）") {
              return { block: true, reason: "Force push blocked by user" };
            }
          } catch {
            // UI エラー時は安全側に倒してブロック
            return {
              block: true,
              reason: "Force push blocked due to UI error",
            };
          }
        } else {
          // 非インタラクティブモードでは force push をブロック
          return {
            block: true,
            reason: "Force push blocked in non-interactive mode",
          };
        }
      }
    }

    return undefined;
  });
}
