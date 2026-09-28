# 仕様書：`block-push-to-main.ts` — main への直接 push を禁止する拡張

対象: リポジトリルートの `block-push-to-main.ts`／検証: `tests/block-push-to-main.test.ts`

## 1. 背景と目的

エージェント（pi）が `main` / `master` へ直接 push してしまう事故を、**ツール呼び出しの段階で止める**のが目的。
サーバ側（GitHub の ruleset で PR 必須にする）と二重にする前提の、クライアント側のゲートである。

実際にこの拡張をすり抜けて `main` へ直接 push できた事故が複数あり、本仕様はその穴を塞いだ後の挙動を定める。

| # | 穴 | 内容 | 対策 |
| --- | --- | --- | --- |
| 1 | ラッパー未対応 | ラッパー許可リストが `sudo\|time\|env\|nice\|nohup\|setsid` のみで **`timeout` が無い**。エージェントの定番の `timeout 120 git push` が検出できず素通りした（`\btime\b` は "timeout" にマッチしない） | ラッパー一覧を拡張し、さらに**ラッパーの引数**（`120`、`-u root`、`FOO=1`）を読み飛ばしてから `git push` を探す |
| 2 | `--all` が無効 | `getAllLocalBranches()` が `execSync("git branch --format=%(refname:short)")` を**シェル経由**で実行しており、sh が `(` を構文エラーにして例外 → `catch` で `[]` に潰れ、`--all` / `--mirror` の判定が常に空振りしていた | シェルを挟まない `execFileSync` に変更（`gitLines()` ヘルパに集約） |
| 3 | 引用符・エスケープ・代入・パス | `sudo -u "root user" git push`、`git -C "/path with spaces" push`、`git push origin "main"`、`GIT_SSH_COMMAND=ssh git push`、`/usr/bin/git push` が検出できず素通りしていた | シェルトークン化（引用符・バックスラッシュエスケープを 1 トークンとして扱う）と、`VAR=value` 代入・パス付き `git` の許可 |
| 4 | `-C` の判定ディレクトリ | `git -C <別リポジトリ> push` を `ctx.cwd` で判定していたため、**誤許可**（feature 側から `-C` で main のリポジトリを push）と**誤ブロック**（main 側から `-C` で feature のリポジトリを push）の両方が起きていた | マッチごとに `-C` のパスを読み、そのディレクトリでブランチ・リモートを判定する |
| 5 | 判定不能時の素通り | ブランチ一覧やカレントブランチの取得失敗が「0 行（対象なし）」と同じ扱いになり、`--all` や暗黙 push が素通りしうる | 取得失敗を `null` で区別し、**判定できないときはブロック**（fail closed） |

## 2. 決定済みの基本方針

- 判定は **`git push` の引数のパース**で行う（`git` を実行して結果を見る方式は採らない。副作用と遅延を避けるため）
- ブロック対象は **保護ブランチ（`main` / `master`）への push・削除・force な push** のみ。別ブランチの操作は許可する
- **誤検知より検出漏れを避ける**。文字列中の `git push`（`echo "git push main"` 等）は実行されないため対象外にするが、実行されうる形は広く拾う
- 判定に必要な情報が得られない場合は**安全側に倒す**（§3.7）
- 非インタラクティブ（`ctx.hasUI === false`）では force push を**ブロック**する（安全側）

## 3. 検出ルール

### 3.1 コマンドとして現れる位置のみを対象にする

