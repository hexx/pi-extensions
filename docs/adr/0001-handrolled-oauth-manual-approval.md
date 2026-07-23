# 手組みの OAuth 2.1 手動承認フローと API トークン併用（無依存）

ブラウザのないコンテナ環境で Rovo MCP サーバーに接続するため、認証は OAuth 2.1 の手動承認フロー（認可 URL を提示 → 別デバイスで同意 → リダイレクト URL を貼り付け）を主軸とし、API トークン（Basic 認証）を環境変数経由で併用する。OAuth・MCP クライアントとも npm パッケージ（`@modelcontextprotocol/sdk` や `mcp-remote`）に頼らず、拡張ファイル内で手組みする。

OAuth を主軸にするのは、API トークン方式が組織管理者の有効化を要し Compass ツールに使えないため。手動承認フローを選ぶのは、実行環境にブラウザがなく通常の OAuth リダイレクトが成立しないため（RFC 8628 デバイスフローは Atlassian 非対応かつ別仕組みなので不採用）。手組みにするのは、リポジトリの「単一ファイル・無依存・symlink 導入」という約束事を守るため。

## Considered Options

- `@modelcontextprotocol/sdk` の `auth()` — 枯れた実装だが、リポジトリ初の npm 依存となり単一ファイル導入が崩れる
- `mcp-remote` サブプロセス — Atlassian 公式推奨だが、実装の所有権が失われ手動承認の連携が不格好
- API トークン単体 — 実装は最小だが管理者有効化が必須で Compass 不可。フォールバックとしてのみ採用

## Consequences

- MCP 認証仕様の進化（resource indicators 等）への追従は手作業になる。Atlassian 固有の癖で手組み OAuth が成立しない場合は SDK 採用を再検討する（後戻りは容易）
- トークン・クライアント登録情報の安全な永続化先が別途必要（→ 後続の決定事項）
