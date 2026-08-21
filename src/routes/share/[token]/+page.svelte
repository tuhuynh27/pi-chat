<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import MessageItem from '$lib/components/MessageItem.svelte';
	import ToolLine from '$lib/components/ToolLine.svelte';
	import WebTool from '$lib/components/WebTool.svelte';
	import { isWebTool, toItems, type Item, type StoredItem } from '$lib/types';

	// Read-only guest view of a shared conversation. No composer, no sidebar,
	// no retry/copy actions — the snapshot is fetched once and rendered as-is.
	const token = $page.params.token;
	let title = $state('');
	let items = $state<Item[]>([]);
	let status = $state<'loading' | 'ok' | 'notfound'>('loading');

	onMount(async () => {
		if (!token) {
			status = 'notfound';
			return;
		}
		const res = await fetch(`/api/share/${encodeURIComponent(token)}`).catch(() => null);
		if (!res?.ok) {
			status = 'notfound';
			return;
		}
		const body = (await res.json().catch(() => null)) as {
			title?: string;
			items?: StoredItem[];
		} | null;
		if (!body) {
			status = 'notfound';
			return;
		}
		title = body.title ?? '';
		items = toItems(body.items ?? [], false);
		status = 'ok';
	});
</script>

<div class="share-app">
	<header class="header">
		<div class="hdr-left">
			<div class="brand">
				<span class="logo">K</span>
				<span class="title">Keva Chat</span>
			</div>
		</div>
		<span class="shared-badge">Shared · read-only</span>
	</header>

	<div class="main">
		{#if status === 'notfound'}
			<div class="empty">
				<div class="mark" aria-hidden="true">K</div>
				<div class="big">This shared conversation is no longer available.</div>
				<div class="sub">The link may have expired, or the conversation was deleted.</div>
			</div>
		{:else if status === 'loading'}
			<div class="empty">
				<div class="sub">Loading conversation…</div>
			</div>
		{:else}
			<div class="thread">
				{#if title}
					<div class="share-title">{title}</div>
				{/if}
				{#each items as item (item.id)}
					{#if item.role === 'user'}
						<div class="msg user">
							{#if item.images?.length}
								<div class="share-images">
									{#each item.images as img (img.mimeType + img.data.length)}
										<img src={`data:${img.mimeType};base64,${img.data}`} alt="Attachment" />
									{/each}
								</div>
							{/if}
							{#if item.text}
								<div class="bubble">{item.text}</div>
							{/if}
						</div>
					{:else if item.role === 'assistant'}
						{#if item.text || item.thinking}
							<div class="msg assistant">
								<MessageItem item={item} />
							</div>
						{/if}
					{:else if item.role === 'tool'}
						{#if isWebTool(item)}
							<WebTool item={item} />
						{:else}
							<ToolLine item={item} />
						{/if}
					{:else}
						<div class="msg error">{item.text}</div>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.share-app {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
	}

	.shared-badge {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
		border: 1px solid var(--line);
		background: var(--soft);
		padding: 3px 9px;
	}

	.share-title {
		font-size: 15px;
		font-weight: 650;
		letter-spacing: -0.01em;
		margin-bottom: 20px;
	}

	.share-images {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
		max-width: min(85%, 640px);
		margin-bottom: 6px;
	}

	.share-images img {
		display: block;
		width: 160px;
		height: 160px;
		object-fit: cover;
		border: 1px solid var(--line);
		background: var(--soft);
	}
</style>
