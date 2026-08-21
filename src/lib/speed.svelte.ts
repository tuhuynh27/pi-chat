/**
 * Token-speed + context telemetry for the chat UI, adapted from the Pi TUI
 * footer extension. The stopwatch starts at the first streamed delta, not at
 * request dispatch, so time-to-first-token does not dilute the generation
 * rate. Streamed characters drive a live estimate; the server-reported token
 * count from the `usage` SSE event replaces it when the message finishes.
 */
import type { ContextInfo } from './types';

const DEFAULT_CHARS_PER_TOKEN = 4;

type Phase = 'idle' | 'waiting' | 'streaming' | 'done';

export interface SpeedStats {
	speed: string | null;
	context: string | null;
}

function formatNumber(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatRate(rate: number | undefined): string {
	if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return '… tok/s';
	if (rate >= 1_000) return `${(rate / 1_000).toFixed(1)}k tok/s`;
	return `${rate >= 100 ? Math.round(rate) : rate.toFixed(1)} tok/s`;
}

export function createSpeedTracker() {
	// Learn the model's token density from completed responses so the live
	// estimate improves over the session. Calibrate on cumulative totals, not
	// the last message alone: per-message density swings widely.
	let charsPerToken = DEFAULT_CHARS_PER_TOKEN;
	let calChars = 0;
	let calTokens = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	let phase = $state<Phase>('idle');
	let requestSentAt = $state(0);
	let firstTokenAt = $state(0);
	let lastTokenAt = $state(0);
	let chars = $state(0);
	let serverTokens = $state<number | undefined>(undefined);
	let finalRate = $state<number | undefined>(undefined);
	let now = $state(Date.now());
	let context = $state<ContextInfo | null>(null);

	function startTimer() {
		if (timer) return;
		timer = setInterval(() => (now = Date.now()), 1_000);
	}

	function stopTimer() {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	function estimatedTokens(): number {
		return chars / charsPerToken;
	}

	function restart(at: number) {
		firstTokenAt = at;
		lastTokenAt = 0;
		chars = 0;
		serverTokens = undefined;
		finalRate = undefined;
	}

	const speedText = $derived.by((): string | null => {
		if (phase === 'waiting') {
			const seconds = Math.max(0, now - requestSentAt) / 1_000;
			return `prefill ${seconds.toFixed(0)}s`;
		}
		if (phase === 'streaming') {
			const end = Math.max(now, lastTokenAt);
			const elapsed = (end - firstTokenAt) / 1_000;
			const tokens = estimatedTokens();
			const rate = elapsed > 0 ? tokens / elapsed : undefined;
			return `${formatRate(rate)} · ${formatNumber(tokens)} tok`;
		}
		if (phase === 'done') {
			const tokens = serverTokens ?? estimatedTokens();
			if (!tokens) return null;
			return `${formatRate(finalRate)} · ${formatNumber(tokens)} tok`;
		}
		return null;
	});

	const contextText = $derived.by((): string | null => {
		if (!context || context.tokens == null || !context.contextWindow) return null;
		const percent = context.percent;
		const pct =
			percent != null ? ` (${percent < 10 ? percent.toFixed(1) : percent.toFixed(0)}%)` : '';
		return `ctx ${formatNumber(context.tokens)} / ${formatNumber(context.contextWindow)}${pct}`;
	});

	return {
		get speedText() {
			return speedText;
		},
		get contextText() {
			return contextText;
		},

		/** A run this client started is in flight; show the prefill stopwatch. */
		begin() {
			phase = 'waiting';
			requestSentAt = Date.now();
			now = requestSentAt;
			restart(0);
			startTimer();
		},

		/** Streamed text or thinking received (counted on receipt, not reveal). */
		delta(text: string) {
			if (!text) return;
			const at = Date.now();
			// Deltas can arrive with no begin(): reattaching to a live run, or the
			// next assistant segment after a tool call finalized the previous one.
			// Measure that segment from its own first token.
			if (phase === 'idle' || phase === 'done') {
				requestSentAt = 0;
				restart(at);
				startTimer();
			} else if (phase === 'waiting') {
				firstTokenAt = at;
			}
			phase = 'streaming';
			chars += text.length;
			lastTokenAt = at;
			now = at;
		},

		/**
		 * Assistant message finished (server-reported output tokens), or the run
		 * ended without usage (error/abort). Ends the stopwatch at the last
		 * received delta: the gap to message_end is not generation time.
		 */
		finish(outputTokens?: number) {
			if (phase === 'waiting') {
				// Nothing ever streamed - nothing to rate.
				phase = 'idle';
				stopTimer();
				return;
			}
			if (phase !== 'streaming') return;
			if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens > 0) {
				serverTokens = outputTokens;
				const observed = chars / outputTokens;
				if (observed >= 0.5 && observed <= 20) {
					calChars += chars;
					calTokens += outputTokens;
					charsPerToken = calChars / calTokens;
				}
			}
			const elapsed = (lastTokenAt - firstTokenAt) / 1_000;
			const tokens = serverTokens ?? estimatedTokens();
			finalRate = elapsed > 0 ? tokens / elapsed : undefined;
			phase = 'done';
			stopTimer();
		},

		/** Clear everything (conversation switch); context is re-seeded separately. */
		reset() {
			phase = 'idle';
			restart(0);
			context = null;
			stopTimer();
		},

		/** Update the context gauge; null/undefined never clears a known value. */
		setContext(c: ContextInfo | null | undefined) {
			if (c && typeof c.contextWindow === 'number') context = c;
		}
	};
}
