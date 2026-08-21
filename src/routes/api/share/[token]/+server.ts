import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { resolveShare } from '$lib/server/share';

/**
 * Public, read-only snapshot of a shared conversation. No auth (guests), no
 * mutation surface: only the display fields are returned, never cwd, sandbox
 * flags, or context usage.
 */
export const GET: RequestHandler<{ token: string }> = ({ params }) => {
	const convo = resolveShare(params.token);
	if (!convo) {
		return json({ error: 'This shared conversation is no longer available.' }, { status: 404 });
	}
	return json({
		id: convo.id,
		title: convo.title,
		createdAt: convo.createdAt,
		updatedAt: convo.updatedAt,
		items: convo.items
	});
};
