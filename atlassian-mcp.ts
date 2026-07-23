/**
 * Atlassian Rovo MCP 拡張 for pi coding agent.
 *
 * Claude Code の `claude mcp add --transport http --scope user atlassian
 * https://mcp.atlassian.com/v1/mcp` と同等の構成を pi で実現する。pi には
 * 組み込み MCP クライアントがないため、MCP Streamable HTTP クライアントと
 * OAuth 2.1 クライアント（手動承認フロー）を本ファイル内で手組みする。
 * npm 依存なし（Node.js 組み込みのみ）。
 *
 * 設計: docs/atlassian-mcp-spec.md / CONTEXT.md / docs/adr/0001 を参照。
 *
 * - 認証優先順位: ATLASSIAN_MCP_AUTH > ATLASSIAN_MCP_EMAIL+ATLASSIAN_MCP_API_TOKEN
 *   > 認証ファイルの OAuth アカウント > 遅延ログインフロー
 * - LLM へは単一プロキシツール `atlassian_mcp` (list/describe/call) のみ公開
 * - 呼び出しごとハンドシェイクのステートレス設計 (tools/list はセッション内キャッシュ)
 * - 認証情報は ~/.pi/agent/atlassian-mcp-auth.json (0600) に AI_ENV_PROFILE キーで保持
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** ----------------------------------------------------------------------- *
 * 定数
 * ----------------------------------------------------------------------- */

const DEFAULT_ENDPOINT = "https://mcp.atlassian.com/v1/mcp/authv2";
const REDIRECT_URI = "http://localhost:33418/callback";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const GUARD_MAX_BYTES = 50 * 1024;
const GUARD_MAX_LINES = 2000;
const EXPIRY_MARGIN_MS = 60_000;

/** ----------------------------------------------------------------------- *
 * 環境・アカウント
 * ----------------------------------------------------------------------- */

function endpoint(): string {
	return process.env.ATLASSIAN_MCP_URL ?? DEFAULT_ENDPOINT;
}

/** 認証情報ファイルのアカウントキー。プロファイル (AI_ENV_PROFILE) ごとにアカウントを分ける。 */
function accountKey(): string {
	return process.env.AI_ENV_PROFILE ?? "default";
}

function authFilePath(): string {
	return join(homedir(), CONFIG_DIR_NAME, "agent", "atlassian-mcp-auth.json");
}

interface OAuthTokens {
	access: string;
	refresh?: string;
	expiresAt: number;
}

interface AccountEntry {
	endpoint: string;
	method: "oauth";
	client?: { id: string; secret?: string; redirectUri: string };
	tokens?: OAuthTokens;
}

type AuthFile = Record<string, AccountEntry>;

async function loadAuthFile(): Promise<AuthFile> {
	try {
		return JSON.parse(await readFile(authFilePath(), "utf8")) as AuthFile;
	} catch {
		return {};
	}
}

async function saveAccount(key: string, entry: AccountEntry): Promise<void> {
	const file = await loadAuthFile();
	file[key] = entry;
	await writeAuthFileAtomic(file);
}

async function removeAccount(key: string): Promise<boolean> {
	const file = await loadAuthFile();
	if (!(key in file)) return false;
	delete file[key];
	await writeAuthFileAtomic(file);
	return true;
}

/** 認証情報ファイルをアトミックに書き込む（tmp へ書いて rename）。 */
async function writeAuthFileAtomic(file: AuthFile): Promise<void> {
	const path = authFilePath();
	await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
	await chmod(tmp, 0o600); // writeFile の mode は作成時のみ有効なため明示的に
	await rename(tmp, path);
}

/** ----------------------------------------------------------------------- *
 * OAuth 2.1 ユーティリティ
 * ----------------------------------------------------------------------- */

function base64url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkce(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(32)); // 43 文字
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

interface OAuthMetadata {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
	scopesSupported?: string[];
}

