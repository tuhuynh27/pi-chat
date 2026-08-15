<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import Header from '$lib/components/Header.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import MessageItem from '$lib/components/MessageItem.svelte';
	import CopyMessage from '$lib/components/CopyMessage.svelte';
	import ToolLine from '$lib/components/ToolLine.svelte';
	import ExaTool from '$lib/components/ExaTool.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import LoginGate from '$lib/components/LoginGate.svelte';
	import { readSse } from '$lib/sse';
	import {
		isExaTool,
		isTool,
		toolDetail,
		uid,
		toItems,
		type AssistantItem,
		type ConvoInfo,
		type ConvoSummary,
		type ExaDetails,
		type Item,
		type ToolItem
	} from '$lib/types';

	const SUGGESTIONS = [
		'What can you help me with?',
		'Search the web for the latest Svelte release notes',
		'Write a small node script that prints the first 10 Fibonacci numbers'
	];

	let convos = $state<ConvoSummary[]>([]);
	let activeId = $state<string | null>(null);
	let items = $state<Item[]>([]);
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

	let curAsst: AssistantItem | null = null;
	const localRuns = new Set<string>();
	const THINKING_CAP = 32000;

	function finishAsst() {
		if (curAsst) {
			curAsst.streaming = false;
			curAsst.thinkingActive = false;
		}
		curAsst = null;
	}
	let lastError = '';
	let appEl: HTMLDivElement;
	let scrollEl: HTMLDivElement;
	let stick = true;
	let scrollFrame = 0;

	async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const response = await fetch(input, init);
		if (response.status === 401) {
			authConfigured = true;
			authState = 'required';
		}
		return response;
	}

	/* ---------------- scrolling ---------------- */

	function onScroll() {
		stick = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
	}

	function scrollBottom(force = false) {
		if (!scrollEl) return;
		if (stick || force) {
			if (scrollFrame) return;
			scrollFrame = requestAnimationFrame(() => {
				scrollFrame = 0;
				scrollEl.scrollTop = scrollEl.scrollHeight;
			});
		}
	}

	/* ---------------- errors ---------------- */

	function fail(message: string) {
		if (message === lastError) return;
		lastError = message;
		items.push({ id: uid(), role: 'error', text: message });
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

	function copyTextForAssistant(index: number): string {
		if (items[index]?.role !== 'assistant') return '';

		let end = index + 1;
		while (end < items.length && items[end].role !== 'user') {
			if (items[end].role === 'assistant') return '';
			end += 1;
		}

		// The last turn is still growing while its request is busy. Waiting until
		// it finishes prevents a temporary copy button between tool calls.
		if (end === items.length && busy) return '';

		let start = index;
		while (start > 0 && items[start - 1].role !== 'user') start -= 1;

		return items
			.slice(start, end)
			.filter((candidate): candidate is AssistantItem => candidate.role === 'assistant')
			.map((candidate) => candidate.text.trim())
			.filter(Boolean)
			.join('\n\n');
	}

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
				if (a.thinkingActive) a.thinkingActive = false;
				a.text += String(d.text ?? '');
				break;
			}
			case 'thinking': {
				const a = ensureAsst();
				a.thinkingActive = true;
				a.thinking = (a.thinking + String(d.text ?? '')).slice(-THINKING_CAP);
				break;
			}
			case 'thinking_end': {
				// Thinking block finished (text/tool may still be pending).
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
				const t = items.find((i): i is ToolItem => isTool(i) && i.id === String(d.id));
				if (t) {
					t.status = d.isError ? 'error' : 'done';
					t.output = String(d.output ?? '');
					const details = d.details as ExaDetails | null | undefined;
					if (details && (details.kind === 'search' || details.kind === 'fetch')) {
						t.details = details;
					}
				}
				break;
			}
			case 'message_error':
			case 'error':
				finishAsst();
				fail(String(d.message ?? 'Something went wrong.'));
				break;
			case 'done':
				finishAsst();
				break;
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
		activeId = c.id;
		items = toItems(c.items);
		model = c.model ?? models[0]?.id ?? '';
		thinking = c.thinking;
		const convoBusy = c.busy || localRuns.has(c.id);
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

	async function select(id: string) {
		if (id === activeId) {
			sidebarOpen = false;
			return;
		}
		const c = await fetchConvo(id);
		if (!c) return;
		showConvo(c);
		sidebarOpen = false;
		scrollBottom(true);
	}

	async function newChat() {
		const res = await apiFetch('/api/conversations', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		}).catch(() => null);
		if (!res?.ok) return;
		const c = (await res.json().catch(() => null)) as ConvoInfo | null;
		if (!c) return;
		activeId = c.id;
		items = [];
		model = c.model ?? model;
		thinking = c.thinking;
		curAsst = null;
		markBusy(c.id, false);
		lastError = '';
		sidebarOpen = false;
		await loadConvos();
	}

	async function del(id: string) {
		const wasActive = id === activeId;
		await apiFetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
		convos = convos.filter((c) => c.id !== id);
		if (wasActive) {
			if (convos.length > 0) await select(convos[0].id);
			else await newChat();
		}
	}

	/* ---------------- actions ---------------- */

	async function send(text: string) {
		if (busy || !text.trim() || !activeId) return;
		const cid = activeId;
		lastError = '';
		items.push({ id: uid(), role: 'user', text });
		localRuns.add(cid);
		markBusy(cid, true);
		curAsst = null;
		scrollBottom(true);
		let wasHidden = false;
		try {
			const res = await apiFetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text, conversationId: cid })
			});
			const ct = res.headers.get('content-type') ?? '';
			if (!res.ok || !ct.includes('text/event-stream') || !res.body) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				if (activeId === cid) fail(body?.error ?? `Request failed (${res.status})`);
				return;
			}
			for await (const { event, data } of readSse(res)) {
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
			if (activeId === cid) fail(e instanceof Error ? e.message : String(e));
		} finally {
			localRuns.delete(cid);
			markBusy(cid, false);
			if (activeId === cid) {
				finishAsst();
				if (wasHidden) {
					const current = await fetchConvo(cid);
					if (current && activeId === cid) showConvo(current);
				}
				scrollBottom();
			}
			// Refresh titles/busy flags in the sidebar.
			void loadConvos();
		}
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

	onMount(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;

		let frame = 0;
		let settleTimer = 0;
		const syncViewport = () => {
			if (frame) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (viewport.scale !== 1) {
					appEl.style.removeProperty('--viewport-height');
					appEl.style.removeProperty('--viewport-offset-top');
					return;
				}

				// Mobile WebKit can pan the visual viewport to reveal the composer
				// without scrolling the document, then retain that pan after blur.
				// Size and anchor the shell to the portion that is actually visible.
				const pageOffset = viewport.pageTop - window.scrollY;
				const offsetTop = Math.max(0, viewport.offsetTop, pageOffset);
				appEl.style.setProperty('--viewport-height', `${viewport.height}px`);
				appEl.style.setProperty('--viewport-offset-top', `${offsetTop}px`);
			});
		};
		const settleViewport = () => {
			syncViewport();
			window.clearTimeout(settleTimer);
			settleTimer = window.setTimeout(syncViewport, 350);
		};

		syncViewport();
		viewport.addEventListener('resize', syncViewport);
		viewport.addEventListener('scroll', syncViewport);
		window.addEventListener('resize', syncViewport);
		document.addEventListener('focusout', settleViewport);

		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.clearTimeout(settleTimer);
			viewport.removeEventListener('resize', syncViewport);
			viewport.removeEventListener('scroll', syncViewport);
			window.removeEventListener('resize', syncViewport);
			document.removeEventListener('focusout', settleViewport);
		};
	});

	async function initialize() {
		ready = false;
		convos = [];
		activeId = null;
		items = [];
		models = [];
		busyIds = [];

		const res = await apiFetch('/api/models').catch(() => null);
		if (res?.ok) {
			const body = (await res.json().catch(() => null)) as {
				models?: { id: string; name: string; provider: string }[];
			} | null;
			models = body?.models ?? [];
		}
		modelsLoaded = true;

		await loadConvos();
		if (convos.length === 0) {
			await newChat();
		} else {
			await select(convos[0].id);
		}
		ready = true;
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

	onMount(async () => {
		const response = await fetch('/api/auth/status').catch(() => null);
		const status = (await response?.json().catch(() => null)) as {
			configured?: boolean;
			authenticated?: boolean;
		} | null;
		authConfigured = Boolean(status?.configured);
		if (response?.ok && status?.authenticated) {
			await authenticated();
		} else {
			authState = 'required';
		}
	});
</script>

<div class="app" bind:this={appEl} inert={authState !== 'authenticated'} aria-hidden={authState !== 'authenticated'}>
	<Sidebar
		open={sidebarOpen}
		conversations={convos}
		activeId={activeId}
		onNew={newChat}
		onSelect={select}
		onDelete={del}
		onClose={() => (sidebarOpen = false)}
	/>

	<div class="shell">
		<Header
			{model}
			{models}
			{thinking}
			{busy}
			onModel={changeModel}
			onThinking={changeThinking}
			onNew={newChat}
			onMenu={() => (sidebarOpen = !sidebarOpen)}
			onLogout={logout}
		/>

		<div class="main" bind:this={scrollEl} onscroll={onScroll}>
			<div class="thread">
				{#if ready && items.length === 0}
					<div class="empty">
						<div class="big">Ask anything</div>
						<div class="sub">
							Pi is a coding agent in an isolated workspace. It reads, writes, runs code, and searches the web.
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
							<div class="msg user" transition:fade={{ duration: 140 }}>
								<div class="bubble">{item.text}</div>
								<CopyMessage text={item.text} />
							</div>
						{:else if item.role === 'assistant'}
							{@const copyText = copyTextForAssistant(index)}
							{#if item.text || item.thinking || item.streaming}
								<div class="msg assistant" transition:fade={{ duration: 140 }}>
									<MessageItem item={item} />
									{#if copyText}<CopyMessage text={copyText} />{/if}
								</div>
							{/if}
						{:else if item.role === 'tool'}
							<div transition:fade={{ duration: 140 }}>
								{#if isExaTool(item)}
									<ExaTool item={item} />
								{:else}
									<ToolLine item={item} />
								{/if}
							</div>
						{:else}
							<div class="msg error" transition:fade={{ duration: 140 }}>{item.text}</div>
						{/if}
					{/each}
				{/if}
			</div>
		</div>

		<Composer {busy} onSend={send} onStop={stop} />
	</div>
</div>

{#if authState !== 'authenticated'}
	<LoginGate
		checking={authState === 'checking'}
		configured={authConfigured}
		onAuthenticated={authenticated}
	/>
{/if}
