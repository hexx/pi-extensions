# pi-extensions

hexx が作成・管理している pi coding agent 用の拡張機能群の文脈。各拡張はトップディレクトリの単一 TypeScript ファイルとして実装され、フッター・ツール・コマンドなどの pi の拡張ポイントを利用する。

## Reasoning トークン表示拡張

### Language

**Reasoning トークン**:
プロバイダが `usage.reasoning` として報告する思考（推論）トークン数。`output` の内数。OpenAI 系は `completion_tokens_details.reasoning_tokens`、Anthropic は thinking ブロックから算出する。非対応プロバイダでは `undefined` になり得る。
_Avoid_: 思考トークン（同じ意味だが API の用語は reasoning tokens）、推論コスト（本拡張はトークン数のみ表示し、コストは扱わない）

**今ターン Reasoning**:
直近のターン（1回の LLM 応答＋ツール実行のまとまり）で消費された Reasoning トークン数。ターン内の各アシスタントメッセージの `usage.reasoning` を合算する。ストリーミング中はプロバイダの usage がストリーム末尾まで届かないため、確定はターン終了後。
_Avoid_: ターン合計（出力トークンなど Reasoning 以外も含む一般的な語）

**セッション累計 Reasoning**:
セッション全体（コンパクション後のブランチサマリも含む）で消費された Reasoning トークンの累計。`session_start` 時に全エントリをリプレイして再集計し、`/new` で 0 にリセットされる。

**拡張ステータス行**:
フッターの 3 行目。`ctx.ui.setStatus(key, text)` で拡張が常時表示できる領域。複数拡張がキー名のアルファベット順で並ぶ。ビルトインフッター（pwd・トークン統計・context 使用率）とは別に存在する。
_Avoid_: カスタムフッター（`setFooter` でビルトインフッター全体を置換する方式。本拡張では採用しない）

## Atlassian MCP 拡張

pi coding agent から Atlassian Rovo MCP サーバー（Jira / Confluence 等）を使うための拡張機能に関する文脈。pi には組み込み MCP クライアントがないため、拡張機能内で MCP クライアントと OAuth を実装する。

### Language

**Rovo MCP サーバー**:
Atlassian 公式のリモート MCP サーバー（`https://mcp.atlassian.com/v1/mcp`）。Jira・Confluence・JSM・Bitbucket・Compass を MCP ツールとして公開する。
_Avoid_: Atlassian MCP（コミュニティ製の別サーバー mcp-atlassian と曖昧）

**手動承認フロー**:
OAuth 2.1 認可コードフローのうち、ブラウザ非表示環境向けの運用。pi が認可 URL を提示し、ユーザーが別デバイスのブラウザで同意し、リダイレクト URL（`code` と `state` を含む）を pi に貼り付けて完了する。PKCE 必須。
_Avoid_: デバイスフロー（RFC 8628 の別仕組み。ポーリング方式で、本拡張は使わない）, OOB フロー（OAuth 2.1 で廃止済み）

**アカウント**:
Rovo MCP サーバーへの接続に必要な認証情報の一式（DCR クライアント登録情報＋OAuth トークン類、または API トークン）。プロファイル（`AI_ENV_PROFILE` の値 `pi-private` / `pi-work`）をキーに 1:1 で対応し、認証情報ファイル内で区切って保持される。
_Avoid_: プロファイル（コンテナの起動モードを指し、アカウントと 1:1 ではあるが別概念）, サイト（Atlassian Cloud のテナント。アカウントがアクセス先のサイトを決める）

**プロキシツール**:
本拡張が登録する唯一の pi ツール `atlassian_mcp`。MCP サーバーの全ツールを `list` / `describe` / `call` の 3 アクションで仲介し、システムプロンプトのコストを約 200 トークンに抑える。v1 では MCP ツールを個別の pi ツールとして登録する「直接登録」は採用しない（不満が見えたら後付け可能）。
_Avoid_: パススルーツール, ゲートウェイ（リポジトリ内の brave 拡張は LiteLLM ゲートウェイを指してそう呼ぶため混同注意）

**API トークン認証**:
Atlassian のヘッドレス認証方式。`Authorization: Basic base64(email:api_token)` ヘッダで認証する。組織管理者の有効化が必要。JSM・Bitbucket ツールはこの方式専用。
_Avoid_: ヘッドレス認証（OAuth の手動承認もヘッドレスで使えるため曖昧）