/** RFC 9728 (Protected Resource Metadata) → RFC 8414 (AS Metadata) を辿る。
 *
 * 実測 (2026-07): `/v1/mcp/authv2` はパス付き well-known URL
 * (`/.well-known/oauth-protected-resource/v1/mcp/authv2`) でメタデータを公開し、
 * authorization_servers にはパス付き issuer (`https://auth.atlassian.com/<id>`) が返る。
 * そのため PRM・AS メタデータともパスAware形式を先に試し、オリジン形式へフォールバックする。 */
async function discoverOAuth(ep: string, signal?: AbortSignal): Promise<OAuthMetadata> {
	const resourceUrl = new URL(ep);
	const origin = resourceUrl.origin;

	let authServer = origin;
	let prmScopes: string[] | undefined;
	const prmCandidates =
		resourceUrl.pathname && resourceUrl.pathname !== "/"
			? [
					`${origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`,
					`${origin}/.well-known/oauth-protected-resource`,
				]
			: [`${origin}/.well-known/oauth-protected-resource`];
	for (const candidate of prmCandidates) {
		try {
			const res = await fetch(candidate, { signal });
			if (!res.ok) continue;
			const data = (await res.json()) as {
				authorization_servers?: string[];
				scopes_supported?: string[];
			};
			if (data.authorization_servers?.[0]) {
				authServer = data.authorization_servers[0].replace(/\/+$/, "");
				prmScopes = data.scopes_supported;
				break;
			}
		} catch {
			// 次の候補を試す
		}
	}

	// RFC 8414: パス付き issuer にはパスAware well-known URL で問い合わせる
	const asUrl = new URL(authServer);
	const asCandidates =
		asUrl.pathname && asUrl.pathname !== "/"
			? [
					`${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname}`,
					`${asUrl.origin}/.well-known/oauth-authorization-server`,
				]
			: [`${asUrl.origin}/.well-known/oauth-authorization-server`];
	let md:
		| {
				authorization_endpoint?: string;
				token_endpoint?: string;
				registration_endpoint?: string;
				scopes_supported?: string[];
			}
		| undefined;
	for (const candidate of asCandidates) {
		try {
			const res = await fetch(candidate, { signal });
			if (!res.ok) continue;
			const data = (await res.json()) as typeof md;
			if (data?.authorization_endpoint && data?.token_endpoint) {
				md = data;
				break;
			}
		} catch {
			// 次の候補を試す
		}
	}
	if (!md?.authorization_endpoint || !md?.token_endpoint) {
		throw new Error(`OAuth メタデータの取得に失敗しました (AS: ${authServer})`);
	}
	return {
		authorizationEndpoint: md.authorization_endpoint,
		tokenEndpoint: md.token_endpoint,
		registrationEndpoint: md.registration_endpoint,
		// リソース固有のスコープ (PRM) を優先する
		scopesSupported: prmScopes ?? md.scopes_supported,
	};
}

/** Dynamic Client Registration (RFC 7591)。 */
async function registerClient(
	registrationEndpoint: string,
	signal?: AbortSignal,
): Promise<{ id: string; secret?: string }> {
	const res = await fetch(registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: "pi atlassian-mcp extension",
			redirect_uris: [REDIRECT_URI],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
		signal,
	});
	if (!res.ok) {
		// レスポンスボディは機密を含む可能性があるためエラーに含めない
		throw new Error(`Dynamic Client Registration に失敗しました (HTTP ${res.status})`);
	}
	const data = (await res.json()) as {
		client_id: string;
		client_secret?: string;
		token_endpoint_auth_method?: string;
	};
	// public client (PKCE) の場合は secret を送らない
	const secret = data.token_endpoint_auth_method === "none" ? undefined : data.client_secret;
	return { id: data.client_id, secret };
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}

