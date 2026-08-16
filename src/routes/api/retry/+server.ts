import type { RequestHandler } from '@sveltejs/kit';
import { getSession, resolveRetryTarget, runPrompt } from '$lib/server/pi';
import { applyEvent, getConvo, saveNow } from '$lib/server/store';
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
					const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
					const index = typeof body?.index === 'number' ? body.index : -1;

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

					const target = resolveRetryTarget(pi, convo, index);
					if (!target) {
						send('error', { message: 'Nothing to retry.' });
						close();
						return;
					}

					// entryId is null when the original attempt failed before the SDK
					// persisted anything to the session (e.g. no model configured) -
					// there is nothing to navigate to, so just resend the stored text.
					let text = target.text;
					if (target.entryId) {
						// Move the session's active leaf back to before this turn; the
						// SDK hands back the original message text to resend.
						const { editorText, cancelled } = await pi.agent.navigateTree(target.entryId);
						if (cancelled) {
							send('error', { message: 'Could not retry this message.' });
							close();
							return;
						}
						if (editorText) text = editorText;
					}

					// Drop the retried turn and everything after it, then record the
					// resent user message BEFORE the run (matches /api/chat).
					applyEvent(convo.id, (c) => {
						c.items.length = target.userIdx;
						c.items.push({ role: 'user', text, ...(target.images?.length ? { images: target.images } : {}) });
					});

					const ok = await runPrompt(convo.id, pi, text, send, target.images);

					send('done', { ok });
					close();
					await saveNow();
				} catch (err) {
					send('error', {
						message: err instanceof Error ? err.message : 'Failed to retry the message.'
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
