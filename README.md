# pi-extensions

hexx が作成・管理している [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 用の拡張機能（extension）の集まりです。各拡張機能はトップディレクトリに単一の TypeScript ファイルとして置かれています。

## インストール方法

### 1. グローバルに導入（すべてのプロジェクトで有効）

リポジトリをクローンし、利用したい拡張機能の `.ts` ファイルを `~/.pi/agent/extensions/` へコピー（またはシンボリックリンク）します。

```bash
git clone https://github.com/hexx/pi-extensions.git
ln -s "$(pwd)/pi-extensions/brave-search-pi-work.ts" ~/.pi/agent/extensions/brave-search-pi-work.ts
```

### 2. プロジェクトローカルに導入

プロジェクトの `.pi/extensions/` ディレクトリに `.ts` ファイルをコピーします。プロジェクトを信頼（trust）すると自動で読み込まれます。

```bash
mkdir -p .pi/extensions
cp brave-search-pi-work.ts .pi/extensions/
```

### 3. `pi install` でパッケージとして導入

git / npm パッケージとして公開する場合は `pi install` を使用できます（詳細は pi のドキュメント `packages.md` を参照）。

```bash
pi install git:github.com/hexx/pi-extensions@main
```

あるいは、 `~/.pi/agent/settings.json`（またはプロジェクトの `.pi/settings.json`）の `extensions` 配列にファイルの絶対パスを追加しても読み込まれます。

```json
{
  "extensions": [
    "/abs/path/to/pi-extensions/brave-search-pi-work.ts"
  ]
}
```

### 動作確認

特定の拡張機能だけを試すには `-e` フラグを使います。

```bash
pi -e ./brave-search-pi-work.ts
```

変更を反映するには `/reload` を実行してください。拡張機能は jiti によってそのまま TypeScript として読み込まれるため、コンパイルは不要です。

## 拡張機能一覧

### `brave-search-pi-work.ts` — Brave Search 検索ツール（pi-work プロファイル専用 / MCP ゲートウェイ版）

環境変数 `AI_ENV_PROFILE` が `pi-work` の場合のみ、pi から Web 検索（Brave Search）を呼び出せる `brave_search` ツールを登録します（それ以外のプロファイルではツールを登録せず早期リターン）。pi には組み込みの MCP クライアントがないため、本拡張機能内で最小限の MCP Streamable HTTP クライアントを実装し、LiteLLM 上の Brave Search MCP サーバーへ接続します。

- **エンドポイント**: `https://api.llm-gateway.kurisu.nico/brave_search/mcp`（環境変数 `BRAVE_SEARCH_MCP_URL` で上書き可）
- **認証**: 環境変数 `LLM_API_KEY` から `x-litellm-api-key: Bearer <キー>` ヘッダを送信（Codex 向け設定と同一）。互換性のため `Authorization` ヘッダも同様に付与します。未設定の場合はツール実行時に `ctx.ui.input` で入力を促します。
- **環境変数**:
  | 変数 | 既定値 | 説明 |
  |------|--------|------|
  | `LLM_API_KEY` | （なし） | LiteLLM API Key。未設定の場合はツール実行時に入力を求められます。 |
  | `BRAVE_SEARCH_MCP_URL` | `https://api.llm-gateway.kurisu.nico/brave_search/mcp` | Brave Search MCP サーバーのエンドポイント URL。 |
- **ツール仕様**:
  - `brave_search`
    - `query` (string, 必須): 検索クエリ
    - `count` (integer, 任意, 1–20, 既定 5): 取得する結果数
- **備考**: 各呼び出しで `initialize → notifications/initialized → tools/list → tools/call` の JSON-RPC ハンドシェイクを実行し、JSON 応答と SSE 応答の両方に対応します。

### `brave-search-pi-private.ts` — Web Search / LLM Context ツール（pi-private プロファイル専用 / 直接 Brave API 版）

MCP ゲートウェイを経由せず、Brave Search API を直接呼び出す拡張機能です。環境変数 `AI_ENV_PROFILE` が `pi-private` の場合のみ `web_search` と `llm_context` の 2 つのツールを登録します。既存の `brave-search-pi-work.ts`（MCP ゲートウェイ版）とは異なるアプローチのため、同居してもツール名が重複しません。

- **エンドポイント**: `https://api.search.brave.com/res/v1`（環境変数で上書き不可）
- **認証**: 環境変数 `BRAVE_SEARCH_API_KEY` を `X-Subscription-Token` ヘッダで送信（未設定の場合はツール実行時にエラー）。
- **ツール仕様**:
  - `web_search` : ウェブ検索の一覧（タイトル・URL・スニペット・freshness/result-type フィルタ）。ソースを*発見*したいときに使用。
    - `q` (string, 必須), `count` (integer, 任意, 1–20, 既定 10), `country`, `search_lang`, `safesearch`, `freshness`, `result_filter`, `goggles`
  - `llm_context` : Brave LLM Context API 経由で取得したページの抽出済みコンテンツ（テキスト・表・コード）を RAG/グラウンディング用途で返す。ウェブ内容を*読む*ときに使用。
    - `q` (string, 必須), `count` (integer, 任意, 1–50, 既定 20), `maximum_number_of_urls` (任意, 1–50, 既定 20), `maximum_number_of_tokens` (任意, 1024–32768, 既定 8192), `country`, `search_lang`, `context_threshold_mode`, `goggles`
- **備考**: 出力は `truncateHead` でバイト/行数バジェットに切り詰められ、切り詰められた場合は全文を一時ファイルに保存したパスを結果に付与します。

### `block-push-to-main.ts` — main への直接 push を禁止

GitHub の `main` / `master` ブランチへの直接 push および削除を禁止する拡張機能です。`git push` コマンドをインターセプトし、対象 ref が保護ブランチの場合にブロックします。

- `git push origin main` などの直接 push をブロック
- `git push --force` / `--force-with-lease` も検知
- `git push origin --delete main` などの削除をブロック
- `git push --all` / `--mirror` は全ブランチ（main 含む）をチェック
- カレントブランチが main/master の場合の `git push`（引数なし）もブロック
- 別ブランチ宛ての push / 削除は許可