async function tokenRequest(
	tokenEndpoint: string,
	params: Record<string, string>,
	clientSecret: string | undefined,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	const body = new URLSearchParams(params);
	if (clientSecret) body.set("client_secret", clientSecret);
	const res = await fetch(tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		signal,
	});
	const text = await res.text();
	if (!res.ok) {
		// レスポンスボディはトークン類を含む可能性があるためエラーに含めない
		throw new Error(`トークンエンドポイントエラー (HTTP ${res.status})`);
	}
	try {
		return JSON.parse(text) as TokenResponse;
	} catch {
		throw new Error(`トークンエンドポイントが不正なレスポンスを返しました (HTTP ${res.status})`);
	}
}

function toOAuthTokens(tok: TokenResponse): OAuthTokens {
	return {
		access: tok.access_token,
		refresh: tok.refresh_token,
		expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
	};
}

/** refresh_token による更新。失敗時は undefined を返す（例外を投げない）。 */
async function tryRefreshTokens(
	key: string,
	entry: AccountEntry,
	signal?: AbortSignal,
): Promise<OAuthTokens | undefined> {
	if (!entry.tokens?.refresh || !entry.client) return undefined;
	try {
		const md = await discoverOAuth(entry.endpoint, signal);
		const tok = await tokenRequest(
			md.tokenEndpoint,
			{
				grant_type: "refresh_token",
				refresh_token: entry.tokens.refresh,
				client_id: entry.client.id,
				resource: entry.endpoint, // RFC 8707
			},
			entry.client.secret,
			signal,
		);
		const tokens: OAuthTokens = {
			...toOAuthTokens(tok),
			// 更新レスポンスに refresh_token がない場合は既存を引き継ぐ
			refresh: tok.refresh_token ?? entry.tokens.refresh,
		};
		await saveAccount(key, { ...entry, tokens });
		return tokens;
	} catch {
		return undefined;
	}
}

/** ----------------------------------------------------------------------- *
 * 手動承認フロー（URL 提示 → 別ブラウザで承認 → リダイレクト URL 貼り付け）
 * ----------------------------------------------------------------------- */

