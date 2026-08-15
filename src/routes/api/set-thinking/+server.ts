import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { getSession, isValidThinkingLevel } from '$lib/server/pi';
import { getConvo, scheduleSave, setLastThinking } from '$lib/server/store';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const level = body?.level;
	const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';

	if (!isValidThinkingLevel(level)) {
		return json({ error: `Invalid thinking level: ${String(level)}` }, { status: 400 });
	}
	const convo = getConvo(conversationId);
	if (!convo) return json({ error: 'Conversation not found.' }, { status: 404 });

	convo.thinking = level;
	// Remember for new conversations started from now on.
	setLastThinking(level);
	scheduleSave();

	// The session clamps the level to the model's supported levels; report
	// the effective value so the UI shows what the LLM call actually gets.
	let effective = level;
	try {
		const pi = await getSession(convo.id, convo);
		pi.agent.setThinkingLevel(level);
		effective = pi.agent.thinkingLevel;
	} catch {
		/* stored value applies next time the session is created */
	}

	return json({ level, effective });
};
