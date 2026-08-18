import type { RequestHandler } from '@sveltejs/kit';
import { claimRun, getSession, parseImages, releaseRun, runPrompt } from '$lib/server/pi';
import { applyEvent, getConvo, saveNow, touchTitle } from '$lib/server/store';
import { createSseWriter } from '$lib/server/sse';

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
					const images = parseImages(body?.images);
					if (!images) {
						send('error', { message: 'Invalid image attachment.' });
						close();
						return;
					}
					if (!text && !images.length) {
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
					if (!claimRun(pi)) {
						send('error', { message: 'This conversation is still working. Stop the run first.' });
						close();
						return;
					}
					let started = false;
					try {
						// Record the user message + title BEFORE the run, so history
						// is correct even if the client navigates away immediately.
						applyEvent(convo.id, (c) => {
							c.items.push({ role: 'user', text, ...(images.length ? { images } : {}) });
						});
						touchTitle(convo.id, text || 'Image');

						// Note: the run keeps going when the SSE client leaves
						// (background conversations); use POST /api/abort to stop.
						started = true;
						const ok = await runPrompt(convo.id, pi, text, send, images);

						send('done', { ok });
						close();
						await saveNow();
					} finally {
						// runPrompt releases the claim itself; cover the paths before it.
						if (!started) releaseRun(pi);
					}
				} catch (err) {
					// Session/model setup failure (e.g. no API key configured)
					send('error', {
						message:
							err instanceof Error
								? err.message
								: 'Failed to start the Pi agent. Set a provider API key and model configuration in the server environment.'
					});
					close();
				}
			})();
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
