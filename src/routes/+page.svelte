<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { fade } from 'svelte/transition';
	import Header from '$lib/components/Header.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import MessageItem from '$lib/components/MessageItem.svelte';
	import CopyMessage from '$lib/components/CopyMessage.svelte';
	import RetryMessage from '$lib/components/RetryMessage.svelte';
	import ToolLine from '$lib/components/ToolLine.svelte';
	import WebTool from '$lib/components/WebTool.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import LoginGate from '$lib/components/LoginGate.svelte';
	import LoadingScreen from '$lib/components/LoadingScreen.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { readSse } from '$lib/sse';
	import { createSmoother } from '$lib/smoother';
	import { initTheme, setTheme, type Theme } from '$lib/theme';
	import {
		asWebDetails,
		webDetailsFromOutput,
		isWebTool,
		isTool,
		toolDetail,
		uid,
		toItems,
		type AssistantItem,
		type ConvoInfo,
		type ConvoSummary,
		type ImageAttachment,
		type Item,
		type StoredItem,
		type ToolItem
	} from '$lib/types';

	const SUGGESTIONS = [
		"What's driving the S&P 500 today, and which sectors are leading?",
		"Summarize Nvidia's latest earnings call and how the market reacted",
		"Which stocks are trending after today's Fed announcement?"
	];

	let theme = $state<Theme>('light');
	let convos = $state<ConvoSummary[]>([]);
	let activeId = $state<string | null>(null);
	let items = $state<Item[]>([]);
	let draft = $state('');
	/** Id of a just-created conversation with no messages yet; swept away on nav/unload unless the user typed a draft. */
	let freshEmptyId = $state<string | null>(null);
	let busyIds = $state<string[]>([]);
	let models = $state<{ id: string; name: string; provider: string }[]>([]);
	let model = $state('');
	let thinking = $state('off');
	let sidebarOpen = $state(typeof window !== 'undefined' && window.matchMedia('(min-width: 720px)').matches);
	let modelsLoaded = $state(false);
	let ready = $state(false);
	let authState = $state<'checking' | 'required' | 'authenticated'>('checking');
	let authConfigured = $state<boolean | null>(null);
	let busy = $derived(activeId !== null && busyIds.includes(activeId));
	let appInteractive = $derived(authState === 'authenticated' && ready);
	let showLoadingScreen = $derived(authState === 'checking' || (authState === 'authenticated' && !ready));

	let curAsst: AssistantItem | null = null;
	const localRuns = new Set<string>();
	/** Reveals buffered deltas a few chars per frame; see $lib/smoother. */
	const smoother = createSmoother(() => scrollBottom());
	/** Skip mount fades when replacing the whole thread (select / attach sync). */
	let skipEnter = $state(false);
	let enterGate = 0;
	const fadeIn = $derived({ duration: skipEnter ? 0 : 140 });

	function finishAsst() {
		smoother.flush();
		if (curAsst) {
			curAsst.streaming = false;
			curAsst.thinkingActive = false;
		}
		curAsst = null;
	}

	/** A finished run must never leave a tool row spinning. */
	function settleRunningTools() {
		for (const i of items) {
			if (isTool(i) && i.status === 'running') i.status = 'done';
		}
	}
	let lastError = '';
	let lightboxSrc = $state<string | null>(null);
	let pendingConfirm = $state<
		| { kind: 'delete'; id: string; title: string }
		| { kind: 'logout' }
		| null
	>(null);
	/** Retry callback for the run currently in flight, attached to the error item if it fails. */
	let currentRetry: (() => void) | null = null;
	let appEl: HTMLDivElement;
	let scrollEl: HTMLDivElement;
	let stick = true;
	let scrollFrame = 0;
	let ignoreScroll = false;
	let lastScrollTop = 0;
	let touchStartY = 0;

	async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const response = await fetch(input, init);
		if (response.status === 401) {
			authConfigured = true;
			authState = 'required';
		}
		return response;
	}

	/** Turn a fetch()-level failure into a message worth showing, without a raw stack trace. */
	function describeFetchError(e: unknown): string {
		if (e instanceof TypeError) return 'Network error - check your connection and try again.';
		return e instanceof Error ? e.message : 'Something went wrong.';
	}

	/* ---------------- scrolling ---------------- */

	/** Subpixel / zoom slack. Anything past this is no longer "at the bottom". */
	const BOTTOM_EPS = 4;
	/** Real touch/scroll slop so sensor jitter and iOS rubber-band overscroll
	 * can't be mistaken for the user deliberately scrolling away. A 1px
	 * threshold fires on a plain tap (touch coordinates jitter a few px even
	 * while "still") or on the bounce-back of a momentum scroll that landed
	 * at the bottom - either way `stick` gets stuck false with nothing to
	 * re-arm it (the content keeps growing, so the page never resettles
	 * exactly at gapFromBottom() <= BOTTOM_EPS on its own). */
	const UNSTICK_SLOP = 10;

	function gapFromBottom() {
		return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
	}

	function onScroll() {
		const top = scrollEl.scrollTop;
		if (ignoreScroll) {
			lastScrollTop = top;
			return;
		}
		// Content growth increases the gap without moving scrollTop — that is not a user scroll.
		// Unstick on a real upward move; restick only after the user scrolls back to the bottom.
		// The slop absorbs iOS rubber-band overscroll settling back to the boundary.
		if (top < lastScrollTop - UNSTICK_SLOP) stick = false;
		else if (gapFromBottom() <= BOTTOM_EPS) stick = true;
		lastScrollTop = top;
	}

	function onWheel(event: WheelEvent) {
		// Unstick on the gesture itself so a pending auto-scroll rAF cannot yank back.
		if (event.deltaY < 0) stick = false;
	}

	function onTouchStart(event: TouchEvent) {
		touchStartY = event.touches[0]?.clientY ?? 0;
	}

	function onTouchMove(event: TouchEvent) {
		// Measured from the touchstart position, not the previous move - touch
		// coordinates jitter a few px even during a stationary tap (e.g. on a
		// suggestion or retry button), which would otherwise unstick on every tap.
		const y = event.touches[0]?.clientY ?? touchStartY;
		if (y > touchStartY + UNSTICK_SLOP) stick = false;
	}

	function scrollBottom(force = false) {
		if (!scrollEl) return;
		if (!(stick || force)) return;
		if (scrollFrame) return;
		scrollFrame = requestAnimationFrame(() => {
			scrollFrame = 0;
			// Recheck: the user may have scrolled up since this frame was scheduled.
			if (!(stick || force)) return;
			ignoreScroll = true;
			scrollEl.scrollTop = scrollEl.scrollHeight;
			requestAnimationFrame(() => {
				ignoreScroll = false;
			});
		});
	}

	/** Force-pin after a bulk replace so content-visibility estimates can settle. */
	function pinBottom() {
		stick = true;
		if (!scrollEl) return;
		const go = () => {
			ignoreScroll = true;
			scrollEl.scrollTop = scrollEl.scrollHeight;
		};
		go();
		requestAnimationFrame(() => {
			go();
			requestAnimationFrame(() => {
				go();
				requestAnimationFrame(() => {
					ignoreScroll = false;
				});
			});
		});
	}

	function suppressEnter() {
		skipEnter = true;
		const id = ++enterGate;
		void tick().then(() => {
			if (id === enterGate) skipEnter = false;
		});
	}

	/* ---------------- errors ---------------- */

	function fail(message: string) {
		if (message === lastError) return;
		lastError = message;
		items.push({ id: uid(), role: 'error', text: message, retry: currentRetry ?? undefined });
	}

	/* ---------------- message construction ---------------- */

	function ensureAsst(): AssistantItem {
		if (!curAsst) {
			items.push({ id: uid(), role: 'assistant', text: '', thinking: '', streaming: true });
			// Read back the reactive proxy from the $state array
			curAsst = items[items.length - 1] as AssistantItem;
		}
		return curAsst;
	}

	/**
	 * Copy text per assistant bubble, keyed by index: only the LAST assistant
	 * item in each user-delimited turn gets a non-empty entry, aggregating the
	 * text of every assistant item in that turn (earlier ones within the same
	 * turn - e.g. separated by tool calls - stay ''). Computed in one O(n) pass
	 * over `items` rather than one scan per bubble, which would be O(n) work
	 * per bubble and re-run for every bubble on every items.push() (tool
	 * calls, new turns) - O(n^2) overall as the conversation grows.
	 */
	let copyTexts = $derived.by(() => {
		const texts: string[] = new Array(items.length).fill('');
		let turnStart = 0;
		for (let i = 0; i <= items.length; i++) {
			const atEnd = i === items.length;
			if (!atEnd && items[i].role !== 'user') continue;
			// The last turn is still growing while its request is busy. Waiting
			// until it finishes prevents a temporary copy button between tool calls.
			if (!(atEnd && busy)) {
				let lastAsstIdx = -1;
				for (let j = turnStart; j < i; j++) if (items[j].role === 'assistant') lastAsstIdx = j;
				if (lastAsstIdx !== -1) {
					texts[lastAsstIdx] = items
						.slice(turnStart, i)
						.filter((candidate): candidate is AssistantItem => candidate.role === 'assistant')
						.map((candidate) => candidate.text.trim())
						.filter(Boolean)
						.join('\n\n');
				}
			}
			turnStart = i + 1;
		}
		return texts;
	});

	function markBusy(id: string, value: boolean) {
		const has = busyIds.includes(id);
		if (value && !has) busyIds = [...busyIds, id];
		else if (!value && has) busyIds = busyIds.filter((busyId) => busyId !== id);
		const convo = convos.find((c) => c.id === id);
		if (convo) convo.busy = value;
	}

	function handleEvent(event: string, d: Record<string, unknown>) {
		switch (event) {
			case 'delta': {
				const a = ensureAsst();
				// First visible text ends the thinking phase (if any).
				if (a.thinkingActive) {
					smoother.flushThinking();
					a.thinkingActive = false;
				}
				smoother.push(a, 'text', String(d.text ?? ''));
				break;
			}
			case 'thinking': {
				const a = ensureAsst();
				a.thinkingActive = true;
				smoother.push(a, 'thinking', String(d.text ?? ''));
				break;
			}
			case 'thinking_end': {
				// Thinking block finished (text/tool may still be pending).
				smoother.flushThinking();
				if (curAsst?.thinkingActive) curAsst.thinkingActive = false;
				break;
			}
			case 'tool_start':
				// The assistant segment before a tool is complete. Finalize it so a
				// thinking-only segment cannot retain the waiting indicator.
				finishAsst();
				items.push({
					id: String(d.id),
					role: 'tool',
					name: String(d.name),
					detail: toolDetail(String(d.name), d.args),
					status: 'running',
					output: '',
					details: undefined
				});
				break;
			case 'tool_end': {
				const id = String(d.id ?? '');
				const name = typeof d.name === 'string' ? d.name : '';
				// Prefer the matching call id; fall back to the most recent still-
				// running tool of the same name (or any running tool) so a missed
				// id never leaves a finished call spinning.
				const t =
					items.find((i): i is ToolItem => isTool(i) && i.id === id) ??
					[...items].reverse().find((i): i is ToolItem => isTool(i) && i.status === 'running' && (!name || i.name === name)) ??
					[...items].reverse().find((i): i is ToolItem => isTool(i) && i.status === 'running');
				if (t) {
					t.status = d.isError ? 'error' : 'done';
					t.output = String(d.output ?? '');
					const details =
						asWebDetails(d.details, name || t.name) ?? webDetailsFromOutput(t.output, name || t.name);
					if (details) t.details = details;
				}
				break;
			}
			case 'message_error':
			case 'error':
				finishAsst();
				fail(String(d.message ?? 'Something went wrong.'));
				break;
			case 'retry': {
				// The server is auto-retrying a transient provider error; the error
				// bubble just shown is superseded. Reset the dedup so an identical
				// final failure still gets displayed.
				const last = items[items.length - 1];
				if (last?.role === 'error') items.pop();
				lastError = '';
				break;
			}
			// 'done' is handled by the stream loops' finally blocks: they let the
			// smoother drain naturally (settle) instead of dumping the tail at once.
		}
	}

	/* ---------------- conversations ---------------- */

	async function loadConvos() {
		const res = await apiFetch('/api/conversations').catch(() => null);
		if (res?.ok) {
			const list = (await res.json().catch(() => null)) as ConvoSummary[] | null;
			if (Array.isArray(list)) {
				const activeRuns = new Set(list.filter((c) => c.busy).map((c) => c.id));
				for (const id of localRuns) activeRuns.add(id);
				busyIds = [...activeRuns];
				convos = list.map((c) => ({ ...c, busy: activeRuns.has(c.id) }));
			}
		}
	}

	async function fetchConvo(id: string): Promise<ConvoInfo | null> {
		const res = await apiFetch(`/api/conversations/${encodeURIComponent(id)}`).catch(() => null);
		if (!res?.ok) return null;
		return (await res.json().catch(() => null)) as ConvoInfo | null;
	}

	function showConvo(c: ConvoInfo) {
		// Pending reveal (if any) targets items being replaced; drop it.
		smoother.reset();
		suppressEnter();
		activeId = c.id;
		const convoBusy = c.busy || localRuns.has(c.id);
		items = toItems(c.items, convoBusy);
		model = c.model ?? models[0]?.id ?? '';
		thinking = c.thinking;
		markBusy(c.id, convoBusy);
		const last = items[items.length - 1];
		if (convoBusy && last?.role === 'assistant') {
			last.streaming = true;
			last.thinkingActive = Boolean(last.thinking && !last.text);
			curAsst = last;
		} else {
			curAsst = null;
		}
		lastError = '';
	}

	/**
	 * A conversation is created on the server as soon as "New chat" is clicked (so
	 * a conversationId exists for model/thinking selection before the first send).
	 * If the user then navigates away having typed nothing, that empty record
	 * would otherwise sit in the sidebar forever - sweep it away here instead.
	 * A conversation with an unsent draft is left recorded; only truly untouched
	 * ones are removed.
	 */
	async function cleanupIfEmpty() {
		const id = freshEmptyId;
		if (!id || activeId !== id || items.length > 0 || draft.trim()) return;
		freshEmptyId = null;
		convos = convos.filter((c) => c.id !== id);
		await apiFetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
	}

	async function select(id: string) {
		if (id === activeId) {
			sidebarOpen = false;
			return;
		}
		await cleanupIfEmpty();
		const c = await fetchConvo(id);
		if (!c) return;
		showConvo(c);
		if (c.busy && !localRuns.has(c.id)) void attachToRun(c.id);
		draft = '';
		sidebarOpen = false;
		pinBottom();
	}

	async function newChat() {
		// Already on an untouched empty chat - avoid piling up empty history entries.
		if (activeId !== null && items.length === 0 && !draft.trim()) {
			sidebarOpen = false;
			return;
		}
		await cleanupIfEmpty();
		const res = await apiFetch('/api/conversations', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		}).catch(() => null);
		if (!res?.ok) return;
		const c = (await res.json().catch(() => null)) as ConvoInfo | null;
		if (!c) return;
		smoother.reset();
		activeId = c.id;
		items = [];
		draft = '';
		model = c.model ?? models[0]?.id ?? '';
		thinking = c.thinking;
		curAsst = null;
		markBusy(c.id, false);
		lastError = '';
		sidebarOpen = false;
		freshEmptyId = c.id;
		await loadConvos();
	}

	function requestDelete(id: string) {
		const convo = convos.find((c) => c.id === id);
		pendingConfirm = { kind: 'delete', id, title: convo?.title || 'this chat' };
	}

	function requestLogout() {
		pendingConfirm = { kind: 'logout' };
	}

	async function confirmAction() {
		const pending = pendingConfirm;
		pendingConfirm = null;
		if (!pending) return;
		if (pending.kind === 'delete') await del(pending.id);
		else await logout();
	}

	async function del(id: string) {
		if (id === freshEmptyId) freshEmptyId = null;
		const wasActive = id === activeId;
		await apiFetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
		convos = convos.filter((c) => c.id !== id);
		if (wasActive) {
			if (convos.length > 0) {
				await select(convos[0].id);
			} else {
				// Deleted convo's id is gone server-side; clear it so newChat()'s
				// already-empty guard doesn't mistake it for a live empty chat.
				activeId = null;
				items = [];
				await newChat();
			}
		}
	}

	/* ---------------- actions ---------------- */

	/** Shared SSE loop for /api/chat and /api/retry: both push a user item first, then stream a run. */
	async function runChat(cid: string, endpoint: string, body: Record<string, unknown>) {
		localRuns.add(cid);
		markBusy(cid, true);
		curAsst = null;
		scrollBottom(true);
		let wasHidden = false;
		// The server always ends a stream with `done` (run finished) or `error`
		// (request rejected). A stream that started but ended with neither was
		// dropped mid-run (network blip, proxy timeout) while the run continues
		// server-side - reattach instead of pretending it finished.
		// A TypeError from fetch() itself is the same shape: the POST body may
		// already have been accepted, so we resync rather than show a fake
		// "Network error" over a chat that a refresh would reveal.
		let gotStream = false;
		let sawEnd = false;
		let recoverStart = false;
		try {
			const res = await apiFetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const ct = res.headers.get('content-type') ?? '';
			if (!res.ok || !ct.includes('text/event-stream') || !res.body) {
				const resBody = (await res.json().catch(() => null)) as { error?: string } | null;
				if (activeId === cid) {
					fail(resBody?.error ?? `The server returned an error (HTTP ${res.status}). Please try again.`);
				}
				return;
			}
			gotStream = true;
			for await (const { event, data } of readSse(res)) {
				if (event === 'done' || event === 'error') sawEnd = true;
				// The run continues server-side when the user switches
				// conversations; the store stays current and is re-fetched on
				// return, so skip rendering into a different conversation.
				const d = data as Record<string, unknown>;
				if (activeId !== cid) {
					wasHidden = true;
					continue;
				}
				handleEvent(event, d);
				scrollBottom();
			}
		} catch (e) {
			if (!gotStream && activeId === cid) {
				if (e instanceof TypeError) recoverStart = true;
				else fail(describeFetchError(e));
			}
		} finally {
			localRuns.delete(cid);
			const dropped = (gotStream && !sawEnd) || recoverStart;
			if (!dropped) markBusy(cid, false);
			currentRetry = null;
			if (activeId === cid) {
				// Let the last buffered text finish its reveal before finalizing.
				await smoother.settle();
				if (!dropped) {
					finishAsst();
					settleRunningTools();
					if (wasHidden) {
						const current = await fetchConvo(cid);
						if (current && activeId === cid) showConvo(current);
					}
				}
				scrollBottom();
			}
			// Dropped mid-run, or fetch() died before headers: resync. /api/attach
			// is cheap when the run already ended (sync + done), which is the
			// "refresh shows the full chat" case.
			if (dropped) void attachToRun(cid, { speculative: recoverStart });
			// Refresh titles/busy flags in the sidebar.
			void loadConvos();
		}
	}

	/**
	 * Resync with a run that's still going server-side after this tab lost its
	 * original stream (hard refresh, or switching to a busy conversation this
	 * tab didn't start). Reads /api/attach: a `sync` event with the current
	 * stored items, then live events until the run finishes.
	 */
	async function attachToRun(cid: string, opts: { speculative?: boolean; attempt?: number } = {}) {
		if (localRuns.has(cid)) return;
		localRuns.add(cid);
		const attempt = opts.attempt ?? 0;
		let sawDone = false;
		let sawError = false;
		let wasHidden = false;
		try {
			const res = await apiFetch(`/api/attach?conversationId=${encodeURIComponent(cid)}`).catch(() => null);
			const ct = res?.headers.get('content-type') ?? '';
			if (!res?.ok || !ct.includes('text/event-stream') || !res.body) {
				// Couldn't open the attach stream. Speculative recoveries (fetch()
				// TypeError before headers) may just be offline — fall through to
				// the retry/give-up path rather than spinning forever.
			} else {
				for await (const { event, data } of readSse(res)) {
					const d = data as Record<string, unknown>;
					if (event === 'done') sawDone = true;
					if (event === 'error') sawError = true;
					if (activeId !== cid) {
						wasHidden = true;
						continue;
					}
					if (event === 'sync') {
						const synced = (d.items as StoredItem[]) ?? [];
						smoother.reset();
						suppressEnter();
						items = toItems(synced, true);
						const last = items[items.length - 1];
						if (last?.role === 'assistant') {
							last.streaming = true;
							last.thinkingActive = Boolean(last.thinking && !last.text);
							curAsst = last;
						} else {
							curAsst = null;
						}
						pinBottom();
						continue;
					}
					handleEvent(event, d);
					scrollBottom();
				}
			}
		} catch {
			// Best-effort resync; leave whatever snapshot is already shown.
		} finally {
			localRuns.delete(cid);
			if (sawDone) {
				markBusy(cid, false);
				if (activeId === cid) {
					await smoother.settle();
					finishAsst();
					settleRunningTools();
				}
			}
			if (activeId === cid) {
				if (wasHidden && sawDone) {
					const current = await fetchConvo(cid);
					if (current && activeId === cid) showConvo(current);
				}
				scrollBottom();
			}
			// Ended without a verdict (network blip, server briefly unreachable)
			// while the user is still viewing: try again shortly. A finished run
			// resolves instantly (sync + done); a rejected attach sends `error`.
			// Speculative attaches (fetch() died before headers — we don't know
			// if the server accepted the turn) give up after a few tries so a
			// truly offline send doesn't lock the composer. Known-busy attaches
			// keep retrying: the run is still going server-side.
			if (!sawDone && !sawError && activeId === cid) {
				if (!opts.speculative || attempt < 4) {
					setTimeout(() => {
						if (activeId === cid && !localRuns.has(cid)) {
							void attachToRun(cid, { speculative: opts.speculative, attempt: attempt + 1 });
						}
					}, 1000);
				} else {
					markBusy(cid, false);
					if (activeId === cid) {
						fail('Network error - check your connection and try again.');
					}
				}
			}
			void loadConvos();
		}
	}

	async function send(text: string, images: ImageAttachment[] = []) {
		if (busy || (!text.trim() && images.length === 0) || !activeId) return;
		const cid = activeId;
		lastError = '';
		const insertAt = items.length;
		items.push({ id: uid(), role: 'user', text, images: images.length ? images : undefined });
		// If this attempt fails outright, retry drops the failed bubble(s) and resends cleanly.
		currentRetry = () => {
			items = items.slice(0, insertAt);
			void send(text, images);
		};
		await runChat(cid, '/api/chat', { text, conversationId: cid, images });
	}

	/** Walk back from `index` to the nearest user item (assistant/error retries target their user turn). */
	function userIndexFor(index: number): number {
		let i = index;
		while (i >= 0 && items[i]?.role !== 'user') i--;
		return i;
	}

	async function retry(index: number) {
		if (busy || !activeId) return;
		const userIdx = userIndexFor(index);
		const target = userIdx >= 0 ? (items[userIdx] as { text: string; images?: ImageAttachment[] }) : null;
		const text = target?.text ?? '';
		if (!text && !target?.images?.length) return;
		const cid = activeId;
		lastError = '';
		items = [...items.slice(0, userIdx), { id: uid(), role: 'user', text, images: target?.images }];
		// Re-run with the resolved user index, not the original click target, so a
		// retry-of-a-retry still lands on the same (now-refreshed) turn.
		currentRetry = () => void retry(userIdx);
		await runChat(cid, '/api/retry', { conversationId: cid, index: userIdx });
	}

	function stop() {
		if (!activeId) return;
		void apiFetch('/api/abort', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ conversationId: activeId })
		}).catch(() => {});
	}

	async function changeModel(id: string) {
		if (busy || id === model || !activeId) return;
		const prev = model;
		model = id;
		const res = await apiFetch('/api/set-model', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, conversationId: activeId })
		}).catch(() => null);
		if (!res?.ok) {
			model = prev;
			const body = (await res?.json().catch(() => null)) as { error?: string } | null;
			fail(body?.error ?? `Could not switch model`);
		}
	}

	async function changeThinking(level: string) {
		if (busy || level === thinking || !activeId) return;
		const prev = thinking;
		thinking = level;
		const res = await apiFetch('/api/set-thinking', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ level, conversationId: activeId })
		}).catch(() => null);
		if (!res?.ok) {
			thinking = prev;
			const body = (await res?.json().catch(() => null)) as { error?: string } | null;
			fail(body?.error ?? `Could not change thinking level`);
			return;
		}
		// The server clamps to the model's supported levels; show the effective one.
		const body = (await res.json().catch(() => null)) as { effective?: string } | null;
		if (body?.effective) thinking = body.effective;
	}

	/* ---------------- init ---------------- */

	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
		setTheme(theme);
	}

	onMount(() => {
		theme = initTheme();
	});

	onMount(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;

		let frame = 0;
		let settleTimer = 0;
		const isTextEntry = (target: EventTarget | null) =>
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			(target instanceof HTMLElement && target.isContentEditable);
		const clearViewportOverride = () => {
			appEl.style.removeProperty('--viewport-height');
			appEl.style.removeProperty('--viewport-offset-top');
		};
		const syncViewport = () => {
			if (frame) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (viewport.scale !== 1 || isTextEntry(document.activeElement)) {
					clearViewportOverride();
					return;
				}

				// Mobile WebKit can pan the visual viewport to reveal the composer
				// without scrolling the document, then retain that pan after blur.
				// Leave keyboard opening to the browser and correct only after blur.
				const pageOffset = viewport.pageTop - window.scrollY;
				const offsetTop = Math.max(0, viewport.offsetTop, pageOffset);
				appEl.style.setProperty('--viewport-height', `${viewport.height}px`);
				appEl.style.setProperty('--viewport-offset-top', `${offsetTop}px`);
			});
		};
		const beginEditing = (event: FocusEvent) => {
			if (!isTextEntry(event.target)) return;
			window.clearTimeout(settleTimer);
			clearViewportOverride();
		};
		const settleViewport = (event: FocusEvent) => {
			// Only a text entry losing focus can have left the keyboard-pan
			// behind. A blur from anything else (a button removed from the DOM
			// when busy flips, a tap on the sidebar) must not re-run this and
			// stomp an unrelated, already-correct offset.
			if (!isTextEntry(event.target)) return;
			syncViewport();
			window.clearTimeout(settleTimer);
			settleTimer = window.setTimeout(syncViewport, 350);
		};

		syncViewport();
		viewport.addEventListener('resize', syncViewport);
		viewport.addEventListener('scroll', syncViewport);
		window.addEventListener('resize', syncViewport);
		document.addEventListener('focusin', beginEditing);
		document.addEventListener('focusout', settleViewport);

		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.clearTimeout(settleTimer);
			viewport.removeEventListener('resize', syncViewport);
			viewport.removeEventListener('scroll', syncViewport);
			window.removeEventListener('resize', syncViewport);
			document.removeEventListener('focusin', beginEditing);
			document.removeEventListener('focusout', settleViewport);
		};
	});

	async function initialize() {
		ready = false;
		convos = [];
		activeId = null;
		items = [];
		models = [];
		modelsLoaded = false;
		busyIds = [];

		// Don't block the shell on the model catalog. A hung /api/models used to
		// leave the loading screen up forever after a mid-run refresh.
		const modelsPromise = apiFetch('/api/models')
			.then(async (res) => {
				if (!res.ok) return;
				const body = (await res.json().catch(() => null)) as {
					models?: { id: string; name: string; provider: string }[];
				} | null;
				models = body?.models ?? [];
			})
			.catch(() => {})
			.finally(() => {
				modelsLoaded = true;
			});

		await loadConvos();
		if (convos.length === 0) {
			await newChat();
		} else {
			await select(convos[0].id);
		}
		ready = true;
		void modelsPromise;
	}

	async function authenticated() {
		authState = 'authenticated';
		await initialize();
	}

	async function logout() {
		await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
		finishAsst();
		localRuns.clear();
		convos = [];
		items = [];
		models = [];
		activeId = null;
		busyIds = [];
		ready = false;
		authConfigured = true;
		authState = 'required';
	}

	onMount(() => {
		const sweepEmptyOnUnload = () => {
			if (!freshEmptyId || activeId !== freshEmptyId || items.length > 0 || draft.trim()) return;
			fetch(`/api/conversations/${encodeURIComponent(freshEmptyId)}`, { method: 'DELETE', keepalive: true }).catch(
				() => {}
			);
		};
		window.addEventListener('pagehide', sweepEmptyOnUnload);
		return () => window.removeEventListener('pagehide', sweepEmptyOnUnload);
	});

	onMount(async () => {
		const response = await fetch('/api/auth/status').catch(() => null);
		const status = (await response?.json().catch(() => null)) as {
			configured?: boolean;
			authenticated?: boolean;
		} | null;
		authConfigured = response ? Boolean(status?.configured) : null;
		if (response?.ok && status?.authenticated) {
			await authenticated();
		} else {
			authState = 'required';
		}
	});
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && lightboxSrc && (lightboxSrc = null)} />