interface LoginUI {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	input(message: string, initial?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

function extractCode(pasted: string, expectedState: string): string {
	const trimmed = pasted.trim();
	// state 検証を必須とするため、完全なリダイレクト URL のみ受け付ける
	if (!/^https?:\/\//i.test(trimmed)) {
		throw new Error("リダイレクト先の完全な URL を貼り付けてください（アドレスバー全体をコピー）");
	}
	const url = new URL(trimmed);
	const error = url.searchParams.get("error");
	if (error) {
		const desc = url.searchParams.get("error_description");
		throw new Error(`認証が拒否されました: ${error}${desc ? ` (${desc})` : ""}`);
	}
	const state = url.searchParams.get("state");
	if (!state || state !== expectedState) {
		throw new Error("state が一致しません（CSRF の可能性があります）");
	}
	const code = url.searchParams.get("code");
	if (!code) throw new Error("貼り付けられた URL に code が含まれていません");
	return code;
}

async function runLoginFlow(ui: LoginUI, signal?: AbortSignal): Promise<AccountEntry> {
	const key = accountKey();
	const ep = endpoint();
	const existing = (await loadAuthFile())[key];

	const md = await discoverOAuth(ep, signal);

	let client = existing?.client;
	if (!client) {
		if (!md.registrationEndpoint) {
			throw new Error("registration_endpoint が見つからず、クライアント登録ができません");
		}
		const reg = await registerClient(md.registrationEndpoint, signal);
		client = { id: reg.id, secret: reg.secret, redirectUri: REDIRECT_URI };
	}

	const { verifier, challenge } = generatePkce();
	const state = base64url(randomBytes(16));

	const url = new URL(md.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", client.id);
	url.searchParams.set("redirect_uri", client.redirectUri);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	if (md.scopesSupported?.length) {
		url.searchParams.set("scope", md.scopesSupported.join(" "));
	}

	ui.notify(
		"Atlassian 認証: 以下の URL をブラウザで開いて承認し、リダイレクト先の URL（アドレスバー全体）を貼り付けてください。",
		"info",
	);
	ui.notify(url.toString(), "info");

	const pasted = await ui.input("リダイレクト URL（または code）を貼り付け:", undefined, { signal });
	if (!pasted?.trim()) throw new Error("入力がなかったためログインを中止しました");

	const code = extractCode(pasted, state);
	const tok = await tokenRequest(
		md.tokenEndpoint,
		{
			grant_type: "authorization_code",
			code,
			redirect_uri: client.redirectUri,
			client_id: client.id,
			code_verifier: verifier,
			resource: ep, // RFC 8707
		},
		client.secret,
		signal,
	);

	const entry: AccountEntry = { endpoint: ep, method: "oauth", client, tokens: toOAuthTokens(tok) };
	await saveAccount(key, entry);
	return entry;
}

/** ----------------------------------------------------------------------- *
 * 認証解決
 * ----------------------------------------------------------------------- */

interface ResolvedAuth {
	header: string;
	source: "env" | "oauth-file";
}

interface AuthContext {
	hasUI: boolean;
	ui: LoginUI;
}

async function resolveAuth(ctx: AuthContext, signal?: AbortSignal): Promise<ResolvedAuth> {
	const raw = process.env.ATLASSIAN_MCP_AUTH;
	if (raw) return { header: raw, source: "env" };

	const email = process.env.ATLASSIAN_MCP_EMAIL;
	const apiToken = process.env.ATLASSIAN_MCP_API_TOKEN;
	if (email && apiToken) {
		return {
			header: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
			source: "env",
		};
	}

	const key = accountKey();
	const entry = (await loadAuthFile())[key];
	if (entry?.tokens) {
		if (entry.tokens.expiresAt > Date.now() + EXPIRY_MARGIN_MS) {
			return { header: `Bearer ${entry.tokens.access}`, source: "oauth-file" };
		}
		const refreshed = await tryRefreshTokens(key, entry, signal);
		if (refreshed) return { header: `Bearer ${refreshed.access}`, source: "oauth-file" };
		// 更新失敗 → ログインフローへ落ちる
	}

	if (!ctx.hasUI) {
		throw new Error(
			"Atlassian の認証情報がありません。ATLASSIAN_MCP_AUTH または ATLASSIAN_MCP_EMAIL+ATLASSIAN_MCP_API_TOKEN " +
				"を設定するか、インタラクティブセッションで /atlassian-login を実行してください。",
		);
	}
	const newEntry = await runLoginFlow(ctx.ui, signal);
	if (!newEntry.tokens) throw new Error("ログインは完了しましたがトークンが取得できませんでした");
	return { header: `Bearer ${newEntry.tokens.access}`, source: "oauth-file" };
}

/** 401 時にトークン更新→再ログインを挟んで 1 回リトライする。 */
async function withAuthRetry<T>(
	ctx: AuthContext,
	signal: AbortSignal | undefined,
	fn: (authHeader: string) => Promise<T>,
): Promise<T> {
	let auth = await resolveAuth(ctx, signal);
	try {
		return await fn(auth.header);
	} catch (err) {
		if (!(err instanceof McpHttpError) || err.status !== 401 || auth.source !== "oauth-file") {
			throw err;
		}
		const key = accountKey();
		const entry = (await loadAuthFile())[key];
		if (entry) {
			const refreshed = await tryRefreshTokens(key, entry, signal);
			if (refreshed) {
				try {
					return await fn(`Bearer ${refreshed.access}`);
				} catch (err2) {
					if (!(err2 instanceof McpHttpError) || err2.status !== 401) throw err2;
				}
			}
			// トークンを破棄して再ログインへ
			await removeAccount(key);
		}
		if (!ctx.hasUI) {
			throw new Error("Atlassian 認証が切れました (HTTP 401)。/atlassian-login を実行してください。");
		}
		const newEntry = await runLoginFlow(ctx.ui, signal);
		if (!newEntry.tokens) throw new Error("再ログインでトークンを取得できませんでした");
		return await fn(`Bearer ${newEntry.tokens.access}`);
	}
}

/** ----------------------------------------------------------------------- *
 * 最小 MCP Streamable HTTP クライアント (brave-search-pi-work.ts の流用)
 * ----------------------------------------------------------------------- */

class McpHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "McpHttpError";
	}
}

/** `text/event-stream` ボディを JSON-RPC オブジェクトの配列へパースする。 */
function parseSse(text: string): Record<string, unknown>[] {
	const events: Record<string, unknown>[] = [];
	let data = "";
	const flush = () => {
		if (!data) return;
		try {
			events.push(JSON.parse(data));
		} catch {
			// 不正な SSE チャンクは無視
		}
		data = "";
	};
	for (const line of text.split("\n")) {
		if (line.startsWith("data:")) {
			// SSE 仕様: 複数の data フィールドは LF で連結する
			data += line.slice(5).replace(/^\s+/, "") + "\n";
		} else if (line.trim() === "") {
			flush();
		}
	}
	flush();
	return events;
}

interface McpOutcome {
	result?: unknown;
	sessionId: string | null;
}

async function mcpRequest(
	body: Record<string, unknown>,
	authHeader: string,
	sessionId: string | null,
	signal?: AbortSignal,
): Promise<McpOutcome> {
	const ep = endpoint();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		Authorization: authHeader,
		"MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
	};
	if (sessionId) headers["Mcp-Session-Id"] = sessionId;

