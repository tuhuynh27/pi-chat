import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Agent workspaces live in the OS temp dir, isolated from the host.
 *
 * - one workspace per server process start
 * - "New chat" creates a fresh one (previous is removed)
 * - stale workspaces from earlier runs are swept on startup
 *
 * NOTE: the cwd is a *context* boundary, not a security boundary on its own
 * — the LLM can still pass absolute paths. Real containment (blocking writes
 * outside temp and all process spawns) comes from the seatbelt profile in
 * `sandbox.sb` (`npm run start:sandboxed`).
 */

const PREFIX = 'pi-web-';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function createWorkspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), PREFIX));
}

export async function removeWorkspace(dir: string): Promise<void> {
	try {
		await rm(dir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

export async function cleanupOldWorkspaces(keep = new Set<string>()): Promise<void> {
	const base = tmpdir();
	const cutoff = Date.now() - MAX_AGE_MS;
	let names: string[];
	try {
		names = await readdir(base);
	} catch {
		return;
	}
	await Promise.all(
		names.map(async (name) => {
			if (!name.startsWith(PREFIX) || keep.has(name)) return;
			const p = join(base, name);
			try {
				if ((await stat(p)).mtimeMs < cutoff) await rm(p, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		})
	);
}
