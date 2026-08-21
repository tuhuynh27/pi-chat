import type { RequestHandler } from '@sveltejs/kit';
import { contextUsage, getLiveSession, onceDone, toSseEvents, usageEventData } from '$lib/server/pi';
import { getConvo } from '$lib/server/store';
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

			// Snapshot first, subscribe second, with no `await` in between - on a
			// single-threaded event loop that guarantees no event can slip through
			// the gap (missed) or land in both places (duplicated).
			const pi = getLiveSession(conversationId);
			send('sync', {
				items: convo.items,
				context: (pi ? contextUsage(pi) : null) ?? convo.lastContext ?? null
			});

			if (!pi || !pi.busy) {
				send('done', { ok: true });
				close();
				return;
			}

			const live = coalesceDeltas(send);
			unsubscribeAgent = pi.agent.subscribe((e) => {
				for (const sse of toSseEvents(e)) live.send(sse.event, sse.data);
				const usage = usageEventData(pi, e);
				if (usage) live.send('usage', usage);
			});
			unsubscribeDone = onceDone(conversationId, (ok) => {
				unsubscribeAgent?.();
				unsubscribeAgent = null;
				live.flush();
				send('done', { ok });
				close();
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
