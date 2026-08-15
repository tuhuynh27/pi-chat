<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import Header from '$lib/components/Header.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import MessageItem from '$lib/components/MessageItem.svelte';
	import ToolLine from '$lib/components/ToolLine.svelte';
	import ExaTool from '$lib/components/ExaTool.svelte';
	import Composer from '$lib/components/Composer.svelte';
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
	let busy = $state(false);
	let models = $state<{ id: string; name: string; provider: string }[]>([]);
	let model = $state('');
	let thinking = $state('off');
	let sidebarOpen = $state(typeof window !== 'undefined' && window.matchMedia('(min-width: 720px)').matches);
	let modelsLoaded = $state(false);
	let ready = $state(false);

	let curAsst: AssistantItem | null = null;

	function finishAsst() {
		if (curAsst) {
			curAsst.streaming = false;
			curAsst.thinkingActive = false;
		}
		curAsst = null;
	}
	let lastError = '';
	let scrollEl: HTMLDivElement;
	let stick = true;

	/* ---------------- scrolling ---------------- */

	function onScroll() {
		stick = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
	}

	function scrollBottom(force = false) {
		if (!scrollEl) return;
		if (stick || force) {
			requestAnimationFrame(() => {
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
				a.thinking += String(d.text ?? '');
				break;
			}
			case 'thinking_end': {
				// Thinking block finished (text/tool may still be pending).
				if (curAsst?.thinkingActive) curAsst.thinkingActive = false;
				break;
			}
			case 'tool_start':
				if (curAsst?.thinkingActive) curAsst.thinkingActive = false;
				items.push({
					id: String(d.id),
					role: 'tool',
					name: String(d.name),
					detail: toolDetail(String(d.name), d.args),
					status: 'running',
					output: '',
					details: undefined
				});
				curAsst = null; // next text starts a fresh bubble after the tool row
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
				fail(String(d.message ?? 'Something went wrong.'));
				break;
			case 'done':
				break;
		}
	}

	/* ---------------- conversations ---------------- */

	async function loadConvos() {
		const res = await fetch('/api/conversations').catch(() => null);
		if (res?.ok) {
			const list = (await res.json().catch(() => null)) as ConvoSummary[] | null;
			if (Array.isArray(list)) convos = list;
		}
	}

	async function select(id: string) {
		if (id === activeId) {
			sidebarOpen = false;
			return;
		}
		const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`).catch(() => null);
		if (!res?.ok) return;
		const c = (await res.json().catch(() => null)) as ConvoInfo | null;
		if (!c) return;
		activeId = c.id;
		items = toItems(c.items);
		model = c.model ?? models[0]?.id ?? '';
		thinking = c.thinking;
		curAsst = null;
		lastError = '';
		sidebarOpen = false;
		scrollBottom(true);
	}

	async function newChat() {
		const res = await fetch('/api/conversations', {
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
		lastError = '';
		sidebarOpen = false;
		await loadConvos();
	}

	async function del(id: string) {
		const wasActive = id === activeId;
		await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
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
		busy = true;
		curAsst = null;
		scrollBottom(true);
		try {
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text, conversationId: cid })
			});
			const ct = res.headers.get('content-type') ?? '';
			if (!res.ok || !ct.includes('text/event-stream') || !res.body) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				fail(body?.error ?? `Request failed (${res.status})`);
				return;
			}
			for await (const { event, data } of readSse(res)) {
				// The run continues server-side when the user switches
				// conversations; the store stays current and is re-fetched on
				// return, so skip rendering into a different conversation.
				if (activeId !== cid) continue;
				handleEvent(event, data as Record<string, unknown>);
				scrollBottom();
			}
		} catch (e) {
			fail(e instanceof Error ? e.message : String(e));
		} finally {
			finishAsst();
			busy = false;
			scrollBottom();
			// Refresh titles/busy flags in the sidebar.
			void loadConvos();
		}
	}

	function stop() {
		void fetch('/api/abort', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		}).catch(() => {});
	}

	async function changeModel(id: string) {
		if (busy || id === model || !activeId) return;
		const prev = model;
		model = id;
		const res = await fetch('/api/set-model', {
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
		const res = await fetch('/api/set-thinking', {
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

	onMount(async () => {
		const res = await fetch('/api/models').catch(() => null);
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
	});
</script>

<div class="app">
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
								No model available. Set an API key in the server environment — e.g.
								<code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> — or log in once with the
								<code>pi</code> CLI, then restart.
							</div>
						{/if}
					</div>
				{:else}
					{#each items as item (item.id)}
						{#if item.role === 'user'}
							<div class="msg user" transition:fade={{ duration: 140 }}>
								<div class="bubble">{item.text}</div>
							</div>
						{:else if item.role === 'assistant'}
							{#if item.text || item.thinking || item.streaming}
								<div class="msg assistant" transition:fade={{ duration: 140 }}>
									<MessageItem item={item} />
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
