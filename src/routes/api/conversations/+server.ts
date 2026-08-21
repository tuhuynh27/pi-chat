import { json } from '@sveltejs/kit';
import { busyIds, disposeSession } from '$lib/server/pi';
import { createConvo, deleteAllConvos, listConversations, saveNow } from '$lib/server/store';

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

export const DELETE = async () => {
	const ids = listConversations().map((convo) => convo.id);
	for (const id of ids) disposeSession(id);
	deleteAllConvos();
	await saveNow();
	return json({ ok: true, count: ids.length });
};
