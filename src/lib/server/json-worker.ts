import { Worker } from 'node:worker_threads';

type JsonFormat = 'json' | 'jsonl';

const WORKER_SOURCE = String.raw`
const { readFile } = require('node:fs/promises');
const { parentPort, workerData } = require('node:worker_threads');

(async () => {
	const raw = workerData.data
		? Buffer.from(workerData.data).toString('utf8')
		: await readFile(workerData.path, 'utf8');
	if (workerData.format === 'json') return JSON.parse(raw);

	const values = [];
	let start = 0;
	for (let index = 0; index <= raw.length; index++) {
		if (index < raw.length && raw.charCodeAt(index) !== 10) continue;
		const line = raw.slice(start, index).trim();
		start = index + 1;
		if (!line) continue;
		try {
			values.push(JSON.parse(line));
		} catch {
			// Match the SDK loader by skipping malformed JSONL records.
		}
	}
	return values;
})().then(
	(value) => parentPort.postMessage({ ok: true, value }),
	(error) => parentPort.postMessage({
		ok: false,
		message: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined
	})
);
`;

function runJsonWorker<T>(
	workerData: { format: JsonFormat; path?: string; data?: ArrayBuffer },
	transferList: ArrayBuffer[] = []
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const execArgv = process.execArgv.filter((arg) => !arg.startsWith('--input-type'));
		const worker = new Worker(WORKER_SOURCE, {
			eval: true,
			execArgv,
			transferList,
			workerData
		});
		let settled = false;

		worker.once('message', (result: { ok: boolean; value?: T; message?: string; stack?: string }) => {
			settled = true;
			if (result.ok) {
				resolve(result.value as T);
				return;
			}
			const error = new Error(result.message || 'Could not parse JSON.');
			if (result.stack) error.stack = result.stack;
			reject(error);
		});
		worker.once('error', (error) => {
			settled = true;
			reject(error);
		});
		worker.once('exit', (code) => {
			if (!settled && code !== 0) reject(new Error(`JSON worker stopped with exit code ${code}.`));
			else if (!settled) reject(new Error('JSON worker stopped before returning a result.'));
		});
	});
}

/** Read and parse a potentially large JSON file without occupying the server event loop. */
export function parseJsonFile<T>(path: string, format: JsonFormat = 'json'): Promise<T> {
	return runJsonWorker<T>({ path, format });
}

/** Transfer and parse a large request body without copying it onto the server event loop. */
export function parseJsonBuffer<T>(data: ArrayBuffer): Promise<T> {
	return runJsonWorker<T>({ data, format: 'json' }, [data]);
}