<div class="app" bind:this={appEl} inert={!appInteractive} aria-hidden={!appInteractive}>
	<Sidebar
		open={sidebarOpen}
		conversations={convos}
		activeId={activeId}
		onNew={newChat}
		onSelect={select}
		onDelete={requestDelete}
		onClose={() => (sidebarOpen = false)}
	/>

	<div class="shell">
		<Header
			{model}
			{models}
			{thinking}
			{busy}
			{theme}
			onModel={changeModel}
			onThinking={changeThinking}
			onNew={newChat}
			onMenu={() => (sidebarOpen = !sidebarOpen)}
			onLogout={requestLogout}
			onToggleTheme={toggleTheme}
		/>

		<div
			class="main"
			bind:this={scrollEl}
			role="region"
			aria-label="Conversation"
			onscroll={onScroll}
			onwheel={onWheel}
			ontouchstart={onTouchStart}
			ontouchmove={onTouchMove}
		>
			<div class="thread" class:busy>
				{#if ready && items.length === 0}
					<div class="empty">
						<div class="big">What's moving the market?</div>
						<div class="sub">
							Ask about a ticker, sector, or headline. Keva can pull the latest data and news, then break down what actually matters.
						</div>
						<div class="sugs">
							{#each SUGGESTIONS as s (s)}
								<button class="sug" onclick={() => send(s)} disabled={busy}>{s}</button>
							{/each}
						</div>
						{#if modelsLoaded && models.length === 0}
							<div class="note">
								No model available. Set a provider API key in <code>.env</code>, then restart the server.
							</div>
						{/if}
					</div>
				{:else}
					{#each items as item, index (item.id)}
						{#if item.role === 'user'}
							<div class="msg user" transition:fade={fadeIn}>
								{#if item.images?.length}
									<div class="msg-images">
										{#each item.images as img, i (i)}
											<button
												type="button"
												class="msg-thumb"
												onclick={() => (lightboxSrc = `data:${img.mimeType};base64,${img.data}`)}
											>
												<img src={`data:${img.mimeType};base64,${img.data}`} alt="Attachment" />
											</button>
										{/each}
									</div>
								{/if}
								{#if item.text}
									<div class="bubble">{item.text}</div>
								{/if}
								<div class="copy-row">
									<CopyMessage text={item.text} />
									<RetryMessage onRetry={() => retry(index)} disabled={busy} />
								</div>
							</div>
						{:else if item.role === 'assistant'}
							{@const copyText = copyTexts[index] ?? ''}
							{#if item.text || item.thinking || item.streaming}
								<div class="msg assistant" class:streaming={item.streaming} transition:fade={fadeIn}>
									<MessageItem item={item} />
									{#if copyText}
										<div class="copy-row">
											<CopyMessage text={copyText} />
											<RetryMessage onRetry={() => retry(index)} disabled={busy} />
										</div>
									{/if}
								</div>
							{/if}
						{:else if item.role === 'tool'}
							<div transition:fade={fadeIn}>
								{#if isWebTool(item)}
									<WebTool item={item} />
								{:else}
									<ToolLine item={item} />
								{/if}
							</div>
						{:else}
							<div class="msg error" transition:fade={fadeIn}>
								{item.text}
								{#if item.retry}
									<div class="copy-row">
										<RetryMessage onRetry={item.retry} disabled={busy} />
									</div>
								{/if}
							</div>
						{/if}
					{/each}
				{/if}
			</div>
		</div>

		{#key activeId}
			<Composer bind:text={draft} {busy} onSend={send} onStop={stop} />
		{/key}
	</div>
</div>

{#if authState === 'required'}
	<LoginGate configured={authConfigured} onAuthenticated={authenticated} />
{/if}

{#if showLoadingScreen}
	<LoadingScreen />
{/if}

{#if pendingConfirm}
	<ConfirmDialog
		title={pendingConfirm.kind === 'delete' ? 'Delete chat?' : 'Sign out?'}
		message={pendingConfirm.kind === 'delete'
			? `“${pendingConfirm.title}” will be permanently deleted.`
			: 'You will need to sign in again to continue.'}
		confirmLabel={pendingConfirm.kind === 'delete' ? 'Delete' : 'Sign out'}
		danger={pendingConfirm.kind === 'delete'}
		onConfirm={() => void confirmAction()}
		onCancel={() => (pendingConfirm = null)}
	/>
{/if}

{#if lightboxSrc}
	<div
		class="lightbox"
		role="dialog"
		aria-modal="true"
		aria-label="Image preview"
		tabindex="-1"
		transition:fade={{ duration: 120 }}
		onclick={() => (lightboxSrc = null)}
		onkeydown={(e) => e.key === 'Enter' && (lightboxSrc = null)}
	>
		<button type="button" class="lightbox-close" onclick={() => (lightboxSrc = null)} aria-label="Close">
			<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
				<path d="M1.5 1.5l11 11M12.5 1.5l-11 11" stroke="currentColor" stroke-width="1.4" />
			</svg>
		</button>
		<div class="lightbox-frame" role="presentation" onclick={(e) => e.stopPropagation()}>
			<img src={lightboxSrc} alt="Attachment preview at full size" />
		</div>
	</div>
{/if}
