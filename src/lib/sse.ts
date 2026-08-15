/** Minimal SSE stream reader over fetch's ReadableStream. */

export interface SseMessage {
	event: string;
	data: unknown;
}

export async function* readSse(res: Response): AsyncGenerator<SseMessage> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let sep: number;
			while ((sep = buf.indexOf('\n\n')) >= 0) {
				const frame = buf.slice(0, sep);
				buf = buf.slice(sep + 2);
				let event = 'message';
				const dataLines: string[] = [];
				for (const line of frame.split('\n')) {
					if (line.startsWith('event:')) event = line.slice(6).trim();
					else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
				}
				if (dataLines.length === 0) continue;
				let data: unknown;
				try {
					data = JSON.parse(dataLines.join('\n'));
				} catch {
					data = dataLines.join('\n');
				}
				yield { event, data };
			}
		}
	} finally {
		reader.releaseLock();
	}
}
