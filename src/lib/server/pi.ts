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
import { toolDetail } from '../types';
import { applyEvent, dataDir, getConvo, sessionDir, THINKING_CAP, type Convo } from './store';
import { cleanupOldWorkspaces } from './workspace';

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

const sandboxed = isSandboxed();

/**
 * In sandbox mode the bash tool is dropped: the seatbelt profile denies all
 * process spawns, so it could never run anyway. Other tools stay — seatbelt
 * blocks their writes outside the temp dir at the OS level.
 */
const sessionToolOptions = sandboxed ? { excludeTools: ['bash'] } : {};

export interface PiSession {
	agent: AgentSession;
	cwd: string;
	/** True while a prompt is running */
	busy: boolean;
	/** Same instance passed into createAgentSession; kept for tree lookups (retry). */
	sessionManager: SessionManager;
}

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

/** Deterministic resource setup: bundled Exa extension only, no discovered extensions. */
async function makeResourceLoader(cwd: string) {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getIsolatedAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [exaExtension]
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
	if (existing) return existing;

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

	const pi: PiSession = { agent: session, cwd, busy: false, sessionManager };
	sessions.set(id, pi);
	return pi;
}

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

export function busyIds(): string[] {
	return [...sessions.entries()].filter(([, s]) => s.busy).map(([id]) => id);
}

export interface RetryTarget {
	/** Index in convo.items of the user turn being retried (everything from here on is discarded). */
	userIdx: number;
	/** Stored text of that user turn (fallback resend text if it was never recorded in the session). */
	text: string;
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
	return { userIdx, text, entryId: entry?.id ?? null };
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
	send: (event: string, data: unknown) => void
): Promise<boolean> {
	pi.busy = true;
	const unsubscribe = pi.agent.subscribe((e) => {
		applyToConvo(convoId, e);
		for (const sse of toSseEvents(e)) send(sse.event, sse.data);
	});
	let ok = true;
	try {
		await pi.agent.prompt(text);
	} catch (err) {
		ok = false;
		send('error', { message: err instanceof Error ? err.message : String(err) });
	} finally {
		unsubscribe();
		pi.busy = false;
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
	const models = await (await getRuntime()).getAvailable();
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
	| { event: 'done'; data: { ok: boolean } }
	| { event: 'error'; data: { message: string } };

/** Tools whose structured `details` payload is forwarded to the client. */
const VISUAL_TOOLS = new Set(['web_search_exa', 'web_fetch_exa']);

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
						...(VISUAL_TOOLS.has(e.toolName) ? { details: safeDetails(e.result) } : {})
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
		e.type !== 'message_end'
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
					const t = c.items.find((i) => i.role === 'tool' && i.id === e.toolCallId);
					if (!t) return false;
					t.status = e.isError ? 'error' : 'done';
					t.output = toolOutput(e.result);
					const details = VISUAL_TOOLS.has(e.toolName) ? safeDetails(e.result) : null;
					if (details) t.details = details;
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
				default:
					break;
			}
		},
		false
	);
}

/** Re-export for routes that need to look up conversations. */
export { getConvo, dataDir };
