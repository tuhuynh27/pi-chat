import {
	createAgentSession,
	DefaultResourceLoader,
	migrateSessionEntries,
	ModelRuntime,
	SessionManager,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import type {
	AgentSession,
	AgentSessionEvent,
	CreateModelRuntimeOptions,
	FileEntry,
	InlineExtension,
	SessionMessageEntry
} from '@earendil-works/pi-coding-agent';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exaExtension } from './exa';
import {
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	DEFAULT_THINKING,
	modelsConfigFromEnv
} from './default-models';
import {
	asWebDetails,
	toolDetail,
	WEB_TOOL_NAMES,
	webDetailsFromOutput,
	type ContextInfo
} from '../types';
import { coalesceDeltas } from './sse';
import {
	applyEvent,
	dataDir,
	getConvo,
	sessionDir,
	THINKING_CAP,
	type Convo,
	type ImageAttachment
} from './store';
import { cleanupOldWorkspaces } from './workspace';
import { streamingJsonBody, writeJsonLinesFile } from './async-json';
import { parseJsonFile } from './json-worker';

/** Structural match for the SDK's (unexported) ImageContent type. */
type ImageContent = { type: 'image'; data: string; mimeType: string };

const toImageContent = (images: ImageAttachment[]): ImageContent[] =>
	images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType }));

export const MAX_IMAGES = 5;
// No per-image byte cap: the request as a whole is bounded by the adapter's
// BODY_SIZE_LIMIT (see Dockerfile), and the client downscales to 1568px.
const IMAGE_MIME_RE = /^image\/[a-z0-9.+-]+$/i;
const BASE64_CHUNK_RE = /^[A-Za-z0-9+/]+$/;
const BASE64_VALIDATION_CHUNK_SIZE = 64 * 1024;

/** Validate a request body's `images` field. Returns null on any malformed entry. */
export async function parseImages(input: unknown): Promise<ImageAttachment[] | null> {
	if (input === undefined) return [];
	if (!Array.isArray(input) || input.length > MAX_IMAGES) return null;
	const images: ImageAttachment[] = [];
	for (const entry of input) {
		const data = (entry as { data?: unknown })?.data;
		const mimeType = (entry as { mimeType?: unknown })?.mimeType;
		if (typeof data !== 'string' || typeof mimeType !== 'string') return null;
		if (!IMAGE_MIME_RE.test(mimeType) || data.length === 0) return null;
		const paddingLength = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
		const contentEnd = data.length - paddingLength;
		if (contentEnd === 0) return null;
		for (let offset = 0; offset < contentEnd; offset += BASE64_VALIDATION_CHUNK_SIZE) {
			if (!BASE64_CHUNK_RE.test(data.slice(offset, offset + BASE64_VALIDATION_CHUNK_SIZE))) {
				return null;
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		images.push({ data, mimeType });
	}
	return images;
}

/**
 * Per-conversation Pi agent sessions.
 *
 * - each conversation gets its own workspace ($TMPDIR/pi-web-<convoId>)
 * - each conversation's LLM context lives in a Pi session file
 *   (<dataDir>/sessions/*_<convoId>.jsonl) and is restored on restart
 * - sessions are created lazily and kept in memory
 */

/** True when the server runs under the seatbelt sandbox (sandbox-start.sh sets the flag). */
export function isSandboxed(): boolean {
	return process.env.PI_WEB_SANDBOX === '1';
}

/** Chat-only: no file, shell, or machine tools. Exa search/fetch stay enabled. */
const sessionToolOptions = { tools: ['web_search_exa', 'web_fetch_exa'] };

function formatNow(): string {
	return new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZoneName: 'short'
	}).format(new Date());
}

function chatSystemPrompt(): string {
	return `You are a helpful assistant in a web chat app. Reply in the conversation.

You cannot read, write, or edit files, run shell commands, or perform any machine operations. Do not try to use file or coding-agent tools.

Available tools:
- web_search_exa: Search the web and return relevant results with source highlights
- web_fetch_exa: Fetch clean markdown content from one or more web pages

Guidelines:
- Put all answers, explanations, and code in the chat reply. Never save code, solutions, or notes to a file.
- When looking up information — facts, figures, news, people, products, quotes, dates, or anything that could be outdated or uncertain — you MUST use web_search_exa. Do not rely on memory for those.
- After searching, use web_fetch_exa on the most relevant sources and carefully fact-check before answering. Prefer primary or recent sources. If sources disagree or you cannot verify something, say so.
- Do not invent citations or URLs. Skip the tools only for pure reasoning, writing, or coding that needs no outside facts.
- Be concise.

Current date and time: ${formatNow()}`;
}

