import { json } from '@sveltejs/kit';
import { busyIds } from '$lib/server/pi';
import { createConvo, listConversations } from '$lib/server/store';

export const GET = () => {
	const busy = new Set(busyIds());
	return json(
		listConversations().map((c) => ({ ...c, busy: busy.has(c.id) }))
	);
};

export const POST = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const title = typeof body?.title === 'string' ? body.title : undefined;
	const convo = createConvo({ title });
	return json(convo);
};
