/**
 * Block Push to Main Extension
 *
 * GitHub の main ブランチ（および master ブランチ）への直接 push / 削除を禁止します。
 * `git push` コマンドをインターセプトし、対象 ref が main/master の場合にブロックします。
 *
 * 対応パターン:
 * - git push origin main                       → ブロック（main への push）
 * - git push origin +main / $'main'            → ブロック（force refspec・ANSI-C クォートも正規化）
 * - git push                                   → カレントブランチが main/master ならブロック
 * - git push --all / --mirror                  → 全ブランチ（main 含む）をチェックしブロック
 * - git push origin --delete main / :main      → ブロック（main の削除）
 * - git push origin feature-x                  → 許可（別ブランチの push は影響なし）
 * - git push --force origin main               → ブロック
 * - git push --force                           → 確認ダイアログ（非インタラクティブではブロック）
 * - timeout 120 git push                       → ブロック（ラッパーとその引数越しでも検出）
 * - sudo -u "root user" git push               → ブロック（引用符・エスケープ付き引数）
 * - env FOO=1 git push / GIT_SSH_COMMAND=ssh git push → ブロック（前置きの代入）
 * - git -C /path/to/repo push                  → ブロック（-C のディレクトリでブランチを判定）
 * - git -C . -C sub push                       → 相対パスは順に解決（git と同じ）
 * - /usr/bin/git push, ./git push              → ブロック（パス付きの git も検出）
 * - bash -c "git push origin main"             → ブロック（シェルに渡す文字列も検査）
 * - ! git push origin main / until … git push  → ブロック（制御構文・否定の前置きも境界として扱う）
 * - git push origin \<改行>main                → ブロック（行継続を結合してから判定）
 *
 * 「実行されない文字列」は対象外:
 * - echo "git push origin main" / echo "message; git push origin main"
 * - echo "bash -c 'git push origin main'"
 *   → クォートの内側は（`-c` の引数を除き）コマンドとして実行されないため、境界として扱わない。
 *
 * 注意:
 * この拡張機能は「git push コマンドの引数」をパースして判定するため、
 * `git push origin --delete <別ブランチ>` のように保護ブランチに関係ない操作を
 * 誤ってブロックすることはありません。
 *
 * 過去に素通りしていた穴（再発防止のため記録）:
 * 1. ラッパー許可リストに `timeout` が無く、`timeout 120 git push` が検出できなかった。
 *    `\btime\b` は "timeout" にマッチしないため、`time` があるように見えても素通りする。
 * 2. `getAllLocalBranches()` が `execSync("git branch --format=%(refname:short)")` を
 *    シェル経由で実行しており、sh が `(` を構文エラーにして常に [] へ潰れていた
 *    （= `--all` / `--mirror` の判定が無効）。シェルを挟まない execFileSync に変更した。
 * 3. 引用符付きの引数（`sudo -u "root user"`、`git -C "/path with spaces"`、
 *    `git push origin "main"`）や `VAR=value git push`、パス付きの git は
 *    正規表現が届かず素通りしていた。シェルトークン化（引用符・エスケープ・`$'…'`・連結）で対応した。
 * 4. `git -C <別ディレクトリ> push` を cwd で判定していたため、誤許可・誤ブロックが起きていた。
 *    マッチ時に捕捉したオプション列から `-C` を読み（複数あれば順に解決）、判定できないときは安全側でブロックする。
 * 5. 行継続（`git push origin \` 改行 `main`）・`!` 前置き・入れ子引用符の `-c` は
 *    コマンド境界の判定から漏れていた。正規化とクォート対応スキャナで対応した。
 * 6. 判定ディレクトリの取り出しで `git` ～ `push` を切り直していたため、
 *    パス名に `push` を含むディレクトリ（`/tmp/push-guard-…`）で誤って切れていた。
 *    正規表現のキャプチャで受け取る方式に変更した。
 *
 * 検出ルールの詳細と受け入れ基準は docs/block-push-to-main-spec.md、検証は
 * `node --test tests/block-push-to-main.test.ts` を参照。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

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
  return token.includes("@") || token.includes("://") || /\.git$/.test(token);
}

type PushParse =
  | { kind: "implicit" } // ref 指定なし → カレントブランチを push
  | { kind: "push"; refs: string[] } // push 対象の destination ref 一覧
  | { kind: "delete"; refs: string[] } // 削除対象の ref 一覧
  | { kind: "all" }; // --all / --mirror（全ブランチを push）

/**
 * シェルの 1 トークン。
 * `push\ guard` のようなエスケープ、`"/path with spaces"` のような引用符、
 * `$'main'` のような ANSI-C クォート、`"ma""in"` のような連結を 1 トークンとして扱う。
 */
