import { getConvoByShareToken, getOrCreateShareToken, type Convo } from './store';

/**
 * Share tokens are persisted with conversation history. Each conversation has
 * exactly one token, which remains valid across server restarts until the
 * conversation is deleted.
 */
function newToken(): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto
		? crypto.randomUUID()
		: Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Create a share token for a conversation. Returns null if the convo is gone. */
export function createShare(convoId: string): string | null {
	return getOrCreateShareToken(convoId, newToken);
}

/** Resolve a token to its live conversation, or null (unknown token / deleted convo). */
export function resolveShare(token: string): Convo | null {
	return getConvoByShareToken(token);
}
