import { open } from 'node:fs/promises';

const JSON_WRITE_CHUNK_SIZE = 64 * 1024;

type JsonWriter = {
	append: (text: string) => Promise<void>;
	writeValue: (value: unknown) => Promise<void>;
};

/** Serialize JSON into bounded chunks supplied to an asynchronous sink. */
async function serializeJson(
	write: (writer: JsonWriter) => Promise<void>,
	emit: (output: string) => Promise<void>
): Promise<void> {
	let parts: string[] = [];
	let length = 0;

	const flush = async () => {
		if (length === 0) return;
		const output = parts.join('');
		parts = [];
		length = 0;
		await emit(output);
	};

	const append = async (text: string) => {
		parts.push(text);
		length += text.length;
		if (length >= JSON_WRITE_CHUNK_SIZE) await flush();
	};

	const writeString = async (text: string) => {
		await append('"');
		for (let offset = 0; offset < text.length; offset += JSON_WRITE_CHUNK_SIZE) {
			const encoded = JSON.stringify(text.slice(offset, offset + JSON_WRITE_CHUNK_SIZE));
			await append(encoded.slice(1, -1));
		}
		await append('"');
	};

	const writeValue = async (current: unknown): Promise<void> => {
		if (current === null) {
			await append('null');
		} else if (typeof current === 'string') {
			await writeString(current);
		} else if (typeof current === 'number') {
			await append(Number.isFinite(current) ? String(current) : 'null');
		} else if (typeof current === 'boolean') {
			await append(current ? 'true' : 'false');
		} else if (Array.isArray(current)) {
			await append('[');
			for (let index = 0; index < current.length; index++) {
				if (index > 0) await append(',');
				const item = current[index];
				await writeValue(
					item === undefined || typeof item === 'function' || typeof item === 'symbol' ? null : item
				);
			}
			await append(']');
		} else if (typeof current === 'object') {
			await append('{');
			let first = true;
			for (const [key, item] of Object.entries(current)) {
				if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
				if (!first) await append(',');
				first = false;
				await writeString(key);
				await append(':');
				await writeValue(item);
			}
			await append('}');
		} else {
			await append('null');
		}
	};

	await write({ append, writeValue });
	await flush();
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
	const file = await open(path, 'w');
	try {
		await serializeJson(({ writeValue }) => writeValue(value), (output) => file.writeFile(output));
	} finally {
		await file.close();
	}
}

export async function writeJsonLinesFile(path: string, values: unknown[]): Promise<void> {
	const file = await open(path, 'w');
	try {
		await serializeJson(
			async ({ append, writeValue }) => {
				for (const value of values) {
					await writeValue(value);
					await append('\n');
				}
			},
			(output) => file.writeFile(output)
		);
	} finally {
		await file.close();
	}
}

/** Stream a JSON value in bounded chunks. */
export function writeJsonChunks(
	value: unknown,
	emit: (output: string) => Promise<void>
): Promise<void> {
	return serializeJson(({ writeValue }) => writeValue(value), emit);
}

/** Replayable UTF-8 JSON body for HTTP clients that accept async iterables. */
export function streamingJsonBody(value: unknown): AsyncIterable<Uint8Array> & { stream: true } {
	return {
		stream: true,
		[Symbol.asyncIterator]() {
			let canceled = false;
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					void writeJsonChunks(value, async (chunk) => {
						if (canceled) throw new Error('Request body stream canceled.');
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
			const reader = stream.getReader();
			return {
				next: () => reader.read(),
				async return() {
					await reader.cancel();
					return { done: true, value: undefined };
				}
			};
		}
	};
}
