/**
 * `block-push-to-main.ts` の検出ルールの検証テスト。
 *
 *   node --test tests/block-push-to-main.test.ts
 *
 * 使い捨ての git リポジトリ（/tmp）を作り、その中でコマンドを評価して「ブロック/許可」だけを見る。
 * 実際に push は行わない（remote は存在しないパスを指す）。
 *
 * 背景（過去に素通りした穴の再発防止）:
 * 1. `timeout 120 git push` のような**ラッパー付きの push** が検出できず素通りしていた
 * 2. `--all` / `--mirror` の判定が `execSync` 経由の `%(...)` で常に失敗して無効だった
 * 3. 引用符付き引数（`sudo -u "root user"`、`git -C "/path with spaces"`、`git push origin "main"`）や
 *    `VAR=value git push`、パス付きの `git`（`/usr/bin/git`）が検出できず素通りしていた
 */
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// @ts-expect-error 拡張はリポジトリルートの素の TS（jiti / Node の型ストリップで読み込む）
import extension from '../block-push-to-main.ts';

function makeRepo(branch: string, dirName?: string): string {
  const dir = mkdtempSync(join(tmpdir(), dirName ?? 'push-guard-'));
  execSync(`git init -q -b ${branch}`, { cwd: dir });
  execSync('git -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  execSync('git remote add origin /tmp/does-not-exist.git', { cwd: dir });
  return dir;
}

const mainRepo = makeRepo('main');
const featureRepo = makeRepo('feature/x');
// 引用符付きのパス（空白入り）を通すテスト用
const spacedRepo = makeRepo('main', 'push guard-');
// git リポジトリではないディレクトリ（判定できないときに安全側で止まるか）
const notARepo = mkdtempSync(join(tmpdir(), 'push-guard-norepo-'));

type Handler = (
  event: unknown,
  ctx: unknown,
) => Promise<{ block?: boolean; reason?: string } | undefined>;

const handlers: Handler[] = [];
extension({
  on: (_event: string, handler: Handler) => {
    handlers.push(handler);
  },
  // 他の API は使っていないので、あれば呼べるようにしておく
  registerTool: () => {},
  registerCommand: () => {},
});
const handle = handlers[0];

async function run(command: string, cwd: string): Promise<{ blocked: boolean; reason?: string }> {
  const result = await handle(
    { type: 'tool_call', toolCallId: 'test', toolName: 'bash', input: { command } },
    { cwd, hasUI: false },
  );
  return { blocked: result?.block === true, reason: result?.reason };
}

const blockedCommands: [string, string, string][] = [
  ['素の push（main ブランチ）', mainRepo, 'git push'],
  ['remote と ref を明示', mainRepo, 'git push origin main'],
  ['timeout ラッパー付き（過去に素通りした形）', mainRepo, 'timeout 120 git push'],
  ['timeout + パイプ + 前段の cd（実際に素通りした形）', mainRepo, 'cd /workspace/game && timeout 120 git push 2>&1 | tail -3'],
  ['timeout + 明示 ref', mainRepo, 'timeout 120 git push origin main 2>&1 | tail -12'],
  ['--all', mainRepo, 'git push --all'],
  ['--mirror をラッパー越し', mainRepo, 'timeout 30 git push --mirror'],
  ['main の削除', mainRepo, 'git push origin --delete main'],
  ['コロン記法の削除', mainRepo, 'git push origin :main'],
  ['git -C で main のリポジトリを指定（feature 側から）', featureRepo, `git -C ${mainRepo} push`],
  ['git -C と明示 ref', featureRepo, `git -C ${mainRepo} push origin main`],
  ['-C のパスが空白入り（引用符付き）', featureRepo, `git -C "${spacedRepo}" push`],
  ['-C のパスが空白入り（エスケープ）', featureRepo, `git -C ${spacedRepo.replace(' ', '\\ ')} push`],
  ['-C のパスが空白入り（別解釈を防ぐ: 明示 ref 付き）', featureRepo, `git -C "${spacedRepo}" push origin main`],
  ['シェルに文字列で渡す', mainRepo, `bash -c "git push origin main"`],
  ['シェルに文字列で渡す（ref が引用符付き）', mainRepo, `bash -c 'git push origin "main"'`],
  ['sudo と引数付き', mainRepo, 'sudo -u root git push origin main'],
  ['sudo と引用符付き引数', mainRepo, 'sudo -u "root user" git push origin main'],
  ['timeout の引用符付き引数', mainRepo, 'timeout "120" git push origin main'],
  ['env と環境変数付き', mainRepo, 'env GIT_TRACE=1 git push origin main'],
  ['先頭の VAR=value 代入', mainRepo, 'GIT_SSH_COMMAND=ssh git push origin main'],
  ['先頭の VAR=value 代入（数値）', mainRepo, 'FOO=1 git push origin main'],
  ['パス付きの git（絶対パス）', mainRepo, '/usr/bin/git push origin main'],
  ['パス付きの git（相対パス）', mainRepo, './git push origin main'],
  ['git の長いオプション（--git-dir=）', mainRepo, 'git --git-dir=/tmp/x/.git push origin main'],
  ['git の長いオプション（--git-dir の分離形）', mainRepo, 'git --git-dir /tmp/x/.git push origin main'],
  ['git の -c（分離形）', mainRepo, 'git -c foo.bar=baz push origin main'],
  ['git の -c（密着形）', mainRepo, 'git -cfoo.bar=baz push origin main'],
  ['force refspec（+main）', mainRepo, 'git push origin +main'],
  ['HEAD:main', mainRepo, 'git push origin HEAD:main'],
  ['制御構文の直後', mainRepo, 'if true; then timeout 30 git push origin main; fi'],
  ['制御構文 until の直後', mainRepo, 'until false; do git push origin main; done'],
  ['否定の前置き（!）', mainRepo, '! git push origin main'],
  ['ANSI-C クォートの ref', mainRepo, "git push origin $'main'"],
  ['入れ子の引用符（シェル文字列）', mainRepo, 'bash -c "git push origin \\"main\\""'],
  ['-C の複数指定（最後が main）', featureRepo, `git -C ${featureRepo} -C ${mainRepo} push`],
  ['-C の相対パス（main のリポジトリ内）', mainRepo, 'git -C . push'],
  ['パス名に push を含む -C（誤切断の回帰テスト）', featureRepo, `git -C ${mainRepo} push origin main`],
  ['git リポジトリでない場所での素の push（判定不能 → 安全側）', notARepo, 'git push'],
  ['git リポジトリでない場所での --all（判定不能 → 安全側）', notARepo, 'git push --all'],
];

// 行継続（バックスラッシュ + 改行）はシェルが結合してから実行する
blockedCommands.push(
  ['行継続で main を隠す', mainRepo, 'git push origin \\\nmain'],
  ['行継続 + timeout', mainRepo, 'timeout 120 git push \\\norigin main'],
);

// 相対パスの -C を順に解決する（git と同じ）
const nestedParent = mkdtempSync(join(tmpdir(), 'push-guard-nested-'));
execSync('git init -q -b feature/x outer', { cwd: nestedParent });
execSync('git -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init', {
  cwd: join(nestedParent, 'outer'),
});
const nestedInner = join(nestedParent, 'outer', 'inner');
execSync('git init -q -b main inner', { cwd: join(nestedParent, 'outer') });
execSync('git -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init', { cwd: nestedInner });
blockedCommands.push([
  '相対パスの -C を連鎖（最後が main のリポジトリ）',
  nestedParent,
  'git -C outer -C inner push',
]);

// 引用符・エスケープの細かい形（第3回レビューの指摘）
blockedCommands.push(
  ['エスケープで ref を隠す（ma\\in）', mainRepo, 'git push origin ma\\in'],
  ['連結クォートで ref を隠す（"ma""in"）', mainRepo, 'git push origin "ma""in"'],
  ['-C の密着形 + 引用符（-C"<空白入りパス>"）', featureRepo, `git -C"${spacedRepo}" push`],
);

for (const [label, cwd, command] of blockedCommands) {
  test(`ブロックする: ${label}`, async () => {
    const result = await run(command, cwd);
    assert.equal(result.blocked, true, `${command} がブロックされていない: ${JSON.stringify(result)}`);
  });
}

const allowedCommands: [string, string, string][] = [
  ['別ブランチへの push', mainRepo, 'git push origin feature-x'],
  ['別ブランチへの push（ref が引用符付き）', mainRepo, 'git push origin "feature/x"'],
  ['feature ブランチでの素の push', featureRepo, 'git push'],
  ['feature ブランチでの timeout 付き push', featureRepo, 'timeout 60 git push -u origin HEAD'],
  ['パス付きの git で別ブランチへ', mainRepo, '/usr/bin/git push origin feature-x'],
  ['git -C で feature のリポジトリを指定（main 側から）', mainRepo, `git -C ${featureRepo} push`],
  ['git -C で feature のリポジトリを指定（明示 ref）', mainRepo, `git -C ${featureRepo} push origin feature-x`],
  ['-C の複数指定（最後が feature）', mainRepo, `git -C ${mainRepo} -C ${featureRepo} push`],
  ['-C の相対パス（feature のリポジトリ内）', featureRepo, 'git -C . push'],
  ['文字列の中の git push（実行されない）', mainRepo, 'echo "git push origin main"'],
  ['コミットメッセージの中の git push', mainRepo, 'git commit -m "git push の練習"'],
  ['無関係なコマンド', mainRepo, 'ls -la'],
  ['別ブランチの削除', mainRepo, 'git push origin --delete feature-x'],
  ['クォート内の区切り文字（echo。実行されない）', mainRepo, 'echo "message; git push origin main"'],
  ['クォート内の bash -c（echo。実行されない）', mainRepo, `echo "bash -c 'git push origin main'"`],
];

for (const [label, cwd, command] of allowedCommands) {
  test(`許可する: ${label}`, async () => {
    const result = await run(command, cwd);
    assert.equal(result.blocked, false, `${command} が誤ってブロックされた: ${JSON.stringify(result)}`);
  });
}

test('非インタラクティブでは force push を止める（安全側）', async () => {
  const result = await run('git push --force origin feature-x', featureRepo);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? '', /Force push/);
});