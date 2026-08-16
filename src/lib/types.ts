export type ToolStatus = 'running' | 'done' | 'error';

/** Structured payload for Exa tool results (from the agent's tool `details`). */
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

export const EXA_TOOL_NAMES = new Set(['web_search_exa', 'web_fetch_exa']);

export type Item =
	| { id: string; role: 'user'; text: string }
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
export const isExaTool = (i: Item): i is ToolItem => isTool(i) && EXA_TOOL_NAMES.has(i.name);

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

/** Map stored items to renderable Items (client-side ids for non-tool rows). */
export function toItems(stored: StoredItem[]): Item[] {
	return stored.map((i) => {
		switch (i.role) {
		case 'user':
			return { id: uid(), role: 'user', text: i.text ?? '' };
		case 'assistant':
			return {
				id: uid(),
				role: 'assistant',
				text: i.text ?? '',
				thinking: i.thinking ?? '',
				streaming: false
			};
		case 'tool': {
			const details = i.details as ExaDetails | undefined;
			return {
				id: i.id ?? uid(),
				role: 'tool',
				name: i.name ?? '',
				detail: i.detail ?? '',
				status: i.status === 'error' ? 'error' : 'done',
				output: i.output ?? '',
				details: details && (details.kind === 'search' || details.kind === 'fetch') ? details : undefined
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
		case 'web_fetch_exa':
			return Array.isArray(a.urls) ? `${a.urls.length} URL${a.urls.length === 1 ? '' : 's'}` : '';
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
