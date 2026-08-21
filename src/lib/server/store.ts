import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_THINKING } from './default-models';
import type { ContextInfo } from '../types';

/**
 * Conversation history store.
 *
 * - display history (items) lives in `<dataDir>/conversations.json`
 * - LLM context lives in Pi session files `<dataDir>/sessions/*_<id>.jsonl`
 *   (created by SessionManager; restored on restart)
 *
 * Data dir: $PI_WEB_DATA_DIR, default `~/.pi-web`. The sandbox launcher sets
 * both and allow-lists the dir for writes (see sandbox-start.sh).
 */

/** Base64-encoded image attachment (no data: URL prefix). Mirrors the SDK's ImageContent shape. */
export interface ImageAttachment {
	data: string;
	mimeType: string;
}

export interface StoredItem {
	role: 'user' | 'assistant' | 'tool' | 'error';
	/** Tool call id (tool items only) */
	id?: string;
	text?: string;
	thinking?: string;
	name?: string;
	detail?: string;
	status?: 'running' | 'done' | 'error';
	output?: string;
	details?: Record<string, unknown>;
	/** User turn image attachments (user items only) */
	images?: ImageAttachment[];
}

export interface Convo {
	id: string;
	title: string;
	/** "provider/model-id" or null (SDK default) */
	model: string | null;
	thinking: string;
	createdAt: number;
	updatedAt: number;
	items: StoredItem[];
	/** Last known LLM context usage, kept so the gauge survives session eviction/restart. */
	lastContext?: ContextInfo;
}

export interface ConvoSummary {
	id: string;
	title: string;
	updatedAt: number;
	model: string | null;
	thinking: string;
	itemCount: number;
}

/** Max stored length of an assistant thinking block. */
export const THINKING_CAP = 32000;

export function dataDir(): string {
	const dir = process.env.PI_WEB_DATA_DIR || join(homedir(), '.pi-web');
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function sessionDir(): string {
	const dir = join(dataDir(), 'sessions');
	mkdirSync(dir, { recursive: true });
	return dir;
}

const FILE = () => join(dataDir(), 'conversations.json');

interface FileShape {
	version: 1;
	conversations: Convo[];
	/** Last model chosen in the UI; new conversations inherit it. */
	lastModel?: string | null;
	/** Last thinking level chosen in the UI; new conversations inherit it. */
	lastThinking?: string | null;
}

let convs = new Map<string, Convo>();
let lastModel: string | null = null;
let lastThinking: string | null = null;
let loaded = false;
let saveTimer: NodeJS.Timeout | null = null;
let writeChain = Promise.resolve();

function load() {
	if (loaded) return;
	loaded = true;
	try {
		const raw = readFileSync(FILE(), 'utf8');
		const data = JSON.parse(raw) as FileShape;
		if (data.version === 1 && Array.isArray(data.conversations)) {
			for (const c of data.conversations) convs.set(c.id, c);
			lastModel = typeof data.lastModel === 'string' ? data.lastModel : null;
			lastThinking = typeof data.lastThinking === 'string' ? data.lastThinking : null;
		}
	} catch {
		/* first run or corrupt file — start empty */
	}
}

function queueWrite(): Promise<void> {
	if (!loaded) return Promise.resolve();
	const dir = dataDir();
	const tmp = join(dir, `.conversations.${process.pid}.tmp`);
	const payload: FileShape = {
		version: 1,
		conversations: [...convs.values()],
		lastModel,
		lastThinking
	};
	const serialized = JSON.stringify(payload, null, 1);
	writeChain = writeChain
		.then(async () => {
			await writeFile(tmp, serialized);
			await rename(tmp, FILE());
		})
		.catch(() => {
			/* best-effort */
		});
	return writeChain;
}

/** Debounced persist; safe to call on every event. */
export function scheduleSave() {
	load();
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = null;
		void queueWrite();
	}, 300);
}

export async function saveNow(): Promise<void> {
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	await queueWrite();
}

/* ---------------- CRUD ---------------- */

export function listConversations(): ConvoSummary[] {
	load();
	return [...convs.values()]
		.map((c) => ({
			id: c.id,
			title: c.title,
			updatedAt: c.updatedAt,
			model: c.model,
			thinking: c.thinking,
			itemCount: c.items.length
		}))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getConvo(id: string): Convo | null {
	load();
	return convs.get(id) ?? null;
}

export function createConvo(opts: { id?: string; title?: string } = {}): Convo {
	load();
	const id =
		opts.id ??
		(typeof crypto !== 'undefined' && 'randomUUID' in crypto
			? crypto.randomUUID()
			: Math.random().toString(36).slice(2));
	const now = Date.now();
	const convo: Convo = {
		id,
		title: opts.title?.trim() || 'New chat',
		// New conversations start with the latest model + thinking choices,
		// falling back to the app's configured defaults before any choice
		// has ever been made (see default-models.ts).
		model: lastModel ?? `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
		thinking: lastThinking ?? DEFAULT_THINKING,
		createdAt: now,
		updatedAt: now,
		items: []
	};
	convs.set(id, convo);
	scheduleSave();
	return convo;
}

export function deleteConvo(id: string): boolean {
	load();
	if (!convs.has(id)) return false;
	convs.delete(id);
	// Session file(s) for this conversation.
	try {
		const dir = sessionDir();
		for (const f of readdirSync(dir)) {
			if (f.endsWith(`_${id}.jsonl`)) rmSync(join(dir, f), { force: true });
		}
	} catch {
		/* ignore */
	}
	scheduleSave();
	return true;
}

/** Remove every conversation and its saved Pi session history. */
export function deleteAllConvos(): string[] {
	load();
	const ids = [...convs.keys()];
	if (ids.length === 0) return ids;
	convs.clear();
	try {
		const dir = sessionDir();
		for (const f of readdirSync(dir)) {
			if (f.endsWith('.jsonl')) rmSync(join(dir, f), { force: true });
		}
	} catch {
		/* ignore */
	}
	scheduleSave();
	return ids;
}

/* ---------------- last model/thinking choice ---------------- */

export function getLastModel(): string | null {
	load();
	return lastModel;
}

export function setLastModel(id: string | null) {
	load();
	lastModel = id;
	scheduleSave();
}

export function getLastThinking(): string | null {
	load();
	return lastThinking;
}

export function setLastThinking(level: string | null) {
	load();
	lastThinking = level;
	scheduleSave();
}

/** Title a conversation from its first user message (once). */
export function touchTitle(id: string, text: string) {
	load();
	const c = convs.get(id);
	if (!c || c.title !== 'New chat') return;
	const line = text
		.split('\n')
		.map((l) => l.trim())
		.find(Boolean);
	if (!line) return;
	c.title = line.length > 60 ? line.slice(0, 59) + '…' : line;
	scheduleSave();
}

/** Apply an update and optionally schedule persistence. Streaming runs save once at completion. */
export function applyEvent(id: string, apply: (c: Convo) => boolean | void, persist = true) {
	load();
	const c = convs.get(id);
	if (!c) return;
	if (apply(c) === false) return;
	c.updatedAt = Date.now();
	if (persist) scheduleSave();
}