export interface PiSession {
	agent: AgentSession;
	cwd: string;
	/** True while a prompt is running */
	busy: boolean;
	/** Same instance passed into createAgentSession; kept for tree lookups (retry). */
	sessionManager: SessionManager;
	/** Last time this session was fetched or finished a run (idle eviction). */
	lastUsed: number;
	/** Flush the SDK session history through the non-blocking persistence adapter. */
	flushSession: () => Promise<void>;
}

/**
 * Abort a run when the provider stream stalls: no progress event for this
 * long (deltas, tool activity, completed messages — NOT errors or the SDK's
 * auto-retry bookkeeping, so a stall→retry→stall cycle is bounded by this
 * total, not per attempt). The check pauses while a tool executes. 0 disables.
 *
 * Without this, a provider that accepts the request and then goes silent
 * holds `busy` for up to ~20 minutes (undici's 300s idle timeout × the SDK's
 * auto-retries), leaving the conversation unusable the whole time.
 */
function stallTimeoutFromEnv(): number {
	const raw = Number(process.env.PI_WEB_STALL_TIMEOUT_MS);
	if (!Number.isFinite(raw)) return 180_000;
	if (raw === 0) return 0;
	return Math.max(raw, 30_000);
}
const STALL_TIMEOUT_MS = stallTimeoutFromEnv();

const sessions = new Map<string, PiSession>();
let runtime: Promise<ModelRuntime> | null = null;
let scopedSettings: SettingsManager | null = null;
let isolatedAgentDir: Promise<string> | null = null;

type CredentialStore = NonNullable<CreateModelRuntimeOptions['credentials']>;
type Credential = Exclude<Awaited<ReturnType<CredentialStore['read']>>, undefined>;
type ModelsStore = NonNullable<CreateModelRuntimeOptions['modelsStore']>;
type ModelsStoreEntry = Exclude<Awaited<ReturnType<ModelsStore['read']>>, undefined>;

/** Volatile store prevents the SDK from consulting or writing auth.json. */
function createEnvironmentCredentialStore(): CredentialStore {
	const credentials = new Map<string, Credential>();
	return {
		async read(providerId, options) {
			options?.signal?.throwIfAborted();
			return credentials.get(providerId);
		},
		async list(options) {
			options?.signal?.throwIfAborted();
			return [...credentials].map(([providerId, credential]) => ({
				providerId,
				type: credential.type
			}));
		},
		async modify(providerId, modify, options) {
			options?.signal?.throwIfAborted();
			const next = await modify(credentials.get(providerId));
			options?.signal?.throwIfAborted();
			if (next) credentials.set(providerId, next);
			return next;
		},
		async delete(providerId, options) {
			options?.signal?.throwIfAborted();
			credentials.delete(providerId);
		}
	};
}

/** The app uses a static environment catalog, so no file-backed model cache is needed. */
function createMemoryModelsStore(): ModelsStore {
	const entries = new Map<string, ModelsStoreEntry>();
	return {
		async read(providerId, options) {
			options?.signal?.throwIfAborted();
			const entry = entries.get(providerId);
			return entry ? structuredClone(entry) : undefined;
		},
		async write(providerId, entry, options) {
			options?.signal?.throwIfAborted();
			entries.set(providerId, structuredClone(entry));
		},
		async delete(providerId, options) {
			options?.signal?.throwIfAborted();
			entries.delete(providerId);
		}
	};
}

/** SDK settings stay in memory; the conversation store owns persisted choices. */
function getSettings(): SettingsManager {
	if (!scopedSettings) {
		// The app persists these choices in its own store. Keeping SDK settings
		// in memory avoids its synchronous file-backed settings implementation.
		scopedSettings = SettingsManager.inMemory({
			defaultProvider: DEFAULT_PROVIDER,
			defaultModel: DEFAULT_MODEL,
			defaultThinkingLevel: DEFAULT_THINKING
		});
	}
	return scopedSettings;
}

/** Model type as exposed by the runtime (pi-ai is a transitive dep). */
type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;

