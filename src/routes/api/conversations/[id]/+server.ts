import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { disposeSession, isBusy, isSandboxed, workspaceFor } from '$lib/server/pi';
import { deleteConvo, getConvo, saveNow } from '$lib/server/store';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GET: RequestHandler<{ id: string }> = ({ params }) => {
	const convo = getConvo(params.id);
	if (!convo) return json({ error: 'Conversation not found.' }, { status: 404 });
	return json({
		...convo,
		busy: isBusy(convo.id),
		// Display-only: the dir is created on first use.
		cwd: join(tmpdir(), `pi-web-${convo.id}`),
		sandboxed: isSandboxed()
	});
};

export const DELETE: RequestHandler<{ id: string }> = async ({ params }) => {
	disposeSession(params.id);
	const ok = deleteConvo(params.id);
	await saveNow();
	if (!ok) return json({ error: 'Conversation not found.' }, { status: 404 });
	return json({ ok: true });
};
