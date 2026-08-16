const encoder = new TextEncoder();

function sseFrame(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

interface PendingFrame {
	event: string;
	data: unknown;
}

/** Ordered SSE writer that forwards every event immediately and honors stream backpressure. */
export function createSseWriter(controller: ReadableStreamDefaultController<Uint8Array>) {
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
