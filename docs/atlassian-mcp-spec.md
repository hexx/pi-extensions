# 仕様書：`atlassian-mcp.ts` — Atlassian Rovo MCP 拡張

**状態**: 確定（grill-with-docs セッション 2026 年合意）
**関連**: [CONTEXT.md](../CONTEXT.md)（用語集）, [ADR-0001](./adr/0001-handrolled-oauth-manual-approval.md)（認証アーキテクチャの決定）

## 1. 背景と目的

Claude Code では `claude mcp add --transport http --scope user atlassian https://mcp.atlassian.com/v1/mcp` 一発で Atlassian 公式リモート MCP サーバー（Rovo MCP サーバー。Jira / Confluence / JSM / Bitbucket / Compass の 46+ ツールを公開）が使える。pi coding agent には設計上組み込み MCP クライアントがないため、同等の体験を **pi-extensions リポジトリの単一 TypeScript ファイル**として実現する。

`--scope user`（全プロジェクト有効）の pi における対応物は `~/.pi/agent/extensions/` への配置である。

### 決定済みの基本方針（Q&A の結論）

| # | 決定 | 理由の要約 |
|---|------|-----------|
| Q1 | 既存の `pi-mcp-adapter` パッケージは使わず**自作**する | リポジトリの目的が自作拡張の集積であるため |
| Q2 | 認証は **OAuth 2.1 手動承認フロー主軸＋ API トークン併用** | ブラウザレスのコンテナ環境。API トークンは管理者有効化必須・Compass 不可の制約あり |
| Q3 | OAuth・MCP クライアントは**完全手組み・npm 依存ゼロ** | 単一ファイル・symlink 導入というリポジトリの約束事の維持 |
| Q4 | 認証情報は **JSON ファイルにプロファイルキーで複数アカウント保持** | private/work で別 Atlassian アカウントを使うため |
| Q5 | `/atlassian-login`・`/atlassian-logout`＋**初回使用時の遅延ログイントリガー** | brave 拡張の「初回使用時プロンプト」パターンとの整合 |
| Q6 | LLM への公開は**単一プロキシツール `atlassian_mcp`** のみ | 46+ ツールの直接登録は約 10k トークンのコンテキスト肥大を招く |
| Q7 | **呼び出しごとハンドシェイク**（ステートレス）、`tools/list` はセッション内キャッシュ | 堅牢性優先。遅延は人間が待つ用途では問題にならない |
| Q8 | 出力ガード **50 KiB / 2000 行**＋全文一時ファイル | pi 組み込み `bash` ガードおよび brave 拡張前例との整合 |

## 2. ファイル・命名

- **ファイル**: リポジトリルートに `atlassian-mcp.ts`（単一ファイル・無依存・Node.js 組み込みのみ使用）
- **ツール名**: `atlassian_mcp`
- **コマンド**: `/atlassian-login`, `/atlassian-logout`
- **認証情報ファイル**: `~/.pi/agent/atlassian-mcp-auth.json`（モード `0600`）
  - ホームディレクトリは永続ボリューム前提（コンテナ再起動後も生存）

## 3. 認証

### 3.1 認証方式の優先順位

ツール呼び出し・コマンド実行時は次の順で認証情報を解決する：

1. **`ATLASSIAN_MCP_AUTH`** 環境変数 — `Authorization` ヘッダの生値（`Bearer xxx` / `Basic xxx`）。最優先。
2. **`ATLASSIAN_MCP_EMAIL` ＋ `ATLASSIAN_MCP_API_TOKEN`** 環境変数 — 拡張が `Basic base64(email:api_token)` を組み立てる。
3. **認証情報ファイルの OAuth アカウント**（現在のプロファイルキー）— `expiresAt` 切れなら refresh_token で自動更新。
4. **上記いずれもなし** — 遅延ログインフローを開始（§3.2）。非 UI モード（`ctx.hasUI === false`）では開始せず、`/atlassian-login` または環境変数設定を促すエラーを返す。

### 3.2 OAuth 2.1 手動承認フロー

ブラウザのない環境で、ユーザーが別デバイスのブラウザを使って承認するフロー（RFC 8628 デバイスフローではない。認可コードフロー＋リダイレクト URL の手動貼り付けである。用語は CONTEXT.md 参照）。

