/**
 * Brave Search extension for pi coding agent — direct Brave API edition (pi-private profile only).
 *
 * This is the pi extension equivalent of the `web-search` and `llm-context`
 * skills: it calls the Brave Search API directly (no MCP gateway) using the
 * BRAVE_SEARCH_API_KEY environment variable, and exposes two typed tools the
 * LLM can call:
 *
 *   - web_search : classic web/results listing (titles, URLs, snippets,
 *                  freshness/result-type filters). Best when you want to
 *                  *discover* sources or choose which page to read.
 *   - llm_context : pre-extracted page content (text, tables, code) for
 *                  grounding/RAG. Best when you want to *read* web content.
 *
 * Output is truncated to a configurable token budget so the agent context is
 * never overwhelmed. Requires `BRAVE_SEARCH_API_KEY` in the environment.
 *
 * Profile gating: only registers its tools when AI_ENV_PROFILE === "pi-private".
 * It is mutually exclusive with brave-search-pi-work.ts (MCP gateway, pi-work only).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "https://api.search.brave.com/res/v1";
const API_KEY_ENV = "BRAVE_SEARCH_API_KEY";

/** ----------------------------------------------------------------------- *
 * Helpers
 * ----------------------------------------------------------------------- */

function getApiKey(): string {
	const key = process.env[API_KEY_ENV];
	if (!key) {
		throw new Error(
			`Missing ${API_KEY_ENV} environment variable. Export it before starting pi ` +
				`(e.g. export ${API_KEY_ENV}=<your-brave-key>).`,
		);
	}
	return key;
}

/** Call a Brave Search GET endpoint with the given query params. */
async function braveGet(
	path: string,
	params: Record<string, string | number | undefined>,
	signal?: AbortSignal,
): Promise<any> {
	const url = new URL(`${BASE}${path}`);
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined || v === null || v === "") continue;
		url.searchParams.set(k, String(v));
	}

	const res = await fetch(url, {
		method: "GET",
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": getApiKey(),
		},
		signal,
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(
			`Brave API error ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
		);
	}
	return res.json();
}

/** Strip lightweight HTML (e.g. <strong>) from Brave result descriptions. */
function stripTags(s: string): string {
	return s.replace(/<[^>]+>/g, "");
}

/** Persist the full (untruncated) content and return the temp path. */
async function saveFull(content: string): Promise<string> {
	const file = join(
		tmpdir(),
		`brave-search-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
	);
	await writeFile(file, content, "utf8");
	return file;
}

/** Truncate to a byte/line budget and, if truncated, stash the full text. */
async function pack(
	content: string,
	maxBytes: number,
	maxLines: number,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const t = truncateHead(content, { maxBytes, maxLines });
	let text = t.content;
	const details: Record<string, unknown> = {};
	if (t.truncated) {
		const file = await saveFull(content);
		text +=
			`\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines ` +
			`(${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). ` +
			`Full output saved to: ${file}]`;
		details.truncated = true;
		details.fullOutputFile = file;
	}
	return { text, details };
}

/** ----------------------------------------------------------------------- *
 * Formatters
 * ----------------------------------------------------------------------- */

function formatWeb(results: any[]): string {
	if (!results?.length) return "No web results returned.";
	return results
		.map((r, i) => {
			const parts = [`[${i + 1}] ${r.title ?? "(untitled)"}`, `URL: ${r.url ?? ""}`];
			if (r.age) parts.push(`Age: ${r.age}`);
			if (r.description) parts.push(`Summary: ${stripTags(r.description)}`);
			const extras: string[] = r.extra_snippets ?? [];
			if (extras.length) {
				parts.push(
					"More:\n" + extras.map((e) => `  - ${stripTags(e)}`).join("\n"),
				);
			}
			return parts.join("\n");
		})
		.join("\n\n");
}

function formatContext(generic: any[]): string {
	if (!generic?.length) return "No grounding content returned.";
	return generic
		.map((g) => {
			const parts = [
				`Source: ${g.title ?? "(untitled)"}`,
				`URL: ${g.url ?? ""}`,
			];
			for (const s of g.snippets ?? []) {
				parts.push(typeof s === "string" ? s : JSON.stringify(s));
			}
			return parts.join("\n");
		})
		.join("\n\n");
}

/** ----------------------------------------------------------------------- *
 * Extension entry point
 * ----------------------------------------------------------------------- */

