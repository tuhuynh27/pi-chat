import { writeJsonChunks } from './async-json';

const encoder = new TextEncoder();

/** JSON response whose serialization and UTF-8 encoding regularly yield. */
export function streamingJson(value: unknown, init: ResponseInit = {}): Response {
	let canceled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			void writeJsonChunks(value, async (chunk) => {
				if (canceled) throw new Error('Response stream canceled.');
				controller.enqueue(encoder.encode(chunk));
				await new Promise<void>((resolve) => setImmediate(resolve));
			})
				.then(() => {
					if (!canceled) controller.close();
				})
				.catch((error) => {
					if (!canceled) controller.error(error);
				});
		},
		cancel() {
			canceled = true;
		}
	});
	const headers = new Headers(init.headers);
	if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
	return new Response(stream, { ...init, headers });
}
