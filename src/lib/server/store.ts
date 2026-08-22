import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_THINKING } from './default-models';
import type { ContextInfo } from '../types';
import { writeJsonFile } from './async-json';
import { parseJsonFile } from './json-worker';
import { ShareRegistry, type StoredShare } from './share-registry';

/**
 * Conversation history store.
 *
 * - display history (items) lives in `<dataDir>/conversations.json`
 * - one share token per conversation lives in the same file
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

/** Stable shallow-deep snapshot of the mutable fields used by async writers and responses. */
export function snapshotConvo(convo: Convo): Convo {
	return {
		...convo,
		items: convo.items.map((item) => ({
			...item,
			...(item.images ? { images: item.images.map((image) => ({ ...image })) } : {}),
			...(item.details ? { details: { ...item.details } } : {})
		})),
		...(convo.lastContext ? { lastContext: { ...convo.lastContext } } : {})
	};
}

export function dataDir(): string {
	return process.env.PI_WEB_DATA_DIR || join(homedir(), '.pi-web');
}

export function sessionDir(): string {
	return join(dataDir(), 'sessions');
}

const FILE = () => join(dataDir(), 'conversations.json');

interface FileShape {
	version: 1;
	conversations: Convo[];
	/** Durable one-to-one conversation share pointers. */
	shares?: StoredShare[];
	/** Last model chosen in the UI; new conversations inherit it. */
	lastModel?: string | null;
	/** Last thinking level chosen in the UI; new conversations inherit it. */
	lastThinking?: string | null;
}

let convs = new Map<string, Convo>();
const shares = new ShareRegistry();
let lastModel: string | null = null;
let lastThinking: string | null = null;
let loaded = false;
let loadPromise: Promise<void> | null = null;
let saveTimer: NodeJS.Timeout | null = null;
let writeChain = Promise.resolve();

/** Load persistent state without doing filesystem work on the event loop. */
export function ensureStoreLoaded(): Promise<void> {
	if (loaded) return Promise.resolve();
	if (!loadPromise) {
		loadPromise = (async () => {
			await Promise.all([
				mkdir(dataDir(), { recursive: true }),
				mkdir(sessionDir(), { recursive: true })
			]);
			try {
				await access(FILE());
				const data = await parseJsonFile<FileShape>(FILE());
				if (data.version === 1 && Array.isArray(data.conversations)) {
					for (const c of data.conversations) convs.set(c.id, c);
					shares.load(data.shares, (id) => convs.has(id));
					lastModel = typeof data.lastModel === 'string' ? data.lastModel : null;
					lastThinking = typeof data.lastThinking === 'string' ? data.lastThinking : null;
				}
			} catch {
				/* first run or corrupt file - start empty */
			}
			loaded = true;
		})();
		loadPromise.catch(() => {
			loadPromise = null;
		});
	}
	return loadPromise;
}

function assertLoaded(): void {
	if (!loaded) throw new Error('Conversation store used before initialization.');
}

function queueWrite(): Promise<void> {
	if (!loaded) return Promise.resolve();
	const dir = dataDir();
	const tmp = join(dir, `.conversations.${process.pid}.tmp`);
	const payload: FileShape = {
		version: 1,
		// Capture a stable point-in-time view before the cooperative writer
		// yields and streaming events can mutate the live conversation objects.
		conversations: [...convs.values()].map(snapshotConvo),
		shares: shares.toJSON(),
		lastModel,
		lastThinking
	};
	writeChain = writeChain
		.then(async () => {
			await writeJsonFile(tmp, payload);
			await rename(tmp, FILE());
		})
		.catch(() => {
			/* best-effort */
		});
	return writeChain;
}

/** Debounced persist; safe to call on every event. */
export function scheduleSave() {
	assertLoaded();
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = null;
		void queueWrite();
	}, 300);
}

export async function saveNow(): Promise<void> {
	await ensureStoreLoaded();
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	await queueWrite();
}

/* ---------------- CRUD ---------------- */

export function listConversations(): ConvoSummary[] {
	assertLoaded();
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
	assertLoaded();
	return convs.get(id) ?? null;
}

/** Return the existing durable share token, or create exactly one for this conversation. */
export function getOrCreateShareToken(convoId: string, createToken: () => string): string | null {
	assertLoaded();
	if (!convs.has(convoId)) return null;
	const result = shares.getOrCreate(convoId, createToken);
	if (result.created) scheduleSave();
	return result.token;
}

/** Resolve a durable share token to its live conversation. */
export function getConvoByShareToken(token: string): Convo | null {
	assertLoaded();
	const convoId = shares.conversationIdFor(token);
	return convoId ? (convs.get(convoId) ?? null) : null;
}

export function createConvo(opts: { id?: string; title?: string } = {}): Convo {
	assertLoaded();
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

export async function deleteConvo(id: string): Promise<boolean> {
	assertLoaded();
	if (!convs.has(id)) return false;
	convs.delete(id);
	shares.deleteConversation(id);
	// Session file(s) for this conversation.
	try {
		const dir = sessionDir();
		const files = await readdir(dir);
		await Promise.all(
			files.filter((f) => f.endsWith(`_${id}.jsonl`)).map((f) => rm(join(dir, f), { force: true }))
		);
	} catch {
		/* ignore */
	}
	scheduleSave();
	return true;
}

/** Remove every conversation and its saved Pi session history. */
export async function deleteAllConvos(): Promise<string[]> {
	assertLoaded();
	const ids = [...convs.keys()];
	if (ids.length === 0) return ids;
	convs.clear();
	shares.clear();
	try {
		const dir = sessionDir();
		const files = await readdir(dir);
		await Promise.all(
			files.filter((f) => f.endsWith('.jsonl')).map((f) => rm(join(dir, f), { force: true }))
		);
	} catch {
		/* ignore */
	}
	scheduleSave();
	return ids;
}

/* ---------------- last model/thinking choice ---------------- */

export function getLastModel(): string | null {
	assertLoaded();
	return lastModel;
}

export function setLastModel(id: string | null) {
	assertLoaded();
	lastModel = id;
	scheduleSave();
}

export function getLastThinking(): string | null {
	assertLoaded();
	return lastThinking;
}

export function setLastThinking(level: string | null) {
	assertLoaded();
	lastThinking = level;
	scheduleSave();
}

/** Title a conversation from its first user message (once). */
export function touchTitle(id: string, text: string) {
	assertLoaded();
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
	assertLoaded();
	const c = convs.get(id);
	if (!c) return;
	if (apply(c) === false) return;
	c.updatedAt = Date.now();
	if (persist) scheduleSave();
}
