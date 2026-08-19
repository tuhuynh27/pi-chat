export type ToolStatus = 'running' | 'done' | 'error';

/** Structured payload for web search / fetch tool results. */
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

export const WEB_TOOL_NAMES = new Set(['web_search_exa', 'web_fetch_exa']);

export function webToolKind(name: string): 'search' | 'fetch' {
	return name === 'web_fetch_exa' ? 'fetch' : 'search';
}

function webItemsFromUnknown(items: unknown[]): ExaItemInfo[] {
	return items.flatMap((raw) => {
		if (!raw || typeof raw !== 'object') return [];
		const it = raw as Record<string, unknown>;
		const highlight = Array.isArray(it.highlights) ? it.highlights[0] : undefined;
		const preview =
			typeof it.preview === 'string'
				? it.preview
				: typeof highlight === 'string'
					? highlight
					: typeof it.text === 'string'
						? it.text
						: undefined;
		return [
			{
				title: typeof it.title === 'string' ? it.title : '',
				url: typeof it.url === 'string' ? it.url : '',
				...(preview ? { preview } : {}),
				...(typeof it.status === 'string' ? { status: it.status } : {})
			}
		];
	});
}

/** Normalize a tool `details` payload; infers kind from the tool name when omitted. */
export function asWebDetails(raw: unknown, name = ''): ExaDetails | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const d = raw as Partial<ExaDetails> & Record<string, unknown>;
	const items = Array.isArray(d.items) ? webItemsFromUnknown(d.items) : undefined;
	const kind =
		d.kind === 'search' || d.kind === 'fetch'
			? d.kind
			: WEB_TOOL_NAMES.has(name)
				? webToolKind(name)
				: undefined;
	if (!kind) return undefined;
	return {
		kind,
		itemCount: typeof d.itemCount === 'number' ? d.itemCount : (items?.length ?? 0),
		...(typeof d.searchTimeMs === 'number' ? { searchTimeMs: d.searchTimeMs } : {}),
		items: items ?? []
	};
}

/** Recover a details payload from the tool's JSON text output when `details` is missing. */
export function webDetailsFromOutput(output: string, name: string): ExaDetails | undefined {
	if (!output || !WEB_TOOL_NAMES.has(name)) return undefined;
	try {
		const parsed = JSON.parse(output) as { results?: unknown };
		if (!Array.isArray(parsed.results)) return undefined;
		const items = webItemsFromUnknown(parsed.results);
		return { kind: webToolKind(name), itemCount: items.length, items };
	} catch {
		return undefined;
	}
}

/** Max images allowed per user turn (clipboard paste or file attach). */
export const MAX_IMAGES = 5;

/** Base64-encoded image attachment (no data: URL prefix). */
export interface ImageAttachment {
	data: string;
	mimeType: string;
}

export type Item =
	| { id: string; role: 'user'; text: string; images?: ImageAttachment[] }
	| {
			id: string;
			role: 'assistant';
			text: string;
			thinking: string;
			streaming: boolean;
			/** True while thinking deltas are arriving (thinking block auto-opens) */
			thinkingActive?: boolean;
		}
	| { id: string; role: 'tool'; name: string; detail: string; status: ToolStatus; output: string; details?: ExaDetails }
	| { id: string; role: 'error'; text: string; retry?: () => void };

export type AssistantItem = Extract<Item, { role: 'assistant' }>;
export type ToolItem = Extract<Item, { role: 'tool' }>;

export const isTool = (i: Item): i is ToolItem => i.role === 'tool';
export const isAssistant = (i: Item): i is AssistantItem => i.role === 'assistant';
export const isWebTool = (i: Item): i is ToolItem => isTool(i) && WEB_TOOL_NAMES.has(i.name);

/* ---------------- conversation history ---------------- */

/** Stored item shape (mirrors the server store; no node imports here). */
export interface StoredItem {
	role: 'user' | 'assistant' | 'tool' | 'error';
	id?: string;
	text?: string;
	thinking?: string;
	name?: string;
	detail?: string;
	status?: 'running' | 'done' | 'error';
	output?: string;
	details?: Record<string, unknown>;
	images?: ImageAttachment[];
}

export interface ConvoSummary {
	id: string;
	title: string;
	updatedAt: number;
	model: string | null;
	thinking: string;
	itemCount: number;
	busy: boolean;
}

export interface ConvoInfo extends ConvoSummary {
	createdAt: number;
	items: StoredItem[];
	cwd?: string;
	sandboxed?: boolean;
}

/**
 * Map stored items to renderable Items (client-side ids for non-tool rows).
 * `busy` keeps a stored `running` tool status visible (reattaching to a live
 * run mid-tool-call); on an idle conversation a leftover `running` (e.g. the
 * server died mid-run) is shown as done instead of spinning forever.
 */
export function toItems(stored: StoredItem[], busy = false): Item[] {
	return stored.map((i) => {
		switch (i.role) {
		case 'user':
			return { id: uid(), role: 'user', text: i.text ?? '', images: i.images };
		case 'assistant':
			return {
				id: uid(),
				role: 'assistant',
				text: i.text ?? '',
				thinking: i.thinking ?? '',
				streaming: false
			};
		case 'tool': {
			const name = i.name ?? '';
			const details = asWebDetails(i.details, name) ?? webDetailsFromOutput(i.output ?? '', name);
			// Leftover `running` after a crash/restart must not spin forever.
			// Details arriving is also enough to treat the call as finished.
			const leftover = i.status === 'running' && (!busy || Boolean(details));
			return {
				id: i.id ?? uid(),
				role: 'tool',
				name,
				detail: i.detail ?? '',
				status: leftover ? 'done' : (i.status ?? 'done'),
				output: i.output ?? '',
				details
			};
		}
		default:
			return { id: uid(), role: 'error', text: i.text ?? '' };
	}
	});
}

export const uid = (): string =>
	typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);

/** Short one-line summary of a tool call for the activity row. */
export function toolDetail(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const str = (v: unknown, n = 96): string => {
		if (typeof v !== 'string') return '';
		const first = v.split('\n')[0] ?? '';
		return first.length > n ? first.slice(0, n - 1) + '…' : first;
	};
	switch (name) {
		case 'bash':
			return str(a.command);
		case 'read':
		case 'write':
		case 'edit':
		case 'ls':
			return str(a.path, 120);
		case 'grep':
			return typeof a.pattern === 'string' ? `/${a.pattern}/` : str(a.path, 120);
		case 'find':
			return typeof a.pattern === 'string' ? str(a.pattern, 60) : str(a.path, 120);
		case 'web_search_exa':
			return str(a.query);
		case 'web_fetch_exa': {
			if (!Array.isArray(a.urls) || a.urls.length === 0) return '';
			if (a.urls.length === 1 && typeof a.urls[0] === 'string') {
				try {
					return new URL(a.urls[0]).hostname.replace(/^www\./, '');
				} catch {
					return str(a.urls[0], 80);
				}
			}
			return `${a.urls.length} pages`;
		}
		default: {
			try {
				const s = JSON.stringify(a);
				return s.length > 96 ? s.slice(0, 95) + '…' : s;
			} catch {
				return '';
			}
		}
	}
}
