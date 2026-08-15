import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
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

export function createWorkspace(): string {
	return mkdtempSync(join(tmpdir(), PREFIX));
}

export function removeWorkspace(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

export function cleanupOldWorkspaces(keep = new Set<string>()): void {
	const base = tmpdir();
	const cutoff = Date.now() - MAX_AGE_MS;
	let names: string[];
	try {
		names = readdirSync(base);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith(PREFIX)) continue;
		if (keep.has(name)) continue;
		const p = join(base, name);
		try {
			if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}
