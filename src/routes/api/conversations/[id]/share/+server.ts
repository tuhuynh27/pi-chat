import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { createShare } from '$lib/server/share';
import { saveNow } from '$lib/server/store';

/**
 * Create a read-only share link for this conversation. Authenticated (the
 * owner); the returned token is what guests use via /api/share/[token].
 */
export const POST: RequestHandler<{ id: string }> = async ({ params }) => {
	const token = createShare(params.id);
	if (!token) return json({ error: 'Conversation not found.' }, { status: 404 });
	// Do not return a usable URL until its pointer is durable on disk.
	await saveNow();
	return json({ token });
};