const SHELL_TOKEN = "(?:\\$?\"[^\"]*\"|'[^']*'|\\\\.|[^\\s;&|`<>()\"'\\\\])+";

/** ラッパー・代入・git の間に挟まる要素のトークン（上と同じ） */
const TOKEN = SHELL_TOKEN;

/**
 * `text` の `start` 位置からシェルの 1 トークンを読み、クォート・エスケープを解釈して返す。
 * 連結したクォート（`"ma""in"`）やエスケープ（`ma\in`）も 1 トークンとして結合する。
 */
function readToken(text: string, start: number): { value: string; next: number } {
  let i = start;
  let value = "";
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) break;
    if (c === "$" && (text[i + 1] === "'" || text[i + 1] === '"')) {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const single = c === "'";
      let j = i + 1;
      while (j < text.length) {
        if (!single && text[j] === "\\" && j + 1 < text.length) {
          value += text[j + 1];
          j += 2;
          continue;
        }
        if (text[j] === c) break;
        value += text[j];
        j += 1;
      }
      i = j < text.length ? j + 1 : j;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      value += text[i + 1];
      i += 2;
      continue;
    }
    value += c;
    i += 1;
  }
  return { value, next: i };
}

/** 引数文字列をシェルのトークン列に分解する（クォート・エスケープを解釈する） */
function tokenizeShell(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;
    const { value, next } = readToken(text, i);
    if (next <= i) {
      i += 1;
      continue;
    }
    tokens.push(value);
    i = next;
  }
  return tokens;
}

/**
 * クォートの内側にあるシェル区切り文字を空白に置き換えた文字列を作る。
 *
 * シェルは引用符の中の `;` `&&` `|` `!` などを演算子として扱わないため、
 * これを行わないと `echo "message; git push origin main"` を誤検知する。
 * 引用符の中の `git push origin "main"` のような ref は、区切り文字を含まないのでそのまま残る。
 * （`-c` に渡す文字列は別途 commandTexts() が切り出して検査する。）
 */
function maskQuotedSeparators(command: string): string {
  const chars = [...command];
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (quote === null) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      continue;
    }
    if (quote === '"' && c === "\\") {
      i += 1;
      continue;
    }
    if (c === quote) {
      quote = null;
      continue;
    }
    if (/[\n;&|(){}!]/.test(c)) chars[i] = " ";
  }
  return chars.join("");
}

/**
 * 判定ディレクトリを求める。
 *
 * - 引数は「マッチ時に実際に読んだオプション列」を渡すこと。正規表現で `git` ～ `push` を
 *   切り直すと、パスに `push` を含むディレクトリ（`/tmp/push-guard-…`）で誤って切れる。
 * - `-C` が複数あるときは順に適用する（git と同じ: 各 `-C` は直前の `-C` の結果からの相対）。
 * - `~/` はホームに展開する。
 */
