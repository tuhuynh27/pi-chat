import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { abort } from '$lib/server/pi';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : undefined;
	abort(conversationId);
	return json({ ok: true });
};
