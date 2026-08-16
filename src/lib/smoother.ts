import type { AssistantItem } from './types';

/**
 * Smooth text reveal for streamed assistant output.
 *
 * Network arrival is bursty: fast models emit 100+ tokens/s and the server
 * coalesces deltas into ~50ms frames, so rendering deltas directly makes the
 * text jump forward in chunks ~20 times a second. Production chat UIs
 * (ChatGPT, Gemini) decouple the two streams: incoming text lands in a
 * pending buffer, and an animation loop reveals it a few characters per
 * frame at an adaptive rate, so the visible text flows continuously no
 * matter how the network delivers it.
 *
 * The reveal rate is proportional to the backlog (drain in ~TRAIL_MS), which
 * makes the visible text trail arrival by a roughly constant ~TRAIL_MS at any
 * generation speed - fast models reveal more characters per frame rather than
 * falling behind, slow models get a gentle typewriter with no added lag.
 *
 * Ordering guarantees: anything that must appear after the text (tool rows,
 * errors, end-of-run) calls flush() first; settle() lets a finished run wait
 * for the natural drain instead of dumping the tail in one jump.
 */

/** Target time for the visible text to catch up with arrived text. */
const TRAIL_MS = 220;
/** Clamp frame gaps (hidden tab) so catch-up stays a quick ramp, not a dump. */
const MAX_FRAME_MS = 100;
/** Upper bound on settle() so a lost rAF can never wedge a run's finally. */
const SETTLE_MAX_MS = 1500;
/** Max stored length of a thinking block (matches the server-side cap). */
export const THINKING_CAP = 32000;

type Kind = 'text' | 'thinking';

/** Largest cut index <= n+1 that doesn't split a surrogate pair. */
function safeCut(s: string, n: number): number {
	if (n >= s.length) return s.length;
	const c = s.charCodeAt(n - 1);
	return c >= 0xd800 && c <= 0xdbff ? n + 1 : n;
}

export function createSmoother(onReveal: () => void) {
	let item: AssistantItem | null = null;
	let pendingText = '';
	let pendingThinking = '';
	let frame = 0;
	let lastTime = 0;
	let settlers: (() => void)[] = [];

	const isEmpty = () => pendingText === '' && pendingThinking === '';

	const resolveSettlers = () => {
		for (const resolve of settlers) resolve();
		settlers = [];
	};

	const cancelFrame = () => {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
	};

	const revealThinking = (n: number) => {
		if (!item || !n) return;
		item.thinking = (item.thinking + pendingThinking.slice(0, n)).slice(-THINKING_CAP);
		pendingThinking = pendingThinking.slice(n);
	};

	const revealText = (n: number) => {
		if (!item || !n) return;
		item.text += pendingText.slice(0, n);
		pendingText = pendingText.slice(n);
	};

	const tick = (now: number) => {
		frame = 0;
		const dt = Math.min(now - lastTime, MAX_FRAME_MS);
		lastTime = now;
		revealThinking(safeCut(pendingThinking, Math.ceil((pendingThinking.length * dt) / TRAIL_MS)));
		revealText(safeCut(pendingText, Math.ceil((pendingText.length * dt) / TRAIL_MS)));
		onReveal();
		if (isEmpty()) resolveSettlers();
		else frame = requestAnimationFrame(tick);
	};

	const schedule = () => {
		if (frame) return;
		lastTime = performance.now();
		frame = requestAnimationFrame(tick);
	};

	const flush = () => {
		cancelFrame();
		revealThinking(pendingThinking.length);
		revealText(pendingText.length);
		if (item) onReveal();
		resolveSettlers();
	};

	return {
		/** Queue a chunk for target. A target change flushes the previous item first. */
		push(target: AssistantItem, kind: Kind, chunk: string) {
			if (item !== target) {
				flush();
				item = target;
			}
			if (kind === 'text') pendingText += chunk;
			else pendingThinking += chunk;
			schedule();
		},
		/** Reveal all pending thinking now (thinking phase ended; text may follow). */
		flushThinking() {
			revealThinking(pendingThinking.length);
		},
		/** Reveal everything now (tool row / error / finalization must not wait). */
		flush,
		/** Drop pending output without revealing it (conversation switched away). */
		reset() {
			cancelFrame();
			item = null;
			pendingText = '';
			pendingThinking = '';
			resolveSettlers();
		},
		/** Resolves when the backlog has drained naturally (bounded by SETTLE_MAX_MS). */
		settle(): Promise<void> {
			if (isEmpty()) return Promise.resolve();
			return new Promise((resolve) => {
				settlers.push(resolve);
				setTimeout(resolve, SETTLE_MAX_MS);
			});
		}
	};
}
