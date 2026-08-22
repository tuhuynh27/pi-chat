import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '$env/dynamic/private';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { parseJsonBuffer } from './json-worker';

/**
 * Exa web search + fetch tools for the Pi agent (web build).
 *
 * Same tools/schemas as the global `~/.pi/agent/extensions/exa.ts` used by the
 * pi CLI, bundled here so the web app is self-contained. TUI renderers are
 * omitted — the web UI visualizes tool calls from the SSE event stream instead.
 */

const EXA_API_URL = 'https://api.exa.ai';
const KEYCHAIN_SERVICE = 'pi-exa-api-key';
const MAX_SEARCH_HIGHLIGHT_CHARS = 1200;
const MAX_FETCH_CHARACTERS = 50_000;
const EXA_REQUEST_TIMEOUT_MS = 60_000;
const MAIN_THREAD_JSON_LIMIT = 256 * 1024;
const execFileAsync = promisify(execFile);

/** Key resolution: EXA_API_KEY env var, then macOS Keychain. */
async function getApiKey(): Promise<string> {
	const envKey = env.EXA_API_KEY;
	if (envKey) return envKey;

	const account = process.env.USER;
	if (!account) {
		throw new Error('EXA_API_KEY is not configured: the EXA_API_KEY environment variable is unset.');
	}
	try {
		const { stdout } = await execFileAsync(
			'security',
			['find-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE, '-w'],
			{ encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 }
		);
		return stdout.trim();
	} catch {
		throw new Error(
			'EXA_API_KEY is not configured. Set the EXA_API_KEY environment variable, or add the key to macOS Keychain under the pi-exa-api-key service.'
		);
	}
}

async function exaRequest(
	path: '/search' | '/contents',
	body: Record<string, unknown>,
	signal?: AbortSignal
): Promise<unknown> {
	const timeoutSignal = AbortSignal.timeout(EXA_REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const response = await fetch(`${EXA_API_URL}${path}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			Authorization: `Bearer ${await getApiKey()}`
		},
		body: JSON.stringify(body),
		signal: requestSignal
	});

	const responseBody = await response.arrayBuffer();
	const responseBytes = responseBody.byteLength;
	let responseText = '';
	let data: unknown;
	try {
		if (responseBytes > MAIN_THREAD_JSON_LIMIT) {
			data = await parseJsonBuffer(responseBody);
		} else {
			responseText = new TextDecoder().decode(responseBody);
			data = JSON.parse(responseText);
		}
	} catch {
		// Keep small non-JSON errors readable without decoding an unbounded body
		// on the event loop.
		if (responseBytes <= MAIN_THREAD_JSON_LIMIT && !responseText) {
			responseText = new TextDecoder().decode(responseBody);
		}
		data = responseText;
	}

	if (!response.ok) {
		const message =
			typeof data === 'object' && data !== null && 'message' in data
				? String((data as Record<string, unknown>).message)
				: responseText || response.statusText;
		throw new Error(`Exa API request failed (${response.status}): ${message}`);
	}

	return data;
}

/* ---------------- result shaping ---------------- */

export interface ExaItemInfo {
	title: string;
	url: string;
	preview?: string;
	status?: string;
}

export interface ExaDetails {
	kind: 'search' | 'fetch';
	itemCount: number;
	searchTimeMs?: number;
	items: ExaItemInfo[];
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function truncate(text: string, limit: number): string {
	const normalized = text.trim();
	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function searchResult(data: unknown) {
	const response = asRecord(data);
	const items = Array.isArray(response.results)
		? (response.results as unknown[]).map(asRecord).map((result) => {
				const highlights = Array.isArray(result.highlights)
					? (result.highlights as unknown[])
							.map(asText)
							.filter(Boolean)
							.slice(0, 1)
							.map((h) => truncate(h, MAX_SEARCH_HIGHLIGHT_CHARS))
					: [];
				return {
					title: asText(result.title) || asText(result.url),
					url: asText(result.url),
					...(highlights.length ? { highlights } : {})
				};
			})
		: [];

	const details: ExaDetails = {
		kind: 'search',
		itemCount: items.length,
		...(typeof response.searchTime === 'number' ? { searchTimeMs: response.searchTime } : {}),
		items: items.map(({ title, url, highlights }) => ({ title, url, preview: highlights?.[0] }))
	};

	return {
		content: [{ type: 'text' as const, text: JSON.stringify({ results: items }, null, 2) }],
		details
	};
}

function fetchResult(data: unknown) {
	const response = asRecord(data);
	const statuses = new Map(
		(Array.isArray(response.statuses) ? (response.statuses as unknown[]) : [])
			.map(asRecord)
			.map((status) => [asText(status.id), asText(status.status)] as const)
	);
	const items = (Array.isArray(response.results) ? (response.results as unknown[]) : []).map(asRecord).map((result) => {
		const url = asText(result.url) || asText(result.id);
		return {
			title: asText(result.title) || url,
			url,
			text: asText(result.text),
			...(statuses.get(url) ? { status: statuses.get(url) } : {})
		};
	});

	const details: ExaDetails = {
		kind: 'fetch',
		itemCount: items.length,
		...(typeof response.searchTime === 'number' ? { searchTimeMs: response.searchTime } : {}),
		items: items.map(({ title, url, text, status }) => ({
			title,
			url,
			preview: truncate(text, 320),
			status
		}))
	};

	return {
		content: [{ type: 'text' as const, text: JSON.stringify({ results: items }, null, 2) }],
		details
	};
}

/* ---------------- extension ---------------- */

export const exaExtension: InlineExtension = {
	name: 'exa',
	factory: (pi) => {
		pi.registerTool({
			name: 'web_search_exa',
			label: 'Exa Web Search',
			description: 'Search the web with Exa and return relevant results with concise source highlights.',
			promptSnippet: 'Search the web and return relevant results with source highlights',
			parameters: Type.Object({
				query: Type.String({ description: 'Natural-language web search query.' }),
				numResults: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 10, description: 'Number of results to return. Default: 5.' })
				),
				type: Type.Optional(
					Type.Union([
						Type.Literal('auto'),
						Type.Literal('fast'),
						Type.Literal('instant'),
						Type.Literal('deep-lite'),
						Type.Literal('deep'),
						Type.Literal('deep-reasoning')
					])
				),
				includeDomains: Type.Optional(Type.Array(Type.String())),
				excludeDomains: Type.Optional(Type.Array(Type.String())),
				maxAgeHours: Type.Optional(
					Type.Integer({ minimum: -1, description: 'Maximum cache age in hours. 0 forces a live crawl.' })
				)
			}),
			async execute(_toolCallId, params, signal) {
				const contents: Record<string, unknown> = { highlights: true };
				if (params.maxAgeHours !== undefined) contents.maxAgeHours = params.maxAgeHours;

				return searchResult(
					await exaRequest('/search', {
						query: params.query,
						type: params.type ?? 'auto',
						numResults: params.numResults ?? 5,
						...(params.includeDomains ? { includeDomains: params.includeDomains } : {}),
						...(params.excludeDomains ? { excludeDomains: params.excludeDomains } : {}),
						contents
					}, signal)
				);
			}
		});

		pi.registerTool({
			name: 'web_fetch_exa',
			label: 'Exa Web Fetch',
			description: 'Fetch clean, LLM-ready markdown content from one or more web pages using Exa.',
			promptSnippet: 'Fetch clean markdown content from one or more web pages',
			parameters: Type.Object({
				urls: Type.Array(Type.String({ format: 'uri' }), {
					minItems: 1,
					maxItems: 10,
					description: 'One to ten HTTP(S) URLs to fetch.'
				}),
				maxCharacters: Type.Optional(
					Type.Integer({ minimum: 1000, maximum: 50000, description: 'Optional Exa character limit per URL.' })
				),
				maxAgeHours: Type.Optional(
					Type.Integer({ minimum: -1, description: 'Maximum cache age in hours. 0 forces a live crawl.' })
				)
			}),
			async execute(_toolCallId, params, signal) {
				return fetchResult(
					await exaRequest('/contents', {
						urls: params.urls,
						text: { maxCharacters: params.maxCharacters ?? MAX_FETCH_CHARACTERS },
						...(params.maxAgeHours !== undefined ? { maxAgeHours: params.maxAgeHours } : {})
					}, signal)
				);
			}
		});
	}
};