	const res = await fetch(ep, { method: "POST", headers, body: JSON.stringify(body), signal });
	const newSessionId = res.headers.get("mcp-session-id") ?? sessionId;
	const contentType = res.headers.get("content-type") ?? "";
	const text = await res.text();

	if (res.status < 200 || res.status >= 300) {
		// レスポンスボディは機密を含む可能性があるためエラーに含めない
		throw new McpHttpError(res.status, `MCP リクエスト失敗 (HTTP ${res.status})`);
	}

	let parsed: Record<string, unknown> | undefined;
	if (contentType.includes("text/event-stream")) {
		const events = parseSse(text);
		parsed =
			body.id !== undefined
				? (events.find((e) => e && e.id === body.id) ?? events[events.length - 1])
				: events[events.length - 1];
	} else if (text.trim()) {
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
	}

	if (parsed?.error) {
		const err = parsed.error as { code?: number; message?: string };
		throw new Error(`MCP error ${err.code ?? "?"}: ${err.message ?? "unknown"}`);
	}
	return { result: parsed?.result, sessionId: newSessionId };
}

/** JSON-RPC 通知（id なし・応答待ちなし・ベストエフォート）。 */
async function mcpNotify(
	method: string,
	authHeader: string,
	sessionId: string | null,
	signal?: AbortSignal,
): Promise<string | null> {
	const ep = endpoint();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		Authorization: authHeader,
		"MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
	};
	if (sessionId) headers["Mcp-Session-Id"] = sessionId;
	try {
		const res = await fetch(ep, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", method }),
			signal,
		});
		return res.headers.get("mcp-session-id") ?? sessionId;
	} catch {
		return sessionId;
	}
}

/** initialize → initialized のハンドシェイクを行い、セッション ID を返す。 */
async function handshake(authHeader: string, signal?: AbortSignal): Promise<string | null> {
	const { sessionId } = await mcpRequest(
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-atlassian-mcp", version: "1.0.0" },
			},
		},
		authHeader,
		null,
		signal,
	);
	return await mcpNotify("notifications/initialized", authHeader, sessionId, signal);
}

/** ----------------------------------------------------------------------- *
 * tools/list キャッシュ
 * ----------------------------------------------------------------------- */