**ログイン時（`/atlassian-login` または遅延トリガー）の手順:**

1. **Protected Resource Metadata 取得**（RFC 9728）: パスAwareの well-known URL を先に試す。エンドポイントが `https://mcp.atlassian.com/v1/mcp/authv2` なら `GET https://mcp.atlassian.com/.well-known/oauth-protected-resource/v1/mcp/authv2`、404 ならオリジンレベル `GET {オリジン}/.well-known/oauth-protected-resource` へフォールバック。`authorization_servers[0]` と `scopes_supported` を得る。
2. **Authorization Server Metadata 取得**（RFC 8414）: issuer がパス付き（例: `https://auth.atlassian.com/<id>`）の場合はパスAware URL `GET {オリジン}/.well-known/oauth-authorization-server{パス}`、失敗時はパスなし URL へフォールバック。`authorization_endpoint`, `token_endpoint`, `registration_endpoint` を得る。

> **実測確認（2026-07-23）**: 上記 URL はすべてライブ確認済み。注意: 素の `/v1/mcp` エンドポイントは PRM を公開していない（404）ため、OAuth 発見は `authv2` でしか機能しない。API トークン認証の場合は `/v1/mcp` を `ATLASSIAN_MCP_URL` に指定してもよい。スコープは PRM の `scopes_supported`（`offline_access` 含む）を優先し、AS メタデータ側へフォールバックする。
3. **Dynamic Client Registration**（RFC 7591）: 認証情報ファイルに保存済みのクライアント（`client.id` 等）があれば再利用。なければ `POST registration_endpoint`:
   ```json
   {
     "client_name": "pi atlassian-mcp extension",
     "redirect_uris": ["http://localhost:33418/callback"],
     "grant_types": ["authorization_code", "refresh_token"],
     "response_types": ["code"],
     "token_endpoint_auth_method": "none"
   }
   ```
   応答の `client_id`（発行されれば `client_secret`）をファイルに保存。
4. **PKCE 生成**: `code_verifier`（43〜128 文字のランダム、`node:crypto`）、`code_challenge = BASE64URL(SHA256(code_verifier))`、方式 `S256`。`state` もランダム生成し、フロー完了までメモリ（クロージャ）に保持。
5. **認可 URL を構築して表示**:
   ```
   {authorization_endpoint}?response_type=code
     &client_id={client_id}
     &redirect_uri=http://localhost:33418/callback
     &code_challenge={challenge}&code_challenge_method=S256
     &state={state}
     &scope={scopes_supported から組み立て。offline_access があれば必ず含める}
   ```
   `ctx.ui.notify(url, "info")` で表示し、直後に `ctx.ui.input("リダイレクト URL を貼り付けてください")` で待ち受ける。
6. **貼り付け値のパース**: 完全なリダイレクト URL（`http://localhost:33418/callback?code=...&state=...`）または `code` のみを受け付ける。`state` を検証（不一致はエラー）。
7. **トークン交換**: `POST token_endpoint`（`grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`, `resource={MCPエンドポイント}`（RFC 8707。サーバーが要求する場合に備え常に送る））→ `access_token`, `refresh_token`, `expires_in` を取得し、`expiresAt` を計算してファイルに保存。

**利用時**: `Authorization: Bearer {access_token}` を MCP リクエストに付与。

**401 受信時**: refresh_token で 1 回だけ更新を試み、成功すれば元のリクエストを 1 回リトライ。更新失敗時はトークンをファイルから消去し、UI があればログインフローを再開、なければエラー。

### 3.3 API トークン認証

`Authorization: Basic base64(email:api_token)` を送信するだけ。組織管理者による有効化が前提（有効化されていない場合の 401 はサーバーメッセージをそのまま返す）。JSM・Bitbucket ツールはこの方式でしか利用できない。Compass ツールは OAuth でしか利用できない（サーバー側の制約。拡張は関知しない）。

### 3.4 認証情報ファイル形式

