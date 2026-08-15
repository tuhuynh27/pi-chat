import type { RequestHandler } from '@sveltejs/kit';
import { applyToConvo, getSession, toSseEvents } from '$lib/server/pi';
import { applyEvent, getConvo, saveNow, touchTitle } from '$lib/server/store';

const encoder = new TextEncoder();

function sseFrame(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

interface PendingFrame {
	event: string;
	data: unknown;
}

/** Ordered SSE writer that forwards every event immediately and honors stream backpressure. */
function createSseWriter(controller: ReadableStreamDefaultController<Uint8Array>) {
	const queue: PendingFrame[] = [];
	let closeRequested = false;
	let closed = false;

	const finishClose = () => {
		if (!closeRequested || queue.length > 0 || closed) return;
		closed = true;
		try {
			controller.close();
		} catch {
			/* already closed */
		}
	};

	const drain = () => {
		if (closed) return;
		try {
			while (queue.length > 0 && (controller.desiredSize ?? 0) > 0) {
				const frame = queue.shift();
				if (frame) controller.enqueue(sseFrame(frame.event, frame.data));
			}
		} catch {
			closed = true;
			queue.length = 0;
		}
		finishClose();
	};

	return {
		send(event: string, data: unknown) {
			if (closed) return;
			queue.push({ event, data });
			drain();
		},
		drain,
		close() {
			if (closed) return;
			closeRequested = true;
			drain();
		},
		cancel() {
			closed = true;
			queue.length = 0;
		}
	};
}

export const POST: RequestHandler = async ({ request }) => {
	let writer: ReturnType<typeof createSseWriter> | null = null;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			writer = createSseWriter(controller);
			const send = writer.send;
			const close = writer.close;

			(async () => {
				try {
					const body = await request.json().catch(() => null);
					const text = typeof body?.text === 'string' ? body.text.trim() : '';
					const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
					if (!text) {
						send('error', { message: 'Empty message.' });
						close();
						return;
					}
					const convo = getConvo(conversationId);
					if (!convo) {
						send('error', { message: 'Unknown conversation.' });
						close();
						return;
					}

					const pi = await getSession(convo.id, convo);
					if (pi.busy) {
						send('error', { message: 'This conversation is still working. Stop the run first.' });
						close();
						return;
					}

					// Record the user message + title BEFORE the run, so history
					// is correct even if the client navigates away immediately.
					applyEvent(convo.id, (c) => {
						c.items.push({ role: 'user', text });
					});
					touchTitle(convo.id, text);

					pi.busy = true;

					// Note: the run keeps going when the SSE client leaves
					// (background conversations); use POST /api/abort to stop.
					const unsubscribe = pi.agent.subscribe((e) => {
						applyToConvo(convo.id, e);
						for (const sse of toSseEvents(e)) send(sse.event, sse.data);
					});

					let ok = true;
					let savePromise = Promise.resolve();
					try {
						await pi.agent.prompt(text);
					} catch (err) {
						ok = false;
						send('error', { message: err instanceof Error ? err.message : String(err) });
					} finally {
						unsubscribe();
						pi.busy = false;
						savePromise = saveNow();
					}

					send('done', { ok });
					close();
					await savePromise;
				} catch (err) {
					// Session/model setup failure (e.g. no API key configured)
					send('error', {
						message:
							err instanceof Error
								? err.message
								: 'Failed to start the Pi agent. Is a model configured? (set KEVA_API_KEY or another provider API key, or run the pi CLI once to log in.)'
					});
					close();
				}
			})();
		},
		pull() {
			writer?.drain();
		},
		cancel() {
			writer?.cancel();
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
