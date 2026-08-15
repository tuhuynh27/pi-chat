import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { getSession, resolveModelId } from '$lib/server/pi';
import { getConvo, scheduleSave, setLastModel } from '$lib/server/store';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const id = typeof body?.id === 'string' ? body.id : '';
	const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';

	const convo = getConvo(conversationId);
	if (!convo) return json({ error: 'Conversation not found.' }, { status: 404 });

	const model = await resolveModelId(id);
	if (!model) return json({ error: `Unknown model: ${id}` }, { status: 404 });

	// Apply to the live session FIRST, and await it: setModel verifies auth
	// asynchronously and throws when the provider has no key. Un-awaited, that
	// rejection would crash the process, and a chat sent right after the
	// switch could run on the old model.
	const pi = await getSession(convo.id, convo);
	const cur = pi.agent.model;
	if (!cur || cur.provider !== model.provider || cur.id !== model.id) {
		try {
			await pi.agent.setModel(model);
		} catch (err) {
			return json(
				{ error: `Could not switch model: ${err instanceof Error ? err.message : String(err)}` },
				{ status: 500 }
			);
		}
	}

	convo.model = id;
	// Remember for new conversations started from now on.
	setLastModel(id);
	scheduleSave();

	return json({ current: id });
};