```jsonc
// ~/.pi/agent/atlassian-mcp-auth.json  (mode 0600)
{
  "pi-private": {
    "endpoint": "https://mcp.atlassian.com/v1/mcp",
    "method": "oauth",
    "client": { "id": "...", "secret": "...", "redirectUri": "http://localhost:33418/callback" },
    "tokens": { "access": "...", "refresh": "...", "expiresAt": 1234567890123 }
  },
  "pi-work": {
    "endpoint": "https://mcp.atlassian.com/v1/mcp",
    "method": "oauth",
    "client": { "id": "..." },
    "tokens": { "...": "..." }
  }
}
```

- **キー** = `process.env.AI_ENV_PROFILE` の値。未設定時は `"default"`。
- 書き込みは常にモード `0600` を指定。既存ファイルは読み込んでマージする（他プロファイルのエントリを壊さない）。
- `/atlassian-logout` は現在のキーのエントリのみ削除。

## 4. MCP クライアント

`brave-search-pi-work.ts` の最小 MCP Streamable HTTP クライアントを流用・拡張する。

- **ハンドシェイクは呼び出しごと**: `initialize`（`protocolVersion: "2025-06-18"` を送信。サーバーが別のバージョンを返したらそれを受け入れる）→ `notifications/initialized`（通知。応答を待たない）→ `tools/list` または `tools/call`。
- **レスポンス形式**: `application/json` と `text/event-stream`（SSE）の両対応（brave の `parseSse` を流用）。
- **`Mcp-Session-Id`**: 応答ヘッダから取得し、同一論理呼び出し内の後続リクエストに付与。
- **`tools/list` キャッシュ**: モジュールレベルの `Map`（キー = プロファイル＋エンドポイント）に `{ tools, fetchedAt }` を保持。`list`/`describe` アクションはキャッシュ優先。`call` で unknown tool エラーを受けたら 1 回だけ再取得してリトライ。
- **バックグラウンドリソース禁止**: pi の拡張仕様に従い、ファクトリ関数からはソケット・タイマーを開始しない。接続はツール/コマンド呼び出し時のみ。

## 5. ツール `atlassian_mcp`

```typescript
parameters: Type.Object({
  action: StringEnum(["list", "describe", "call"] as const),
  tool: Type.Optional(Type.String()),
  args: Type.Optional(Type.Record(Type.String(), Type.Any())),
})
```

| action | 必須パラメータ | 動作 |
|--------|---------------|------|
| `list` | — | 利用可能な MCP ツールの一覧（名前＋1 行説明）を返す |
| `describe` | `tool` | 指定ツールの完全な入力スキーマを返す |
| `call` | `tool`, `args` | MCP `tools/call` を実行し結果を返す。引数は構造化オブジェクトのまま送信（検証はサーバー側） |

- `promptSnippet`: 「Atlassian（Jira/Confluence 等）の MCP ツールをプロキシ経由で呼び出す」
- `promptGuidelines`: 「`atlassian_mcp` で Jira・Confluence 等の Atlassian 操作を行う。まず `action: "list"` でツールを発見し、必要に応じて `action: "describe"` で引数を確認してから `action: "call"` する。」（pi の文書に従いツール名を明記する）
- エラーは `throw`（`isError: true` として LLM に伝わる）。

### 出力ガード

- テキスト出力が **50 KiB または 2000 行**を超えたら先頭へ切り詰める。
- 全文は一時ファイル（`node:os` の tmpdir 配下、`0600`）に保存し、結果末尾にパスを付記する（agent が `read`/`grep` できる）。
- 画像コンテンツブロックはそのまま通過させる。

## 6. コマンド

| コマンド | 動作 |
|----------|------|
| `/atlassian-login` | 現在のプロファイルの OAuth フロー（§3.2）を強制実行。既存トークンがあっても再認証する（スコープ変更・サイト切り替え用） |
| `/atlassian-logout` | 認証情報ファイルから現在のプロファイルのエントリを削除 |

## 7. 環境変数

