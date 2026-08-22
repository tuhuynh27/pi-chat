import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { contextUsage, disposeSession, getLiveSession, isBusy, isSandboxed } from '$lib/server/pi';
import { deleteConvo, getConvo, saveNow, snapshotConvo } from '$lib/server/store';
import { revokeSharesForConvo } from '$lib/server/share';
import { streamingJson } from '$lib/server/json-response';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GET: RequestHandler<{ id: string }> = ({ params }) => {
	const convo = getConvo(params.id);
	if (!convo) return json({ error: 'Conversation not found.' }, { status: 404 });
	const live = getLiveSession(convo.id);
	const snapshot = snapshotConvo(convo);
	return streamingJson({
		...snapshot,
		busy: isBusy(convo.id),
		// Display-only: the dir is created on first use.
		cwd: join(tmpdir(), `pi-web-${convo.id}`),
		sandboxed: isSandboxed(),
		// Live value when the session is in memory; last persisted one otherwise.
		context: (live ? contextUsage(live) : null) ?? convo.lastContext ?? null
	});
};

export const DELETE: RequestHandler<{ id: string }> = async ({ params }) => {
	await disposeSession(params.id);
	// A deleted conversation's share links stop resolving immediately.
	revokeSharesForConvo(params.id);
	const ok = await deleteConvo(params.id);
	await saveNow();
	if (!ok) return json({ error: 'Conversation not found.' }, { status: 404 });
	return json({ ok: true });
};
