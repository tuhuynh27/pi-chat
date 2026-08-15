import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exaExtension } from './exa';
import {
	DEFAULT_MODEL,
	DEFAULT_MODELS_CONFIG,
	DEFAULT_PROVIDER,
	DEFAULT_THINKING
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
}

const sessions = new Map<string, PiSession>();
let runtime: ModelRuntime | null = null;
let scopedSettings: SettingsManager | null = null;

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
 * Copy the host's Pi credentials/models into the temp area and run the model
 * runtime against those copies.
 *
 * Why: the runtime writes a lock file next to auth.json (~/.pi/agent), which
 * the seatbelt profile denies. Running from temp copies also avoids lock
 * contention with a concurrently running pi CLI.
 */
async function makeRuntime(): Promise<ModelRuntime> {
	const agentDir = getAgentDir();
	const runtimeDir = mkdtempSync(join(tmpdir(), 'pi-web-rt-'));
	for (const file of ['auth.json', 'models.json', 'models-store.json']) {
		const src = join(agentDir, file);
		if (existsSync(src)) copyFileSync(src, join(runtimeDir, file));
	}
	const modelsPath = join(runtimeDir, 'models.json');
	if (!existsSync(modelsPath)) {
		writeFileSync(modelsPath, JSON.stringify(DEFAULT_MODELS_CONFIG, null, 2));
	}
	return await ModelRuntime.create({
		authPath: join(runtimeDir, 'auth.json'),
		modelsPath,
		modelsStorePath: join(runtimeDir, 'models-store.json')
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
		agentDir: getAgentDir(),
		noExtensions: true,
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
	const { session } = await createAgentSession({
		cwd,
		sessionManager: sessionManagerFor(id, cwd),
		modelRuntime: await getRuntime(),
		resourceLoader: await makeResourceLoader(cwd),
		settingsManager: getSettings(),
		...(model ? { model } : {}),
		...(convo.thinking ? { thinkingLevel: convo.thinking as ThinkingLevel } : {}),
		...sessionToolOptions
	});

	const pi: PiSession = { agent: session, cwd, busy: false };
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