interface McpToolMeta {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

const toolsCache = new Map<string, { tools: McpToolMeta[]; fetchedAt: number }>();

function cacheKey(): string {
	return `${accountKey()}|${endpoint()}`;
}

async function fetchToolsList(authHeader: string, signal?: AbortSignal): Promise<McpToolMeta[]> {
	const sessionId = await handshake(authHeader, signal);
	const res = await mcpRequest(
		{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
		authHeader,
		sessionId,
		signal,
	);
	const result = res.result as { tools?: McpToolMeta[] } | undefined;
	const tools = result?.tools ?? [];
	toolsCache.set(cacheKey(), { tools, fetchedAt: Date.now() });
	return tools;
}

async function listTools(
	authHeader: string,
	signal?: AbortSignal,
	force = false,
): Promise<McpToolMeta[]> {
	if (!force) {
		const cached = toolsCache.get(cacheKey());
		if (cached) return cached.tools;
	}
	return await fetchToolsList(authHeader, signal);
}

/** tools/call を実行する（呼び出しごとハンドシェイク）。 */
async function callMcpTool(
	authHeader: string,
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	const sessionId = await handshake(authHeader, signal);
	const res = await mcpRequest(
		{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: toolName, arguments: args } },
		authHeader,
		sessionId,
		signal,
	);
	return res.result;
}

/** ----------------------------------------------------------------------- *
 * 出力ガード (50 KiB / 2000 行。全文は一時ファイルへ)
 * ----------------------------------------------------------------------- */

function truncateHead(text: string, maxBytes: number, maxLines: number): string {
	let lines = text.split("\n");
	if (lines.length > maxLines) lines = lines.slice(0, maxLines);
	let out = lines.join("\n");
	while (Buffer.byteLength(out, "utf8") > maxBytes && lines.length > 1) {
		lines = lines.slice(0, Math.max(1, Math.floor(lines.length / 2)));
		out = lines.join("\n");
	}
	if (Buffer.byteLength(out, "utf8") > maxBytes) {
		out = out.slice(0, maxBytes); // 単一行が巨大な場合の文字単位フォールバック
	}
	return out;
}

async function guardText(text: string): Promise<string> {
	const bytes = Buffer.byteLength(text, "utf8");
	const lines = text.split("\n").length;
	if (bytes <= GUARD_MAX_BYTES && lines <= GUARD_MAX_LINES) return text;
	const dir = await mkdtemp(join(tmpdir(), "atlassian-mcp-"));
	const file = join(dir, "result.txt");
	await writeFile(file, text, { mode: 0o600 });
	await chmod(file, 0o600);
	const truncated = truncateHead(text, GUARD_MAX_BYTES, GUARD_MAX_LINES);
	return `${truncated}\n\n[... 切り詰めました (${bytes} bytes / ${lines} lines)。全文: ${file}]`;
}

/** ----------------------------------------------------------------------- *
 * 拡張本体
 * ----------------------------------------------------------------------- */

export default function (pi: ExtensionAPI): void {
	/** /atlassian-login — OAuth 手動承認フローを（再）実行する。 */
	pi.registerCommand("atlassian-login", {
		description: "Atlassian Rovo MCP サーバーの OAuth 認証を行う（再認証）",
		handler: async (_args, ctx) => {
			try {
				await runLoginFlow(ctx.ui, undefined);
				ctx.ui.notify(`Atlassian ログイン完了 (アカウント: ${accountKey()})`, "info");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Atlassian ログイン失敗: ${msg}`, "error");
			}
		},
	});

	/** /atlassian-logout — 現在のプロファイルの認証情報を削除する。 */
	pi.registerCommand("atlassian-logout", {
		description: "現在のプロファイルの Atlassian 認証情報を削除",
		handler: async (_args, ctx) => {
			const removed = await removeAccount(accountKey());
			ctx.ui.notify(
				removed
					? `Atlassian 認証情報を削除しました (アカウント: ${accountKey()})`
					: `認証情報が見つかりません (アカウント: ${accountKey()})`,
				"info",
			);
		},
	});

	pi.registerTool({
		name: "atlassian_mcp",
		label: "Atlassian MCP",
		description:
			"Atlassian Rovo MCP サーバー（Jira / Confluence / JSM / Bitbucket / Compass）のツールを呼び出すプロキシ。" +
			'まず action:"list" で利用可能な MCP ツールを確認し、必要に応じて action:"describe" で引数スキーマを見てから action:"call" で実行する。',
		promptSnippet:
			"Atlassian（Jira/Confluence 等）の MCP ツールをプロキシ経由で呼び出す (list/describe/call)",
		promptGuidelines: [
			'Use atlassian_mcp for Jira, Confluence, and other Atlassian operations. First call atlassian_mcp with action:"list" to discover available MCP tools, use action:"describe" to inspect a tool\'s input schema, then use action:"call" with the tool name and structured args.',
		],
		parameters: Type.Object({
			action: StringEnum(["list", "describe", "call"] as const, {
				description: "list=ツール一覧 / describe=ツールのスキーマ詳細 / call=ツール実行",
			}),
			tool: Type.Optional(
				Type.String({ description: "MCP ツール名（describe と call で必須）" }),
			),
			args: Type.Optional(
				Type.Record(Type.String(), Type.Any(), {
					description: "MCP ツールへ渡す引数オブジェクト（call で使用）",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const authCtx: AuthContext = { hasUI: ctx.hasUI, ui: ctx.ui };

			if (params.action === "list") {
				onUpdate?.({ content: [{ type: "text", text: "Atlassian MCP ツール一覧を取得中..." }] });
				const tools = await withAuthRetry(authCtx, signal, (h) => listTools(h, signal));
				if (tools.length === 0) {
					return {
						content: [{ type: "text", text: "利用可能な MCP ツールがありません。" }],
						details: {},
					};
				}
				const text = tools
					.map((t) => `- ${t.name}: ${(t.description ?? "").split("\n")[0]}`)
					.join("\n");
				return {
					content: [{ type: "text", text: await guardText(text) }],
					details: { count: tools.length, endpoint: endpoint() },
				};
			}

			if (params.action === "describe") {
				if (!params.tool) throw new Error('action:"describe" には tool が必要です');
				const tools = await withAuthRetry(authCtx, signal, (h) => listTools(h, signal));
				const tool = tools.find((t) => t.name === params.tool);
				if (!tool) {
					throw new Error(
						`ツール "${params.tool}" が見つかりません。action:"list" で利用可能なツールを確認してください。`,
					);
				}
				return {
					content: [{ type: "text", text: JSON.stringify(tool, null, 2) }],
					details: { tool: tool.name },
				};
			}

			// action === "call"
			if (!params.tool) throw new Error('action:"call" には tool が必要です');
			const toolName = params.tool;
			const args = (params.args ?? {}) as Record<string, unknown>;

			onUpdate?.({ content: [{ type: "text", text: `Atlassian MCP: ${toolName} を呼び出し中...` }] });

			const result = await withAuthRetry(authCtx, signal, async (h) => {
				try {
					return await callMcpTool(h, toolName, args, signal);
				} catch (err) {
					// unknown tool 系エラーならツール一覧を再取得して 1 回だけリトライ
					const msg = err instanceof Error ? err.message : String(err);
					if (/unknown tool|not found|no such tool/i.test(msg)) {
						toolsCache.delete(cacheKey());
						await listTools(h, signal, true);
						return await callMcpTool(h, toolName, args, signal);
					}
					throw err;
				}
			});

			const callResult = result as {
				content?: Array<Record<string, unknown>>;
				isError?: boolean;
			};
			const blocks = callResult?.content ?? [];
			const textParts = blocks
				.filter((b) => b.type === "text")
				.map((b) => String(b.text ?? ""));
			const rawText = textParts.join("\n").trim() || JSON.stringify(result ?? {});

			if (callResult?.isError) {
				throw new Error(rawText.slice(0, 8192) || "MCP ツール呼び出しがエラーを返しました");
			}

			const content: Array<
				| { type: "text"; text: string }
				| { type: "image"; data: string; mimeType: string }
			> = [{ type: "text", text: await guardText(rawText) }];
			for (const b of blocks) {
				if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
					content.push({ type: "image", data: b.data, mimeType: b.mimeType });
				}
			}

			return {
				content,
				details: { tool: toolName, endpoint: endpoint(), account: accountKey() },
			};
		},
	});
}
