import { getConvo, type Convo } from './store';

/**
 * Volatile share tokens: token -> conversation id.
 *
 * Kept in memory only (no persistence) on purpose: a share link is a
 * point-in-time, read-only snapshot. It dies with the process on restart and
 * the moment its conversation is deleted, so there is nothing to clean up or
 * revoke on disk.
 */
const shares = new Map<string, string>();

function newToken(): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto
		? crypto.randomUUID()
		: Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Create a share token for a conversation. Returns null if the convo is gone. */
export function createShare(convoId: string): string | null {
	if (!getConvo(convoId)) return null;
	const token = newToken();
	shares.set(token, convoId);
	return token;
}

/** Resolve a token to its live conversation, or null (unknown token / deleted convo). */
export function resolveShare(token: string): Convo | null {
	const convoId = shares.get(token);
	if (!convoId) return null;
	return getConvo(convoId);
}

/** Drop every token pointing at a conversation (called when it is deleted). */
export function revokeSharesForConvo(convoId: string): void {
	for (const [token, id] of shares) {
		if (id === convoId) shares.delete(token);
	}
}

/** Drop all share tokens (called on delete-all). */
export function revokeAllShares(): void {
	shares.clear();
}
