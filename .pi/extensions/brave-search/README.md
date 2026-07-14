# Brave Search extension for pi coding agent

pi 用の Web 検索拡張機能です。Codex 向けに提供されている「Brave Search MCP Server」
（LiteLLM 上の MCP サーバー）と同じエンドポイントを、pi のカスタムツールとして
利用できるようにします。pi には組み込みの MCP クライアントがないため、本拡張機能内で
最小限の MCP Streamable HTTP クライアントを実装し、`brave_search` ツールを登録しています。

## セットアップ

1. 利用者の環境で `LLM_API_KEY` に自身の LiteLLM API Key を設定します。

   ```bash
   export LLM_API_KEY="your-litellm-api-key"
   ```

2. このディレクトリを pi の拡張機能として配置します（いずれか）。

   - プロジェクトローカル（推奨）: `.pi/extensions/brave-search/index.ts`
   - グローバル: `~/.pi/agent/extensions/brave-search/index.ts`

   プロジェクトローカル配置の場合は、プロジェクトを信頼（trust）すると自動で読み込まれます。

## 動作確認

拡張機能を単体で読み込むには `-e` フラグを使います。

```bash
pi -e .pi/extensions/brave-search/index.ts
```

セッション内で LLM に「Brave Search で <キーワード> を検索して」のように依頼すると、
`brave_search` ツールが呼び出され、Web 検索結果がコンテキストに取り込まれます。

変更をホットリロードするには `/reload` を実行してください。

## 設定可能な環境変数

| 変数 | 既定値 | 説明 |
|------|--------|------|
| `LLM_API_KEY` | （なし） | LiteLLM API Key。`x-litellm-api-key: Bearer <キー>` として送信される。未設定の場合はツール実行時に入力を求められます。 |
| `BRAVE_SEARCH_MCP_URL` | `https://api.llm-gateway.kurisu.nico/brave_search/mcp` | Brave Search MCP サーバーのエンドポイント URL。 |

## 認証について

Codex 向けドキュメントと同様に、リクエストヘッダ `x-litellm-api-key` に
`Bearer ${LLM_API_KEY}` を設定して送信します（互換性のため `Authorization` ヘッダも
同様に付与します）。

## ツール仕様

- 名前: `brave_search`
- 引数:
  - `query` (string, 必須): 検索クエリ
  - `count` (integer, 任意, 1–20, 既定 5): 取得する結果数

各呼び出しで `initialize → notifications/initialized → tools/list → tools/call`
の JSON-RPC ハンドシェイクを実行します。