/* ---------------- workspaces ---------------- */

/** Stable per-conversation temp workspace (survives restarts until tmp cleanup). */
export async function workspaceFor(id: string): Promise<string> {
	const dir = join(tmpdir(), `pi-web-${id}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

export async function deleteWorkspace(id: string): Promise<void> {
	try {
		await rm(join(tmpdir(), `pi-web-${id}`), { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

/** Sweep stale workspaces, never touching live sessions. */
void cleanupOldWorkspaces(new Set(sessions.keys()));

/* ---------------- model runtime ---------------- */

/**
 * Give the SDK an isolated config directory generated from environment
 * values. Nothing is discovered or copied from the host's ~/.pi directory.
 */
function getIsolatedAgentDir(): Promise<string> {
	if (!isolatedAgentDir) {
		isolatedAgentDir = (async () => {
			const dir = await mkdtemp(join(tmpdir(), 'pi-web-agent-'));
			await writeFile(join(dir, 'models.json'), JSON.stringify(modelsConfigFromEnv(), null, 2));
			return dir;
		})();
		isolatedAgentDir.catch(() => {
			isolatedAgentDir = null;
		});
	}
	return isolatedAgentDir;
}

async function makeRuntime(): Promise<ModelRuntime> {
	const agentDir = await getIsolatedAgentDir();
	return await ModelRuntime.create({
		credentials: createEnvironmentCredentialStore(),
		modelsPath: join(agentDir, 'models.json'),
		modelsStore: createMemoryModelsStore(),
		refreshOnCreate: false
	});
}

export async function getRuntime(): Promise<ModelRuntime> {
	if (!runtime) {
		runtime = makeRuntime();
		runtime.catch(() => {
			runtime = null;
		});
	}
	return runtime;
}

/* ---------------- sessions ---------------- */

/**
 * The SDK delivers already-buffered LLM tokens as a chain of resolved
 * promises (microtasks). Without a macrotask yield, a fast burst starves
 * the Node event loop — incoming HTTP (the HTML shell, JS, /api/*) sits
 * pending until generation finishes. A refresh mid-run then looks like a
 * dead static server.
 */
const eventLoopYieldExtension: InlineExtension = {
	name: 'event-loop-yield',
	factory: (api) => {
		let n = 0;
		api.on('message_update', async () => {
			if (++n % 8 !== 0) return;
			await new Promise<void>((resolve) => setImmediate(resolve));
		});
	}
};

const STREAM_PROVIDER_BODY_THRESHOLD = 256 * 1024;

function containsLargeString(value: unknown): boolean {
	const pending = [value];
	const seen = new WeakSet<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (typeof current === 'string') {
			if (current.length > STREAM_PROVIDER_BODY_THRESHOLD) return true;
			continue;
		}
		if (!current || typeof current !== 'object' || seen.has(current)) continue;
		seen.add(current);
		pending.push(...Object.values(current));
	}
	return false;
}

/** Stream large OpenAI-compatible payloads so historical images do not freeze Node. */
const streamingProviderBodyExtension: InlineExtension = {
	name: 'streaming-provider-body',
	factory: (api) => {
		api.on('before_provider_headers', (event, context) => {
			if (context.model?.api !== 'openai-completions') return;
			const hasContentType = Object.keys(event.headers).some(
				(name) => name.toLowerCase() === 'content-type'
			);
			if (!hasContentType) event.headers['content-type'] = 'application/json';
		});
		api.on('before_provider_request', (event, context) => {
			const payload = event.payload as { stream?: unknown; messages?: unknown } | null;
			if (
				context.model?.api !== 'openai-completions' ||
				!payload ||
				payload.stream !== true ||
				!Array.isArray(payload.messages) ||
				!containsLargeString(payload)
			) {
				return;
			}
			return streamingJsonBody(payload);
		});
	}
};

/** Deterministic resource setup: bundled Exa extension only, no discovered extensions. */
async function makeResourceLoader(cwd: string) {
	const agentDir = await getIsolatedAgentDir();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => chatSystemPrompt(),
		appendSystemPromptOverride: () => [],
		extensionFactories: [exaExtension, eventLoopYieldExtension, streamingProviderBodyExtension]
	});
	await loader.reload();
	return loader;
}

/**
 * Resume the conversation's Pi session file if one exists, else create it.
 * File naming: `<timestamp>_<convoId>.jsonl` (see SessionManager).
 */
async function sessionManagerFor(convoId: string, cwd: string): Promise<SessionManager> {
	const dir = sessionDir();
	const existing = (await readdir(dir))
		.filter((f) => f.endsWith(`_${convoId}.jsonl`))
		.sort()
		.at(-1);
	if (existing) {
		const path = join(dir, existing);
		let entries = await parseJsonFile<FileEntry[]>(path, 'jsonl');
		const header = entries[0];
		if (!header || header.type !== 'session' || typeof header.id !== 'string') entries = [];
		else migrateSessionEntries(entries);

		// The SDK constructor accepts preloaded entries internally. Supplying the
		// worker-parsed data avoids SessionManager.open() synchronously reading and
		// parsing the entire JSONL file on the HTTP event loop.
		type PreloadedSessionManager = new (
			cwd: string,
			sessionDir: string,
			sessionFile: string,
			persist: boolean,
			options: undefined,
			entries: FileEntry[]
		) => SessionManager;
		const Constructor = SessionManager as unknown as PreloadedSessionManager;
		return new Constructor(cwd, dir, path, true, undefined, entries);
	}
	return SessionManager.create(cwd, dir, { id: convoId });
}

/**
 * The SDK persists every session entry with appendFileSync and JSON.stringify.
 * Image messages can be tens of megabytes, making that path freeze every HTTP
 * request. Replace its public persistence hook with an atomic, cooperative
 * JSONL writer while retaining the SessionManager's in-memory tree behavior.
 */
function useAsyncSessionPersistence(manager: SessionManager): () => Promise<void> {
	const path = manager.getSessionFile();
	if (!path) return async () => undefined;

	const tmp = `${path}.${process.pid}.tmp`;
	let timer: NodeJS.Timeout | null = null;
	let dirty = false;
	let writeChain = Promise.resolve();

	const flush = async (): Promise<void> => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (!dirty) {
			await writeChain;
			return;
		}

		dirty = false;
		const header = manager.getHeader();
		const entries = [...(header ? [header] : []), ...manager.getEntries()];
		writeChain = writeChain
			.then(async () => {
				await writeJsonLinesFile(tmp, entries);
				await rename(tmp, path);
			})
			.catch((error) => {
				console.error(`session persistence failed: ${error instanceof Error ? error.message : error}`);
			});
		await writeChain;
		if (dirty) await flush();
	};

	const schedule = () => {
		dirty = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, 100);
	};

	manager._persist = schedule;
	return flush;
}

const sessionCreations = new Map<string, Promise<PiSession>>();

/** Get (or lazily create) the live session for a conversation. */
export async function getSession(id: string, convo: Convo): Promise<PiSession> {
	const existing = sessions.get(id);
	if (existing) {
		existing.lastUsed = Date.now();
		return existing;
	}
	const pending = sessionCreations.get(id);
	if (pending) return pending;

	const creating = (async () => {
		const cwd = await workspaceFor(id);
		// Pass the conversation's model + thinking level INTO createAgentSession:
		// the SDK clamps the level against the chosen model. Post-hoc
		// setThinkingLevel would clamp against the session's fallback model, and
		// an un-awaited setModel could race the level application.
		const model = convo.model ? await resolveModelId(convo.model) : null;
		const sessionManager = await sessionManagerFor(id, cwd);
		const flushSession = useAsyncSessionPersistence(sessionManager);
		const agentDir = await getIsolatedAgentDir();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager,
			modelRuntime: await getRuntime(),
			resourceLoader: await makeResourceLoader(cwd),
			settingsManager: getSettings(),
			...(model ? { model } : {}),
			...(convo.thinking ? { thinkingLevel: convo.thinking as ThinkingLevel } : {}),
			...sessionToolOptions
		});

		const pi: PiSession = {
			agent: session,
			cwd,
			busy: false,
			sessionManager,
			lastUsed: Date.now(),
			flushSession
		};
		sessions.set(id, pi);
		return pi;
	})();
	sessionCreations.set(id, creating);
	try {
		return await creating;
	} finally {
		sessionCreations.delete(id);
	}
}

/**
 * Evict sessions idle for over an hour: each AgentSession holds its full
 * message history in RAM and the map never shrinks otherwise. The session
 * file and workspace stay on disk, so the next message resumes seamlessly.
 */
const SESSION_IDLE_MS = 60 * 60 * 1000;
setInterval(
	() => {
		const cutoff = Date.now() - SESSION_IDLE_MS;
		for (const [id, s] of sessions) {
			if (s.busy || s.lastUsed > cutoff) continue;
			sessions.delete(id);
			void s.flushSession();
			try {
				s.agent.dispose();
			} catch {
				/* best-effort */
			}
		}
	},
	10 * 60 * 1000
).unref();

/** Dispose a live session and its workspace (conversation deleted). */
export async function disposeSession(id: string): Promise<void> {
	const pending = sessionCreations.get(id);
	if (pending) await pending.catch(() => undefined);
	const s = sessions.get(id);
	if (s) {
		sessions.delete(id);
		await s.flushSession();
		try {
			s.agent.dispose();
		} catch {
			/* best-effort */
		}
	}
	await deleteWorkspace(id);
}

export function isBusy(id: string): boolean {
	return sessions.get(id)?.busy ?? false;
}

/**
 * Atomically claim a session for a run. Routes must claim BEFORE any await
 * between the busy check and runPrompt() (retry awaits navigateTree there);
 * two concurrent requests could otherwise both pass the check and interleave.
 * runPrompt()'s finally releases the claim; a caller that claims but bails
 * before runPrompt must call releaseRun().
 */
export function claimRun(pi: PiSession): boolean {
	if (pi.busy) return false;
	pi.busy = true;
	return true;
}

export function releaseRun(pi: PiSession): void {
	pi.busy = false;
}

export function busyIds(): string[] {
	return [...sessions.entries()].filter(([, s]) => s.busy).map(([id]) => id);
}

/** Look up a live session without creating one (for read-only attach). */
export function getLiveSession(id: string): PiSession | null {
	return sessions.get(id) ?? null;
}

/* ---------------- run-completion notifier (for /api/attach) ---------------- */

const doneListeners = new Map<string, Set<(ok: boolean) => void>>();

/** Fire once the next time `notifyDone` is called for this conversation. */
export function onceDone(id: string, cb: (ok: boolean) => void): () => void {
	let set = doneListeners.get(id);
	if (!set) {
		set = new Set();
		doneListeners.set(id, set);
	}
	set.add(cb);
	return () => set!.delete(cb);
}

function notifyDone(id: string, ok: boolean): void {
	const set = doneListeners.get(id);
	if (!set || set.size === 0) return;
	doneListeners.delete(id);
	for (const cb of set) cb(ok);
}

export interface RetryTarget {
	/** Index in convo.items of the user turn being retried (everything from here on is discarded). */
	userIdx: number;
	/** Stored text of that user turn (fallback resend text if it was never recorded in the session). */
	text: string;
	/** Stored image attachments of that user turn, if any (navigateTree only returns text, so these are resent as-is). */
	images?: ImageAttachment[];
	/**
	 * Session entry id of that user message, for AgentSession.navigateTree().
	 * Null when the original attempt failed before the SDK persisted anything
	 * (e.g. no model/API key configured) — the session has no matching entry
	 * to navigate to, so retry just resends `text` directly.
	 */
	entryId: string | null;
}

/**
 * Resolve a retry click (on a user, assistant, or error item) to the user
 * turn it belongs to: walk back to the nearest user item, then find that
 * item's matching session entry by ordinal position among user messages in
 * the active branch. Conversation items and the session's user-message
 * entries stay in 1:1 order since this app only ever appends turns linearly.
 */
export function resolveRetryTarget(pi: PiSession, convo: Convo, index: number): RetryTarget | null {
	const items = convo.items;
	let userIdx = index;
	while (userIdx >= 0 && items[userIdx]?.role !== 'user') userIdx--;
	if (userIdx < 0) return null;
	const text = items[userIdx].text ?? '';
	if (!text) return null;

	let ordinal = 0;
	for (let i = 0; i <= userIdx; i++) if (items[i].role === 'user') ordinal++;

	const userEntries = pi.sessionManager
		.getBranch()
		.filter((e): e is SessionMessageEntry => e.type === 'message' && e.message.role === 'user');
	const entry = userEntries[ordinal - 1];
	return { userIdx, text, images: items[userIdx].images, entryId: entry?.id ?? null };
}

/**
 * True for events that show the run is actually moving: streamed content,
 * tool activity, or a message that completed cleanly. Errors, aborts, and the
 * SDK's auto-retry bookkeeping deliberately do NOT count, so the stall
 * watchdog bounds a stall→retry→stall cycle as one continuous stall.
 * Compaction/summarization markers count — those runs stream no deltas.
 */
function isProgressEvent(e: AgentSessionEvent): boolean {
	switch (e.type) {
		case 'message_update':
		case 'tool_execution_start':
		case 'tool_execution_end':
		case 'compaction_end':
		case 'summarization_retry_attempt_start':
		case 'summarization_retry_finished':
			return true;
		case 'message_end': {
			const msg = e.message as { stopReason?: string };
			return msg.stopReason !== 'error' && msg.stopReason !== 'aborted';
		}
		default:
			return false;
	}
}

export interface UsageEventData {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	context: ContextInfo | null;
}

/**
 * Payload for the `usage` SSE event, emitted after each finished assistant
 * message: the message's server-reported token counts (the client uses
 * `output` to finalize its token/s reading) plus the session's current
 * context usage. Returns null for events that carry no usage.
 */
export function usageEventData(pi: PiSession, e: AgentSessionEvent): UsageEventData | null {
	if (e.type !== 'message_end') return null;
	const msg = e.message as {
		role?: string;
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	};
	if (msg.role !== 'assistant' || !msg.usage) return null;
	return {
		input: msg.usage.input ?? 0,
		output: msg.usage.output ?? 0,
		cacheRead: msg.usage.cacheRead ?? 0,
		cacheWrite: msg.usage.cacheWrite ?? 0,
		context: contextUsage(pi)
	};
}

/** Current context usage of a live session, or null when unavailable. */
export function contextUsage(pi: PiSession): ContextInfo | null {
	try {
		const ctx = pi.agent.getContextUsage();
		if (!ctx) return null;
		return { tokens: ctx.tokens, contextWindow: ctx.contextWindow, percent: ctx.percent };
	} catch {
		return null;
	}
}

/**
 * Run a prompt against a live session: mirrors agent events into SSE frames
 * (via `send`) and into the stored history. Shared by /api/chat and
 * /api/retry. Returns false if the prompt itself threw.
 */
export async function runPrompt(
	convoId: string,
	pi: PiSession,
	text: string,
	send: (event: string, data: unknown) => void,
	images?: ImageAttachment[]
): Promise<boolean> {
	pi.busy = true;
	const out = coalesceDeltas(send);
	let lastProgress = Date.now();
	let runningTools = 0;
	let stalled = false;
	const unsubscribe = pi.agent.subscribe((e) => {
		if (e.type === 'tool_execution_start') runningTools++;
		else if (e.type === 'tool_execution_end') runningTools = Math.max(0, runningTools - 1);
		if (isProgressEvent(e)) lastProgress = Date.now();
		// After a watchdog abort our stall error already explains the outcome;
		// drop the SDK's generic "Request was aborted" message_end.
		if (stalled && e.type === 'message_end') return;
		applyToConvo(convoId, e);
		for (const sse of toSseEvents(e)) out.send(sse.event, sse.data);
		const usage = usageEventData(pi, e);
		if (usage) {
			if (usage.context) {
				const context = usage.context;
				applyEvent(convoId, (c) => {
					c.lastContext = context;
				}, false);
			}
			out.send('usage', usage);
		}
	});
	// Stall watchdog: the provider stack has no reliable mid-stream idle
	// timeout on the SDK path (undici's 300s default fires eventually, but the
	// SDK auto-retries the "terminated" error, so a dead provider can hold the
	// conversation for ~20 minutes). Abort with a clear error instead.
	const watchdog =
		STALL_TIMEOUT_MS > 0
			? setInterval(() => {
					if (runningTools > 0) {
						// Tools run without emitting events; don't count that as a stall.
						lastProgress = Date.now();
						return;
					}
					if (Date.now() - lastProgress < STALL_TIMEOUT_MS) return;
					stalled = true;
					const message = `No response from the model provider for ${Math.round(STALL_TIMEOUT_MS / 1000)}s - run aborted. Try again, or switch models.`;
					applyEvent(convoId, (c) => {
						c.items.push({ role: 'error', text: message });
					});
					out.send('message_error', { message });
					void pi.agent.abort();
				}, 5_000)
			: null;
	let ok = true;
	try {
		await pi.agent.prompt(text, images?.length ? { images: toImageContent(images) } : undefined);
	} catch (err) {
		ok = false;
		out.send('error', { message: err instanceof Error ? err.message : String(err) });
	} finally {
		if (watchdog) clearInterval(watchdog);
		unsubscribe();
		out.flush();
		await pi.flushSession();
		pi.busy = false;
		pi.lastUsed = Date.now();
		notifyDone(convoId, ok);
	}
	return ok;
}

/** Abort a conversation (or the first busy one when id is omitted). */
export function abort(id?: string): boolean {
	const targets = id ? [sessions.get(id)] : [...sessions.values()];
	for (const s of targets) {
		if (s?.busy) {
			void s.agent.abort();
			return true;
		}
	}
	return false;
}

/* ---------------- model catalog ---------------- */

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
}

export async function listModels(): Promise<ModelInfo[]> {
	// Snapshot only. getAvailable() re-checks every built-in provider and can
	// stall the request — the loading screen used to await this on every load.
	const models = (await getRuntime()).getAvailableSnapshot();
	return models
		.map((m) => ({
			id: `${m.provider}/${m.id}`,
			name: m.name,
			provider: m.provider,
			reasoning: m.reasoning
		}))
		.sort((a, b) => {
			const preferred = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
			if (a.id === preferred) return -1;
			if (b.id === preferred) return 1;
			return 0;
		});
}

/** Resolve a "provider/model-id" id to a Model, or null. */
export async function resolveModelId(id: string): Promise<Model | null> {
	const idx = id.indexOf('/');
	if (idx < 0) return null;
	const provider = id.slice(0, idx);
	const modelId = id.slice(idx + 1);
	return (await getRuntime()).getModel(provider, modelId) ?? null;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function isValidThinkingLevel(v: unknown): v is ThinkingLevel {
	return typeof v === 'string' && (THINKING_LEVELS as string[]).includes(v);
}

/* ------------------------------------------------------------------ */
/* SSE event mapping + stored-history updates                          */
/* ------------------------------------------------------------------ */

export type SseEvent =
	| { event: 'delta'; data: { text: string } }
	| { event: 'thinking'; data: { text: string } }
	| { event: 'thinking_end'; data: Record<string, never> }
	| { event: 'tool_start'; data: { id: string; name: string; args: unknown } }
	| { event: 'tool_end'; data: { id: string; name: string; isError: boolean; output: string; details?: Record<string, unknown> | null } }
	| { event: 'message_error'; data: { message: string } }
	| { event: 'retry'; data: { attempt: number; maxAttempts: number; delayMs: number } }
	| { event: 'done'; data: { ok: boolean } }
	| { event: 'error'; data: { message: string } };

/** Tools whose structured `details` payload is forwarded to the client. */
const VISUAL_TOOLS = WEB_TOOL_NAMES;

/** Extract a JSON-serializable copy of a tool result's `details`, if any. */
function safeDetails(result: unknown): Record<string, unknown> | null {
	try {
		const d = (result as { details?: unknown })?.details;
		if (d === undefined || d === null) return null;
		return JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function toolOutput(result: unknown): string {
	try {
		const content = (result as { content?: { type: string; text?: string }[] })?.content;
		if (!Array.isArray(content)) return '';
		return content
			.filter((c) => c?.type === 'text' && typeof c.text === 'string')
			.map((c) => c.text)
			.join('\n')
			.slice(0, 4000);
	} catch {
		return '';
	}
}

/** Convert one AgentSessionEvent into zero or more SSE events. */
export function toSseEvents(e: AgentSessionEvent): SseEvent[] {
	switch (e.type) {
		case 'message_update': {
			const m = e.assistantMessageEvent;
			if (m.type === 'text_delta') return [{ event: 'delta', data: { text: m.delta } }];
			if (m.type === 'thinking_delta') return [{ event: 'thinking', data: { text: m.delta } }];
			if (m.type === 'thinking_end') return [{ event: 'thinking_end', data: {} }];
			return [];
		}
		case 'tool_execution_start':
			return [{ event: 'tool_start', data: { id: e.toolCallId, name: e.toolName, args: e.args } }];
		case 'tool_execution_end':
			return [
				{
					event: 'tool_end',
					data: {
						id: e.toolCallId,
						name: e.toolName,
						isError: e.isError,
						output: toolOutput(e.result),
						...(VISUAL_TOOLS.has(e.toolName)
							? {
									details:
										(asWebDetails(safeDetails(e.result), e.toolName) as Record<string, unknown> | undefined) ??
										null
								}
							: {})
					}
				}
			];
		case 'message_end': {
			const msg = e.message as { role?: string; stopReason?: string; errorMessage?: string };
			if (msg.role === 'assistant' && (msg.stopReason === 'error' || msg.stopReason === 'aborted')) {
				if (msg.errorMessage) return [{ event: 'message_error', data: { message: msg.errorMessage } }];
			}
			return [];
		}
		case 'auto_retry_start':
			// The SDK is retrying a transient provider error; the message_error
			// just forwarded is superseded (the client drops its error bubble).
			return [
				{
					event: 'retry',
					data: { attempt: e.attempt, maxAttempts: e.maxAttempts, delayMs: e.delayMs }
				}
			];
		default:
			return [];
	}
}

/**
 * Mirror one event into the conversation's stored items (same rules as the
 * client: text after a tool row starts a fresh assistant bubble). The store
 * is the source of truth, so runs keep updating history even when the SSE
 * client navigates away.
 */
export function applyToConvo(id: string, e: AgentSessionEvent): void {
	if (
		e.type === 'message_update' &&
		e.assistantMessageEvent.type !== 'text_delta' &&
		e.assistantMessageEvent.type !== 'thinking_delta'
	) {
		return;
	}
	if (e.type === 'message_end') {
		const msg = e.message as { role?: string; stopReason?: string; errorMessage?: string };
		if (
			msg.role !== 'assistant' ||
			(msg.stopReason !== 'error' && msg.stopReason !== 'aborted') ||
			!msg.errorMessage
		) {
			return;
		}
	}
	if (
		e.type !== 'message_update' &&
		e.type !== 'tool_execution_start' &&
		e.type !== 'tool_execution_end' &&
		e.type !== 'message_end' &&
		e.type !== 'auto_retry_start'
	) {
		return;
	}
	applyEvent(
		id,
		(c) => {
			switch (e.type) {
				case 'message_update': {
					const m = e.assistantMessageEvent;
					if (m.type !== 'text_delta' && m.type !== 'thinking_delta') return;
					let a = c.items[c.items.length - 1];
					if (!a || a.role !== 'assistant') {
						a = { role: 'assistant', text: '', thinking: '' };
						c.items.push(a);
					}
					if (m.type === 'text_delta') {
						a.text = (a.text ?? '') + m.delta;
					} else {
						a.thinking = ((a.thinking ?? '') + m.delta).slice(-THINKING_CAP);
					}
					break;
				}
				case 'tool_execution_start':
					c.items.push({
						id: e.toolCallId,
						role: 'tool',
						name: e.toolName,
						detail: toolDetail(e.toolName, e.args),
						status: 'running',
						output: ''
					});
					break;
				case 'tool_execution_end': {
					const t =
						c.items.find((i) => i.role === 'tool' && i.id === e.toolCallId) ??
						[...c.items]
							.reverse()
							.find((i) => i.role === 'tool' && i.status === 'running' && i.name === e.toolName);
					if (!t) return false;
					t.status = e.isError ? 'error' : 'done';
					t.output = toolOutput(e.result);
					const raw = VISUAL_TOOLS.has(e.toolName) ? safeDetails(e.result) : null;
					const details = asWebDetails(raw, e.toolName) ?? webDetailsFromOutput(t.output, e.toolName);
					if (details) t.details = details as unknown as Record<string, unknown>;
					break;
				}
				case 'message_end': {
					const msg = e.message as { role?: string; stopReason?: string; errorMessage?: string };
					if (
						msg.role === 'assistant' &&
						(msg.stopReason === 'error' || msg.stopReason === 'aborted') &&
						msg.errorMessage
					) {
						c.items.push({ role: 'error', text: msg.errorMessage });
					}
					break;
				}
				case 'auto_retry_start': {
					// Retrying: the trailing error item from the failed attempt is
					// superseded (the final failure, if any, will push a fresh one).
					const last = c.items[c.items.length - 1];
					if (last?.role === 'error') c.items.pop();
					break;
				}
				default:
					break;
			}
		},
		false
	);
}

/** Re-export for routes that need to look up conversations. */
export { getConvo, dataDir };