function effectiveCwd(options: string, fallback: string): string {
  let dir = fallback;
  const re = /(?:^|\s)-C(?=[\s"']|\\|[^\s-]|$)/g;
  for (const m of options.matchAll(re)) {
    let i = (m.index ?? 0) + m[0].length;
    while (i < options.length && /\s/.test(options[i])) i += 1;
    const { value } = readToken(options, i);
    if (!value) continue;
    let resolved = value;
    if (resolved === "~" || resolved.startsWith("~/")) {
      const home = process.env.HOME ?? "";
      if (home) resolved = `${home}${resolved.slice(1)}`;
    }
    if (!resolved.startsWith("/")) {
      resolved = `${dir.replace(/\/+$/, "")}/${resolved}`;
    }
    dir = resolved;
  }
  return dir;
}

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

  const tokens = tokenizeShell(rest);

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
  const remoteGiven = positionals.length > 0 && isRemoteName(positionals[0]);
  const refTokens = remoteGiven ? positionals.slice(1) : positionals;

  if (deleteMode) {
    const targets = refTokens.map((t) => (t.startsWith("+") ? t.slice(1) : t));
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

/**
 * git を実行して 1 行ずつ返す。**失敗時は null**（「失敗」と「0 行」を区別する）。
 *
 * 注意: execSync はシェル（sh）経由で実行されるため、`--format=%(refname:short)` のような
 * 引数は sh が `(` を構文エラーにして必ず失敗する。しかも catch で [] に潰れるため
 * 「静かに無効化される」。ここはシェルを挟まない execFileSync を使う。
 */
function gitLines(args: string[], cwd: string): string[] | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** コマンドの前に付きうるラッパー（`timeout 120 git push` 等）の許可リスト */
const WRAPPERS =
  "sudo|doas|time|timeout|env|nice|ionice|nohup|setsid|stdbuf|command|exec|fakeroot|proxychains|proxychains4|unbuffer|script|firejail|bwrap";

/** コマンド前の `VAR=value` 代入（`GIT_SSH_COMMAND=ssh git push` など） */
const ASSIGNMENT = `[A-Za-z_][A-Za-z0-9_]*=${TOKEN}`;

/** `git`（パス付きも可: `/usr/bin/git`、`./git`、`git.exe`） */
const GIT_CMD = `(?:[^\\s;&|\`<>()"']*/)?git(?:\\.exe)?\\b`;

/**
 * `git` とサブコマンドの間に挟まるオプション。
 * `-C <dir>` / `-C<dir>` / `-C"<dir with spaces>"` / `-c k=v` / `--git-dir <dir>` などを含む。
 */
const GIT_OPTIONS =
  `(?:\\s+(?:-C(?:${TOKEN}|\\s+${TOKEN})` +
  `|-c(?:${TOKEN}|\\s+${TOKEN})` +
  `|--git-dir(?:=|\\s+)${TOKEN}` +
  `|--work-tree(?:=|\\s+)${TOKEN}` +
  `|--[A-Za-z][-A-Za-z0-9]*(?:=${TOKEN})?` +
  `|-p))*`;

/** コマンドの境界（行頭・シェル区切り・制御構文・否定） */
const BOUNDARY =
  "(?:^|[\\n;&|`<(){}!]|\\s&&|\\s\\|\\||(?:[\\n;&|`<(){}]|^)\\s*(?:if|then|else|elif|do|while|until|for|case|function|fi|done|esac)\\s+)";

/**
 * コマンド文字列から実行対象の `git push` を探すための正規表現。
 *
 * - コマンド先頭/シェル区切り文字/制御構文（if 等）/否定（!）の直後のみを対象にする
 *   （クォート内の区切り文字は maskQuotedSeparators() で無害化してから渡す）
 * - 先頭にラッパー（sudo / timeout / env / nice など）とその引数、`VAR=value` 代入を許す。
 *   **`timeout 120 git push` のような形を検出できることが必須**
 * - キャプチャ: 1 = `git` と `push` の間のオプション列、2 = `push` の後続引数
 * - 1 つのコマンド文字列内の複数の git push をすべて検査する（g フラグ）
 */
const GIT_PUSH_RE = new RegExp(
  BOUNDARY +
    `(?:\\s*(?:(?:${WRAPPERS})\\b(?:\\s+${TOKEN})*|${ASSIGNMENT}))*` +
    `\\s*${GIT_CMD}(${GIT_OPTIONS})\\s*push\\b` +
    "([\\s\\S]*?)(?=$|[\\n;&|`<(){}!]|\\s&&|\\s\\|\\|)",
  "g",
);

/**
 * 行継続（`\` + 改行）を結合する。シェルは実行前にこの 2 文字を取り除くため、
 * 結合してから走査しないと `git push origin \<改行>main` を取りこぼす。
 */
function joinLineContinuations(command: string): string {
  return command.replace(/\\\r?\n/g, "");
}

/**
 * `sh -c "git push ..."` のように、シェルに文字列で渡されるコマンドを切り出す。
 *
 * - 実行位置（コマンド境界の直後）にあるシェルだけを対象にする
 *   （`echo "bash -c 'git push origin main'"` は実行されないので対象外）
 * - 引用符の中身はスキャナで読むため、入れ子のエスケープでも取りこぼさない
 */
function commandTexts(command: string): string[] {
  const texts = [command];
  const re = new RegExp(
    `(?:^|[\\n;&|\`<(){}!]|\\s&&|\\s\\|\\|)\\s*(?:${WRAPPERS.split("|").join("|")}|sh|bash|zsh|dash|ksh|fish)\\s+-c\\s+`,
    "g",
  );
  for (const m of command.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length;
    const quote = command[start];
    if (quote === '"' || quote === "'") {
      const { value } = readToken(command, start);
      if (value) texts.push(value);
    } else {
      const { value } = readToken(command, start);
      if (value) texts.push(value);
    }
  }
  return texts;
}

export default function (pi: ExtensionAPI) {
  // force push フラグ（--force / --force-with-lease / -f）
  const forceFlagPattern = /(--force\b(?!-)|--force-with-lease\b|-f\b)/;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const input = event.input as { command?: string } | undefined;
    const command = input?.command;
    if (!command) return undefined;

    // 行継続を結合し、クォート内の区切り文字を無害化してから走査する
    const normalized = maskQuotedSeparators(joinLineContinuations(command));
    const matches = commandTexts(normalized).flatMap((text) => [...text.matchAll(GIT_PUSH_RE)]);
    if (matches.length === 0) return undefined;

    // 判定ディレクトリ（-C があればそのパス）ごとに git の結果をキャッシュする。
    // 複合コマンドで push が並んでいても、git の起動は高々ディレクトリ数で済む。
    const metaCache = new Map<string, { remotes: string[]; branches: string[] | null }>();
    const metaFor = (cwd: string) => {
      const cached = metaCache.get(cwd);
      if (cached) return cached;
      const meta = {
        remotes: gitLines(["remote"], cwd) ?? [],
        branches: gitLines(["branch", "--format=%(refname:short)"], cwd),
      };
      metaCache.set(cwd, meta);
      return meta;
    };
    const branchCache = new Map<string, string | null>();
    const currentBranch = (cwd: string) => {
      if (!branchCache.has(cwd)) {
        const lines = gitLines(["branch", "--show-current"], cwd);
        branchCache.set(cwd, lines === null ? null : (lines[0] ?? ""));
      }
      return branchCache.get(cwd) ?? null;
    };

    const parsedList = matches.map((m) => {
      const cwd = effectiveCwd(m[1], ctx.cwd);
      const meta = metaFor(cwd);
      return {
        rest: m[2],
        cwd,
        parsed: parseGitPush(m[2], meta.remotes, meta.branches ?? []),
      };
    });

    /** 保護ブランチへの操作を検出したときのブロック応答 */
    const block = (reason: string, message: string) => {
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      return { block: true, reason };
    };

    // コマンド内のすべての git push をチェック
    for (const { rest, cwd, parsed } of parsedList) {
      // チェック対象の ref を確定
      let refsToCheck: string[] = [];
      if (parsed.kind === "implicit") {
        const current = currentBranch(cwd);
        if (current === null) {
          // ブランチが判定できない（git 失敗・非リポジトリ等）。
          // 「判定できないから許可」は検出漏れになるため、安全側でブロックする。
          return block(
            "Cannot determine current branch for implicit push",
            "🚫 カレントブランチを判定できないため、安全側で push をブロックしました（対象ディレクトリで git branch が失敗）。",
          );
        }
        if (current) refsToCheck = [current];
      } else if (parsed.kind === "all") {
        // --all / --mirror は全ローカルブランチを push するため全件チェック
        const branches = metaFor(cwd).branches;
        if (branches === null) {
          return block(
            "Cannot enumerate branches for --all/--mirror push",
            "🚫 ブランチ一覧を取得できないため、安全側で一括 push をブロックしました。",
          );
        }
        refsToCheck = branches;
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
          const current = currentBranch(cwd);
          if (current === null) {
            return block(
              "Cannot resolve HEAD for push",
              "🚫 HEAD の指すブランチを判定できないため、安全側で push をブロックしました。",
            );
          }
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
          return block(
            `Blocked ${parsed.kind} to protected branch: ${ref}`,
            `🚫 GitHub の保護ブランチ「${ref}」への直接 ${op} は禁止されています。別のブランチを使用するか、PR を作成してください。`,
          );
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