| 変数 | 既定値 | 説明 |
|------|--------|------|
| `ATLASSIAN_MCP_URL` | `https://mcp.atlassian.com/v1/mcp/authv2` | MCP エンドポイント（OAuth 利用時は authv2 必須。API トークンのみなら `/v1/mcp` も可） |
| `ATLASSIAN_MCP_AUTH` | （なし） | `Authorization` ヘッダ生値。最優先 |
| `ATLASSIAN_MCP_EMAIL` | （なし） | API トークン認証のメールアドレス |
| `ATLASSIAN_MCP_API_TOKEN` | （なし） | API トークン |
| `AI_ENV_PROFILE` | `default` | アカウントキー（`pi-private` / `pi-work`） |

**プロファイル gating はしない**。拡張は両プロファイルで有効。アクティブなアカウントは `AI_ENV_PROFILE` で決まる。

## 8. 受け入れ基準

1. 初期状態（環境変数なし・認証ファイルなし）で `atlassian_mcp` を呼ぶと、ログインフロー（認可 URL 表示→貼り付け→トークン保存）が始まり、承認後に呼び出しが成功する。
2. pi 再起動後は再認証不要（トークン永続化＋自動リフレッシュ）。
3. `AI_ENV_PROFILE=pi-private` と `pi-work` で別アカウントが使われ、互いを上書きしない。
4. `ATLASSIAN_MCP_EMAIL`＋`ATLASSIAN_MCP_API_TOKEN` 設定時は OAuth フローなしで Basic 認証で動作する。
5. `/atlassian-logout` 後の次回呼び出しでログインフローが再開する。
6. 巨大な Confluence ページ取得結果は切り詰められ、一時ファイルパスが付く。
7. JSON 応答・SSE 応答の両方で動作する。
8. 非 UI モード（`pi -p` 等）で未認証の場合、ログインフローを開かず明確なエラーを返す。

## 9. v1 スコープ外

- MCP ツールの個別 pi ツール化（直接登録）— `pi.registerTool` は動的呼び出し可能なため、不満が見えてから後付けする
- MCP resources / prompts / sampling / elicitation（ツールのみ対応）
- 自動ブラウザ起動（設計上しない）
- pi パッケージ（npm/git）としての公開 — 単一ファイル配布のまま

## 10. README 追加セクション（実装時に転記する草案）

```markdown
### `atlassian-mcp.ts` — Atlassian Rovo MCP クライアント（Jira / Confluence 等）

Atlassian 公式リモート MCP サーバー（Rovo MCP サーバー）へ接続し、46+ の MCP ツールを単一のプロキシツール `atlassian_mcp` 経由で LLM に公開します。pi には組み込み MCP クライアントがないため、MCP Streamable HTTP クライアントと OAuth 2.1 クライアントを本拡張内で手組みしています（npm 依存なし）。Claude Code の `claude mcp add --transport http --scope user atlassian https://mcp.atlassian.com/v1/mcp` と同等の構成の pi 版です。

- **エンドポイント**: `https://mcp.atlassian.com/v1/mcp/authv2`（環境変数 `ATLASSIAN_MCP_URL` で上書き可。OAuth は authv2 必須、API トークンのみなら `/v1/mcp` も可）
- **認証**（優先順）:
  1. `ATLASSIAN_MCP_AUTH`（`Authorization` ヘッダ生値）
  2. `ATLASSIAN_MCP_EMAIL` ＋ `ATLASSIAN_MCP_API_TOKEN`（Basic 認証）
  3. OAuth 2.1 手動承認フロー（`/atlassian-login`。ブラウザで認可 URL を開き、リダイレクト URL を貼り付け）
- **認証情報**: `~/.pi/agent/atlassian-mcp-auth.json`（0600）に `AI_ENV_PROFILE`（`pi-private` / `pi-work`）キーでアカウント別に保存。private/work で別アカウントが使えます。
- **コマンド**: `/atlassian-login`（再認証）, `/atlassian-logout`（アカウント情報削除）
- **ツール仕様**:
  - `atlassian_mcp`
    - `action` ("list" | "describe" | "call", 必須): list=ツール一覧 / describe=ツール詳細 / call=実行
    - `tool` (string, describe/call で必須): MCP ツール名
    - `args` (object, call で必須): ツール引数
- **備考**: 呼び出しごとにハンドシェイクするステートレス設計。`tools/list` はセッション内でキャッシュ。50 KiB / 2000 行を超える結果は切り詰め、全文を一時ファイルに保存してパスを付与します。
```
