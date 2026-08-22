import type { RequestHandler } from '@sveltejs/kit';
import { contextUsage, getLiveSession, onceDone, toSseEvents, usageEventData } from '$lib/server/pi';
import { getConvo, snapshotConvo } from '$lib/server/store';
import { coalesceDeltas, createSseWriter } from '$lib/server/sse';

/**
 * Read-only companion to /api/chat and /api/retry: lets a reconnecting
 * client (e.g. after a hard refresh) resync with a run that's still going
 * server-side. Sends the current stored items as `sync`, then - if the
 * conversation is still busy - forwards live agent events until the run
 * finishes. Never writes to the store (the original run's own subscriber in
 * runPrompt already does that); this is purely an additional listener.
 */
export const GET: RequestHandler = async ({ url }) => {
	const conversationId = url.searchParams.get('conversationId') ?? '';

	let writer: ReturnType<typeof createSseWriter> | null = null;
	let unsubscribeAgent: (() => void) | null = null;
	let unsubscribeDone: (() => void) | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			writer = createSseWriter(controller);
			const send = writer.send;
			const close = writer.close;

			const convo = getConvo(conversationId);
			if (!convo) {
				send('error', { message: 'Unknown conversation.' });
				close();
				return;
			}

			// Snapshot first, subscribe second, with no await in between. Live
			// events are buffered while the potentially large snapshot streams.
			const pi = getLiveSession(conversationId);
			const convoSnapshot = snapshotConvo(convo);
			const snapshot = {
				items: convoSnapshot.items,
				context: (pi ? contextUsage(pi) : null) ?? convo.lastContext ?? null
			};

			if (!pi || !pi.busy) {
				void writer.sendAsync('sync', snapshot).then(() => {
					send('done', { ok: true });
					close();
				});
				return;
			}

			const live = coalesceDeltas(send);
			const pending: Array<{ event: string; data: unknown }> = [];
			let syncSent = false;
			let pendingDone: boolean | null = null;
			const forward = (event: string, data: unknown) => {
				if (syncSent) live.send(event, data);
				else pending.push({ event, data });
			};
			const finish = (ok: boolean) => {
				unsubscribeAgent?.();
				unsubscribeAgent = null;
				live.flush();
				send('done', { ok });
				close();
			};
			unsubscribeAgent = pi.agent.subscribe((e) => {
				for (const sse of toSseEvents(e)) forward(sse.event, sse.data);
				const usage = usageEventData(pi, e);
				if (usage) forward('usage', usage);
			});
			unsubscribeDone = onceDone(conversationId, (ok) => {
				if (syncSent) finish(ok);
				else pendingDone = ok;
			});
			void writer.sendAsync('sync', snapshot).then(() => {
				syncSent = true;
				for (const event of pending) live.send(event.event, event.data);
				pending.length = 0;
				if (pendingDone !== null) finish(pendingDone);
			});
		},
		cancel() {
			writer?.cancel();
			unsubscribeAgent?.();
			unsubscribeDone?.();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
