/**
 * Brave Search extension for pi coding agent.
 *
 * This is the pi equivalent of the Codex "Brave Search MCP Server" setup.
 * Codex configures an MCP server like this in ~/.codex/config.toml:
 *
 *   [mcp_servers.brave_search]
 *   url = "https://api.llm-gateway.kurisu.nico/brave_search/mcp"
 *   env_http_headers = { "x-litellm-api-key" = "LITELLM_MCP_AUTH_HEADER" }
 *   enabled = true
 *
 * where LITELLM_MCP_AUTH_HEADER="Bearer ${LITELLM_API_KEY}".
 *
 * pi has no built-in MCP client, so this extension implements a minimal
 * MCP Streamable HTTP client and exposes Brave Search as a normal pi tool
 * the LLM can call via pi.registerTool().
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** MCP endpoint (override with BRAVE_SEARCH_MCP_URL if needed). */
const MCP_ENDPOINT =
	process.env.BRAVE_SEARCH_MCP_URL ??
	"https://api.llm-gateway.kurisu.nico/brave_search/mcp";

/** ----------------------------------------------------------------------- *
 * Minimal MCP Streamable HTTP client
 * ----------------------------------------------------------------------- */

interface McpOutcome {
	result?: unknown;
	sessionId: string | null;
}

/** Parse a `text/event-stream` body into an array of JSON-RPC objects. */
function parseSse(text: string): Record<string, unknown>[] {
	const events: Record<string, unknown>[] = [];
	let data = "";
	const flush = () => {
		if (!data) return;
		try {
			events.push(JSON.parse(data));
		} catch {
			// Ignore malformed SSE chunk; non-fatal for parsing.
		}
		data = "";
	};
	for (const line of text.split("\n")) {
		if (line.startsWith("data:")) {
			data += line.slice(5).replace(/^\s+/, "");
		} else if (line.trim() === "") {
			flush();
		}
	}
	flush();
	return events;
}

async function mcpRequest(
	body: Record<string, unknown>,
	apiKey: string,
	sessionId: string | null,
	signal?: AbortSignal,
): Promise<McpOutcome> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		// Mirror the Codex `env_http_headers` mapping exactly:
		// the header value is the Bearer token, not the raw key.
		"x-litellm-api-key": `Bearer ${apiKey}`,
		Authorization: `Bearer ${apiKey}`,
	};
	if (sessionId) headers["Mcp-Session-Id"] = sessionId;

	const res = await fetch(MCP_ENDPOINT, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});

	const newSessionId = res.headers.get("mcp-session-id") ?? sessionId;
	const contentType = res.headers.get("content-type") ?? "";
	const text = await res.text();

	let parsed: Record<string, unknown> | undefined;
	if (contentType.includes("text/event-stream")) {
		const events = parseSse(text);
		parsed =
			body.id !== undefined
				? events.find((e) => e && e.id === body.id) ?? events[events.length - 1]
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
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`MCP request failed (HTTP ${res.status})`);
	}

	return { result: parsed?.result, sessionId: newSessionId };
}

/**
 * Run a Brave Search query through the MCP server.
 * Performs the full JSON-RPC handshake (initialize -> initialized -> tools/list
 * -> tools/call) on every invocation for connection robustness.
 */
export async function braveSearch(
	apiKey: string,
	query: string,
	count: number,
	signal?: AbortSignal,
): Promise<string> {
	const rpc = { jsonrpc: "2.0" as const };

	// 1. initialize
	let { sessionId } = await mcpRequest(
		{
			...rpc,
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "pi-brave-search", version: "1.0.0" },
			},
		},
		apiKey,
		null,
		signal,
	);

	// 2. initialized notification
	const initialized = await mcpRequest(
		{ ...rpc, method: "notifications/initialized" },
		apiKey,
		sessionId,
		signal,
	);
	sessionId = initialized.sessionId;

	// 3. tools/list and pick a web-search tool
	const list = await mcpRequest(
		{ ...rpc, id: 2, method: "tools/list", params: {} },
		apiKey,
		sessionId,
		signal,
	);
	const listResult = list.result as { tools?: Array<{ name: string }> } | undefined;
	const tools = (listResult?.tools ?? []).map((t) => t.name);
	const toolName =
		tools.find((n) => /search|brave|web/i.test(n)) ?? tools[0];
	if (!toolName) {
		throw new Error("Brave Search MCP server exposed no usable tools");
	}

	// 4. tools/call
	const call = await mcpRequest(
		{
			...rpc,
			id: 3,
			method: "tools/call",
			params: { name: toolName, arguments: { query, count } },
		},
		apiKey,
		sessionId,
		signal,
	);

	const callResult = call.result as { content?: Array<{ type: string; text?: string }> } | undefined;
	const content = (callResult?.content ?? []) as Array<{
		type: string;
		text?: string;
	}>;
	const text = content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
		.trim();

	return text || JSON.stringify(call.result ?? {});
}

/** ----------------------------------------------------------------------- *
 * Extension entry point
 * ----------------------------------------------------------------------- */

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!process.env.LITELLM_API_KEY) {
			ctx.ui.notify(
				"brave_search: LITELLM_API_KEY is not set. The tool will prompt for it on first use.",
				"warning",
			);
		}
	});

	pi.registerTool({
		name: "brave_search",
		label: "Brave Search",
		description:
			"Search the web via Brave Search through the LiteLLM MCP gateway. " +
			"Use this to fetch up-to-date facts, documentation, or current events " +
			"that are not available in the local workspace.",
		promptSnippet: "Search the web via Brave Search (LiteLLM MCP gateway)",
		promptGuidelines: [
			"Use brave_search when the user needs current web information, external documentation, or facts not present in the local files.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "The search query to run against Brave Search.",
			}),
			count: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 20,
					description: "Number of results to return (default 5).",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let apiKey = process.env.LITELLM_API_KEY;
			if (!apiKey && ctx.ui.input) {
				apiKey = await ctx.ui.input(
					"Enter your LiteLLM API Key for Brave Search:",
					undefined,
					{ signal: signal ?? undefined },
				);
			}
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: "Error: LITELLM_API_KEY is not set and no API key was provided.",
						},
					],
					details: {},
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Searching Brave for: ${params.query}` }],
			});

			try {
				const result = await braveSearch(
					apiKey,
					params.query,
					params.count ?? 5,
					signal,
				);
				return {
					content: [{ type: "text", text: result }],
					details: { query: params.query, endpoint: MCP_ENDPOINT },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `brave_search failed: ${message}` }],
					details: { error: message },
				};
			}
		},
	});
}
