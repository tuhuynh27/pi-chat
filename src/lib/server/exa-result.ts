const MAX_SEARCH_RESULTS = 5;
const MAX_SEARCH_HIGHLIGHT_CHARACTERS = 1_000;
const MAX_FETCH_URLS = 3;
const MIN_FETCH_CHARACTERS_PER_URL = 1_000;
const DEFAULT_FETCH_CHARACTERS_PER_URL = 8_000;
const MAX_FETCH_CHARACTERS_PER_URL = 12_000;
const MAX_FETCH_TOTAL_CHARACTERS = 24_000;

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

export function searchResult(data: unknown) {
	const response = asRecord(data);
	const items = Array.isArray(response.results)
		? (response.results as unknown[])
				.slice(0, MAX_SEARCH_RESULTS)
				.map(asRecord)
				.map((result) => {
					const highlights = Array.isArray(result.highlights)
						? (result.highlights as unknown[])
								.map(asText)
								.filter(Boolean)
								.slice(0, 1)
								.map((highlight) => truncate(highlight, MAX_SEARCH_HIGHLIGHT_CHARACTERS))
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
		content: [{ type: 'text' as const, text: JSON.stringify({ results: items }) }],
		details
	};
}

export function fetchCharactersPerUrl(urlCount: number, requested?: number): number {
	const safeUrlCount = Math.max(1, Math.min(urlCount, MAX_FETCH_URLS));
	return Math.min(
		Math.max(requested ?? DEFAULT_FETCH_CHARACTERS_PER_URL, MIN_FETCH_CHARACTERS_PER_URL),
		MAX_FETCH_CHARACTERS_PER_URL,
		Math.floor(MAX_FETCH_TOTAL_CHARACTERS / safeUrlCount)
	);
}

export function fetchResult(data: unknown, requestedCharactersPerUrl: number) {
	const response = asRecord(data);
	const statuses = new Map(
		(Array.isArray(response.statuses) ? (response.statuses as unknown[]) : [])
			.map(asRecord)
			.map((status) => [asText(status.id), asText(status.status)] as const)
	);
	const rawItems = (Array.isArray(response.results) ? (response.results as unknown[]) : [])
		.slice(0, MAX_FETCH_URLS)
		.map(asRecord);
	const localCharactersPerUrl = Math.min(
		requestedCharactersPerUrl,
		Math.floor(MAX_FETCH_TOTAL_CHARACTERS / Math.max(1, rawItems.length))
	);
	const items = rawItems.map((result) => {
		const url = asText(result.url) || asText(result.id);
		const sourceText = asText(result.text).trim();
		const wasTruncated = sourceText.length > localCharactersPerUrl;
		return {
			title: asText(result.title) || url,
			url,
			text: truncate(sourceText, localCharactersPerUrl),
			...(wasTruncated ? { truncated: true } : {}),
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
		content: [{ type: 'text' as const, text: JSON.stringify({ results: items }) }],
		details
	};
}

export const EXA_LIMITS = {
	searchResults: MAX_SEARCH_RESULTS,
	searchHighlightCharacters: MAX_SEARCH_HIGHLIGHT_CHARACTERS,
	fetchUrls: MAX_FETCH_URLS,
	minFetchCharactersPerUrl: MIN_FETCH_CHARACTERS_PER_URL,
	defaultFetchCharactersPerUrl: DEFAULT_FETCH_CHARACTERS_PER_URL,
	maxFetchCharactersPerUrl: MAX_FETCH_CHARACTERS_PER_URL,
	maxFetchTotalCharacters: MAX_FETCH_TOTAL_CHARACTERS
} as const;
