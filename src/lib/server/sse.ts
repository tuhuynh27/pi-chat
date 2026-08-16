const encoder = new TextEncoder();

function sseFrame(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export type SseSend = (event: string, data: unknown) => void;

/**
 * SSE writer over a ReadableStream controller. Frames are enqueued directly;
 * the stream's internal queue absorbs any client slowness (frames are tiny,
 * and delta coalescing keeps the rate low - see coalesceDeltas).
 */
export function createSseWriter(controller: ReadableStreamDefaultController<Uint8Array>) {
	let closed = false;
	return {
		send(event: string, data: unknown) {
			if (closed) return;
			try {
				controller.enqueue(sseFrame(event, data));
			} catch {
				closed = true;
			}
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				controller.close();
			} catch {
				/* already closed */
			}
		},
		cancel() {
			closed = true;
		}
	};
}

const FLUSH_MS = 50;

/**
 * Wrap an SSE send so consecutive `delta`/`thinking` text events are merged
 * into at most one frame per FLUSH_MS. LLMs emit deltas per token (often
 * 50-100+/s); forwarding each one costs a frame on the wire and a reactivity
 * tick in the client for no visible benefit, since the client renders at
 * most once per animation frame anyway. Any other event type (tool_start,
 * error, ...) flushes the buffer first, so ordering is preserved. Call
 * flush() when the run ends, before sending `done`.
 */
export function coalesceDeltas(send: SseSend): { send: SseSend; flush: () => void } {
	let kind: 'delta' | 'thinking' | null = null;
	let buf = '';
	let timer: NodeJS.Timeout | null = null;

	const flush = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (kind && buf) send(kind, { text: buf });
		kind = null;
		buf = '';
	};

	return {
		send(event, data) {
			if (event === 'delta' || event === 'thinking') {
				if (kind && kind !== event) flush();
				kind = event;
				buf += String((data as { text?: unknown })?.text ?? '');
				if (!timer) timer = setTimeout(flush, FLUSH_MS);
				return;
			}
			flush();
			send(event, data);
		},
		flush
	};
}
