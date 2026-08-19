import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import type {
	AgentSession,
	AgentSessionEvent,
	CreateModelRuntimeOptions,
	InlineExtension,
	SessionMessageEntry
} from '@earendil-works/pi-coding-agent';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exaExtension } from './exa';
import {
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	DEFAULT_THINKING,
	modelsConfigFromEnv
} from './default-models';
import { asWebDetails, toolDetail, WEB_TOOL_NAMES, webDetailsFromOutput } from '../types';
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

/** Structural match for the SDK's (unexported) ImageContent type. */
type ImageContent = { type: 'image'; data: string; mimeType: string };

const toImageContent = (images: ImageAttachment[]): ImageContent[] =>
	images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType }));

export const MAX_IMAGES = 5;
/** Safety net against abuse; the client already downscales attachments well below this. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME_RE = /^image\/[a-z0-9.+-]+$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validate a request body's `images` field. Returns null on any malformed entry. */
export function parseImages(input: unknown): ImageAttachment[] | null {
	if (input === undefined) return [];
	if (!Array.isArray(input) || input.length > MAX_IMAGES) return null;
	const images: ImageAttachment[] = [];
	for (const entry of input) {
		const data = (entry as { data?: unknown })?.data;
		const mimeType = (entry as { mimeType?: unknown })?.mimeType;
		if (typeof data !== 'string' || typeof mimeType !== 'string') return null;
		if (!IMAGE_MIME_RE.test(mimeType) || !BASE64_RE.test(data)) return null;
		if (data.length * 0.75 > MAX_IMAGE_BYTES) return null;
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
let runtime: ModelRuntime | null = null;
let scopedSettings: SettingsManager | null = null;
let isolatedAgentDir: string | null = null;

type CredentialStore = NonNullable<CreateModelRuntimeOptions['credentials']>;
type Credential = Exclude<Awaited<ReturnType<CredentialStore['read']>>, undefined>;

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

/**
 * Settings manager whose global scope is the app data dir, NOT ~/.pi/agent.
 * Sessions persist their default model/thinking level on every change; scoping
 * them to the data dir keeps the host pi CLI config untouched.
 */
function getSettings(): SettingsManager {
	if (!scopedSettings) {
		scopedSettings = SettingsManager.create(dataDir(), dataDir());
		if (!scopedSettings.getDefaultProvider() && !scopedSettings.getDefaultModel()) {
			scopedSettings.setDefaultModelAndProvider(DEFAULT_PROVIDER, DEFAULT_MODEL);
		}
		if (!scopedSettings.getDefaultThinkingLevel()) {
			scopedSettings.setDefaultThinkingLevel(DEFAULT_THINKING);
		}
	}
	return scopedSettings;
}

/** Model type as exposed by the runtime (pi-ai is a transitive dep). */
type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;

/* ---------------- workspaces ---------------- */

/** Stable per-conversation temp workspace (survives restarts until tmp cleanup). */
export function workspaceFor(id: string): string {
	const dir = join(tmpdir(), `pi-web-${id}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function deleteWorkspace(id: string): void {
	try {
		rmSync(join(tmpdir(), `pi-web-${id}`), { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

/** Sweep stale workspaces, never touching live sessions. */
cleanupOldWorkspaces(new Set(sessions.keys()));

/* ---------------- model runtime ---------------- */

/**
 * Give the SDK an isolated config directory generated from environment
 * values. Nothing is discovered or copied from the host's ~/.pi directory.
 */
function getIsolatedAgentDir(): string {
	if (isolatedAgentDir) return isolatedAgentDir;
	isolatedAgentDir = mkdtempSync(join(tmpdir(), 'pi-web-agent-'));
	writeFileSync(
		join(isolatedAgentDir, 'models.json'),
		JSON.stringify(modelsConfigFromEnv(), null, 2)
	);
	return isolatedAgentDir;
}

async function makeRuntime(): Promise<ModelRuntime> {
	const agentDir = getIsolatedAgentDir();
	return await ModelRuntime.create({
		credentials: createEnvironmentCredentialStore(),
		modelsPath: join(agentDir, 'models.json'),
		modelsStorePath: join(agentDir, 'models-store.json')
	});
}

export async function getRuntime(): Promise<ModelRuntime> {
	if (!runtime) runtime = await makeRuntime();
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

/** Deterministic resource setup: bundled Exa extension only, no discovered extensions. */
async function makeResourceLoader(cwd: string) {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getIsolatedAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => chatSystemPrompt(),
		appendSystemPromptOverride: () => [],
		extensionFactories: [exaExtension, eventLoopYieldExtension]
	});
	await loader.reload();
	return loader;
}

/**
 * Resume the conversation's Pi session file if one exists, else create it.
 * File naming: `<timestamp>_<convoId>.jsonl` (see SessionManager).
 */
function sessionManagerFor(convoId: string, cwd: string): SessionManager {
	const dir = sessionDir();
	const existing = readdirSync(dir)
		.filter((f) => f.endsWith(`_${convoId}.jsonl`))
		.sort()
		.at(-1);
	if (existing) return SessionManager.open(join(dir, existing), dir, cwd);
	return SessionManager.create(cwd, dir, { id: convoId });
}

/** Get (or lazily create) the live session for a conversation. */
export async function getSession(id: string, convo: Convo): Promise<PiSession> {
	const existing = sessions.get(id);
	if (existing) {
		existing.lastUsed = Date.now();
		return existing;
	}

	const cwd = workspaceFor(id);
	// Pass the conversation's model + thinking level INTO createAgentSession:
	// the SDK clamps the level against the chosen model. Post-hoc
	// setThinkingLevel would clamp against the session's fallback model, and
	// an un-awaited setModel could race the level application.
	const model = convo.model ? await resolveModelId(convo.model) : null;
	const sessionManager = sessionManagerFor(id, cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: getIsolatedAgentDir(),
		sessionManager,
		modelRuntime: await getRuntime(),
		resourceLoader: await makeResourceLoader(cwd),
		settingsManager: getSettings(),
		...(model ? { model } : {}),
		...(convo.thinking ? { thinkingLevel: convo.thinking as ThinkingLevel } : {}),
		...sessionToolOptions
	});

	const pi: PiSession = { agent: session, cwd, busy: false, sessionManager, lastUsed: Date.now() };
	sessions.set(id, pi);
	return pi;
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
export function disposeSession(id: string): void {
	const s = sessions.get(id);
	if (s) {
		sessions.delete(id);
		try {
			s.agent.dispose();
		} catch {
			/* best-effort */
		}
	}
	deleteWorkspace(id);
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