export default function (pi: ExtensionAPI): void {
	// この extension は pi-private プロファイル時のみ有効化する。
	// 既存の brave-search.ts (MCP ゲートウェイ版) とは異なるアプローチのため、同居してもツール名が重複しません。
	if (process.env.AI_ENV_PROFILE !== "pi-private") {
		return;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI && !process.env[API_KEY_ENV]) {
			ctx.ui.notify(
				`brave-search-tools: ${API_KEY_ENV} is not set; web_search/llm_context will fail until it is provided.`,
				"warning",
			);
		}
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via the Brave Search API. Returns ranked results with " +
			"titles, URLs, summaries, and (optionally) extra snippets. Use this to " +
			"discover web pages, recent news, videos, discussions, or FAQs, or when " +
			"you want to choose which source to read yourself.",
		promptSnippet: "Search the web via Brave Search (titles, URLs, snippets)",
		promptGuidelines: [
			"Use web_search to discover web sources, filter by freshness (freshness=pd|pw|pm|py) or result type (result_filter=web,videos,news,faqs,discussions), and to pick pages to read.",
			"Prefer llm_context over web_search when you need the page's actual extracted content to ground an answer.",
		],
		parameters: Type.Object({
			q: Type.String({ description: "The search query (1-400 chars, max 50 words)." }),
			count: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 20, description: "Results per page (default 10)." }),
			),
			country: Type.Optional(
				Type.String({ description: "2-letter country code or 'ALL'." }),
			),
			search_lang: Type.Optional(
				Type.String({ description: "Language preference (e.g. 'en')." }),
			),
			safesearch: Type.Optional(
				StringEnum(["off", "moderate", "strict"] as const, {
					description: "Adult content filter (default 'moderate').",
				}),
			),
			freshness: Type.Optional(
				Type.String({
					description: "Time filter: pd (day), pw (week), pm (month), py (year), or YYYY-MM-DDtoYYYY-MM-DD.",
				}),
			),
			result_filter: Type.Optional(
				Type.String({
					description: "Comma-separated result types: web,videos,news,faqs,discussions,locations,infobox.",
				}),
			),
			goggles: Type.Optional(
				Type.String({
					description:
						"Custom ranking rule (inline '$discard\\n$site=docs.python.org' or a Goggle URL).",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			if (signal?.aborted) {
				throw new Error("web_search cancelled before start");
			}
			onUpdate?.({
				content: [{ type: "text", text: `Searching the web for: ${params.q}` }],
			});

			try {
				const data = await braveGet(
					"/web/search",
					{
						q: params.q,
						count: params.count,
						country: params.country,
						search_lang: params.search_lang,
						safesearch: params.safesearch,
						freshness: params.freshness,
						result_filter: params.result_filter,
						goggles: params.goggles,
					},
					signal,
				);

				const results = data?.web?.results ?? [];
				const altered = data?.query?.altered;
				const header =
					(altered ? `Query corrected to: ${altered}\n\n` : "") +
					`${results.length} result(s):\n\n`;
				const { text, details } = await pack(
					header + formatWeb(results),
					DEFAULT_MAX_BYTES,
					DEFAULT_MAX_LINES,
				);
				return { content: [{ type: "text", text }], details };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `web_search failed: ${message}` }],
					details: { error: message },
				};
			}
		},
	});

	pi.registerTool({
		name: "llm_context",
		label: "LLM Context",
		description:
			"Fetch pre-extracted web page content (text, tables, code) via the Brave " +
			"LLM Context API for grounding/RAG. Returns the actual page chunks rather " +
			"than just links. Use this when you want to read web content to answer a " +
			"question or ground a response. By default it returns a lot of text, so set " +
			"maximum_number_of_tokens lower for quick lookups.",
		promptSnippet: "Fetch pre-extracted web page content for grounding (RAG)",
		promptGuidelines: [
			"Use llm_context to ground answers in extracted web content (text/tables/code), especially for documentation and RAG lookups.",
			"llm_context can return large text; set maximum_number_of_tokens low (e.g. 2048) for simple factual lookups and higher for research.",
			"Use goggles to restrict sources to trusted domains (e.g. '$discard\\n$site=docs.python.org').",
		],
		parameters: Type.Object({
			q: Type.String({ description: "The search query (1-400 chars, max 50 words)." }),
			count: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 50, description: "Max results considered (default 20)." }),
			),
			maximum_number_of_urls: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 50, description: "Max URLs in response (default 20)." }),
			),
			maximum_number_of_tokens: Type.Optional(
				Type.Integer({
					minimum: 1024,
					maximum: 32768,
					description: "Approx max tokens of extracted content (default 8192).",
				}),
			),
			country: Type.Optional(Type.String({ description: "2-letter country code or 'ALL'." })),
			search_lang: Type.Optional(Type.String({ description: "Language preference (e.g. 'en')." })),
			context_threshold_mode: Type.Optional(
				StringEnum(["strict", "balanced", "lenient"] as const, {
					description: "Relevance threshold (default 'balanced').",
				}),
			),
			goggles: Type.Optional(
				Type.String({
					description:
						"Custom ranking rule (inline '$discard\\n$site=docs.python.org' or a Goggle URL).",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			if (signal?.aborted) {
				throw new Error("llm_context cancelled before start");
			}
			onUpdate?.({
				content: [{ type: "text", text: `Fetching web context for: ${params.q}` }],
			});

			try {
				const data = await braveGet(
					"/llm/context",
					{
						q: params.q,
						count: params.count,
						maximum_number_of_urls: params.maximum_number_of_urls,
						maximum_number_of_tokens: params.maximum_number_of_tokens,
						country: params.country,
						search_lang: params.search_lang,
						context_threshold_mode: params.context_threshold_mode,
						goggles: params.goggles,
					},
					signal,
				);

				const generic = data?.grounding?.generic ?? [];
				const maxTokens = params.maximum_number_of_tokens ?? 8192;
				const maxBytes = Math.min(DEFAULT_MAX_BYTES, Math.max(1024, maxTokens) * 4);
				const header = `${generic.length} source(s) extracted:\n\n`;
				const { text, details } = await pack(
					header + formatContext(generic),
					maxBytes,
					DEFAULT_MAX_LINES,
				);
				return { content: [{ type: "text", text }], details };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `llm_context failed: ${message}` }],
					details: { error: message },
				};
			}
		},
	});
}