`git push` の直前が、行頭／シェル区切り（`;` `&&` `||` `|` 改行 `` ` `` `(` `{`）／制御構文（`if then else elif do while until for case function`）／否定（`!`）である場合のみ検出する。

**クォートの中は実行されない**ので、先に「クォート内の区切り文字を空白に置き換える」前処理（`maskQuotedSeparators`）を行う。
これにより次を誤検知しない:

- `echo "git push origin main"`
- `echo "message; git push origin main"`（クォート内の `;` は演算子ではない）
- `echo "bash -c 'git push origin main'"`

なお、バックティックはシェルのコマンド置換（`` `git push …` ``）でもあるため、**バックティックの直後は実行されうる形として拾う**。
ヒアドキュメントで仕様を書くときなどに誤爆しうるが、「検出漏れを避ける」方を優先する（§2）。
ブロックされた場合は、その行を `write` / `edit` などシェルを経由しない手段で書けばよい。

**行継続**（`\` + 改行）はシェルが実行前に取り除くため、**走査の前に結合する**。
結合しないと `git push origin \<改行>main` のように ref を改行で隠せてしまう。

### 3.2 シェルトークン化

ラッパーの引数・ref・オプションの値は、**引用符付き・バックスラッシュエスケープ付きの 1 トークン**として扱う。

| 入力 | 解釈 |
| --- | --- |
| `/tmp/repo` | そのまま |
| `"/tmp/repo with spaces"` / `'/tmp/repo with spaces'` | 内側の文字列（空白を含む 1 トークン） |
| `/tmp/repo\ with\ spaces` | エスケープを解いて 1 トークン |
| `origin "main"` / `origin $'main'` | ref は `main`（クォートは外して比較） |
| `ma\in` / `"ma""in"` | ref は `main`（エスケープと連結クォートを結合して比較） |

分解は正規表現ではなくスキャナ（`readToken` / `tokenizeShell`）で行う。連結したクォートやエスケープを 1 トークンとして結合できることが目的。

### 3.3 ラッパーと前置き

`git` の前に付くものを読み飛ばす。

- ラッパー（引数付きも可）:
  `sudo|doas|time|timeout|env|nice|ionice|nohup|setsid|stdbuf|command|exec|fakeroot|proxychains|proxychains4|unbuffer|script|firejail|bwrap`
- `VAR=value` の代入（`GIT_SSH_COMMAND=ssh git push`、`FOO=1 git push`）
- 例: `timeout 120 git push` / `sudo -u "root user" git push` / `env GIT_TRACE=1 git push` / `nice -n 5 git push`

### 3.4 `git` の書き方とオプション

- `git` 本体はパス付きでもよい（`/usr/bin/git`、`./git`、`git.exe`）
- `git` と `push` の間のオプションを読み飛ばす: `-C <dir>` / `-C<dir>` / `-C"<dir with spaces>"` / `-c key=value` / `-ckey=value` / `--git-dir=<dir>` / `--git-dir <dir>` / `--work-tree …` / `--no-pager` などの `--xxx`

### 3.5 シェルに文字列で渡す形

`sh|bash|zsh|dash|ksh|fish -c "…"` の引用符内も同じ規則で検査する。

- 切り出しは**クォートを読むスキャナ**で行い、入れ子のエスケープ（`bash -c "git push origin \"main\""`）でも中身を取りこぼさない
- **実行位置（コマンド境界の直後）にあるシェルだけ**を対象にする（`echo "bash -c 'git push origin main'"` は対象外）

### 3.6 対象 ref の決定

| push の形 | 対象 |
| --- | --- |
| ref 指定あり（`origin main`） | その ref（`+main` の `+`、`src:dst` の dst を正規化） |
| ref 指定なし（`git push`） | **カレントブランチ**（`git branch --show-current`） |
| `--all` / `--mirror` | **全ローカルブランチ**（`git branch --format=%(refname:short)`） |
| `--delete` / `-d` / `:main` | 削除対象の ref |
| `origin HEAD:main` / `origin HEAD` | `HEAD` をカレントブランチに解決してから判定 |

判定に使うディレクトリは、**そのマッチの `-C <dir>` があればそのディレクトリ**、無ければ実行時の cwd（§1 の穴 4）。
`-C` が複数あるときは**順に適用する**（git と同じく、各 `-C` は直前の `-C` の結果からの相対）。
この判定ディレクトリは、`git` と `push` の**間のオプション列（マッチ時に捕捉したもの）**から取り出す。
マッチ済みの文字列を `git` ～ `push` で切り直す方式は、パスに `push` を含むディレクトリ（`/tmp/push-guard-…`）で誤って切れるため採らない。

### 3.7 判定不能時（fail closed）

次の場合は「対象が無い」とみなさず**ブロック**する。

- 暗黙 push でカレントブランチが取得できない（git 失敗・非リポジトリ・`-C` のパスが不正など）
- `--all` / `--mirror` でブランチ一覧が取得できない
- `HEAD` の指すブランチが取得できない

### 3.8 force push

保護ブランチ宛てなら §3.6 の判定でブロック。保護ブランチ以外でも `--force` / `--force-with-lease` / `-f` を検出した場合は、UI があれば確認ダイアログ、無ければブロック。

## 4. 実装の要点

- ファイル: リポジトリルートの `block-push-to-main.ts`（無依存・Node 組み込み＋pi extension API のみ）
- git の実行は **`execFileSync`（シェル無し）**に統一（`gitLines()`）。`execSync` + `%(...)` は sh が `(` で失敗し、`catch` により**静かに無効化**されるため使わない
- `gitLines()` は失敗を `null` で返し、呼び側が fail closed を判断できるようにする
- コマンド本文は `commandTexts()` で「コマンド全体＋`-c` の引用符内」に展開してから同じ正規表現で走査する（行継続は事前に結合）
- 判定ディレクトリごとに `git remote` / `git branch` の結果を**ハンドラ内でキャッシュ**する（複合コマンドで push が並んでも git 起動は高々ディレクトリ数）

## 5. 検証

```bash
node --test tests/block-push-to-main.test.ts
```

- 使い捨ての git リポジトリ（`main` / `feature/x` / 空白入りパス / 非リポジトリ）を `/tmp` に作り、
  拡張を実ロードして `tool_call` イベントをモックで流す。**実際の push は行わない**（remote は存在しないパス）
- 型検証は既存拡張と同じ手順（インストール済み pi パッケージの型定義に `paths` を通した tsconfig で `tsc --noEmit`）

## 6. 受け入れ基準

1. `timeout 120 git push` / `cd x && timeout 120 git push 2>&1 | tail -3` がブロックされる（**過去に素通りした形**）
2. `git push`（main ブランチ）／`git push origin main`／`git push origin +main`／`git push origin HEAD:main` がブロックされる
3. `git push --all` / `git push --mirror` がブロックされる（**過去に無効だった形**）
4. `git push origin --delete main` / `git push origin :main` がブロックされ、別ブランチの削除は許可される
5. `-C` の指定を尊重する: feature 側から `git -C <main のリポジトリ> push` はブロック、main 側から `git -C <feature のリポジトリ> push` は許可
   （引用符付き・エスケープ付きの空白入りパスでも同じ）
6. 引用符・エスケープ・代入・パス付きの形がすべてブロックされる:
   `sudo -u "root user" git push origin main` / `timeout "120" git push origin main` /
   `GIT_SSH_COMMAND=ssh git push origin main` / `FOO=1 git push origin main` /
   `/usr/bin/git push origin main` / `./git push origin main` /
   `git --git-dir /tmp/x/.git push origin main` / `git -c foo.bar=baz push origin main` /
   `bash -c 'git push origin "main"'`
7. `git push origin feature-x` / `git push origin "feature/x"` / feature ブランチでの `git push` は許可される
8. `echo "git push origin main"` / `git commit -m "git push"` を誤検知しない
9. 非リポジトリでの `git push` / `git push --all`（判定不能）はブロックされる
10. 非インタラクティブでは `git push --force`（保護ブランチ以外でも）をブロックする
11. `! git push origin main` / `until false; do git push origin main; done` がブロックされる
12. 行継続（`git push origin \` 改行 `main`）がブロックされる
13. `git push origin $'main'` / `bash -c "git push origin \"main\""` がブロックされる
14. `git -C <feature> -C <main> push` はブロック、`git -C <main> -C <feature> push` は許可（`-C` を順に適用）
15. パス名に `push` を含むディレクトリ（`/tmp/push-guard-…`）でも判定ディレクトリを取り違えない
16. `git push origin ma\in` / `git push origin "ma""in"` がブロックされる（エスケープ・連結クォート）
17. `git -C"<空白入りパス>" push`（密着形 + 引用符）がブロックされる
18. `echo "message; git push origin main"` / `echo "bash -c 'git push origin main'"` を誤検知しない

## 7. スコープ外

- GitHub 側の ruleset 設定（サーバ側の防御。別リポジトリのデプロイ手順で扱う）
- `git push` 以外の経路（`gh api` での ref 更新、`git send-pack`、force push を伴う `git remote` 操作）
- 保護ブランチ名の設定化（`main` / `master` 固定）
- `xargs git push` のような「引数を別コマンドから受け取る」形の完全な追跡
- シェル展開（`$(…)`、`${VAR}`、`*`）の評価 — 展開後の値を知るにはシェルを実行する必要があるため、文字列をそのまま見るだけにする
- ヒアドキュメントの中身（`<<EOF … EOF`）— クォートではなくリダイレクトなので、本文中の `git push` は境界として拾われない（実行されるが検出できない。必要になったらヒアドキュメントの解析を追加する）
- 性能: 判定ディレクトリ単位のキャッシュのみ行う（`git` の起動は高々「コマンドに現れる `-C` の種類数 × 2」）。これを超えて減らす必要が出たら、明示 ref のときは `git branch` を省く等を検討する

## 8. README

挙動の一覧は README の「`block-push-to-main.ts` — main への直接 push を禁止」節が権威。
この仕様書を更新したら、README の該当節（ブロック対象・検証コマンド・ケース数）も合わせて更新する。
