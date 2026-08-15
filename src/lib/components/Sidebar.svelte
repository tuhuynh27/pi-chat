<script lang="ts">
	import type { ConvoSummary } from '$lib/types';

	let {
		open,
		conversations,
		activeId,
		onNew,
		onSelect,
		onDelete,
		onClose
	}: {
		open: boolean;
		conversations: ConvoSummary[];
		activeId: string | null;
		onNew: () => void;
		onSelect: (id: string) => void;
		onDelete: (id: string) => void;
		onClose: () => void;
	} = $props();

	function timeAgo(ts: number): string {
		const s = Math.max(0, (Date.now() - ts) / 1000);
		if (s < 60) return 'now';
		if (s < 3600) return `${Math.floor(s / 60)}m`;
		if (s < 86400) return `${Math.floor(s / 3600)}h`;
		return `${Math.floor(s / 86400)}d`;
	}
</script>

{#if open}
	<div class="backdrop" onclick={onClose} aria-hidden="true"></div>
{/if}

<aside class="sidebar" class:open={open}>
	<div class="side-head">
		<span class="brand"><span class="logo">π</span> pi chat</span>
		<button class="icon-btn" onclick={onClose} aria-label="Close sidebar">
			<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
				<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" />
			</svg>
		</button>
	</div>

	<button class="new" onclick={onNew}>
		<svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
			<path d="M5.5 1v9M1 5.5h9" stroke="currentColor" stroke-width="1.5" fill="none" />
		</svg>
		New chat
	</button>

	<nav class="list" aria-label="Conversations">
		{#each conversations as c (c.id)}
			<div
				class="row"
				class:active={c.id === activeId}
				role="button"
				tabindex="0"
				onclick={() => onSelect(c.id)}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						onSelect(c.id);
					}
				}}
			>
				<span class="title">{c.title}</span>
				<span class="meta">{c.busy ? '…' : timeAgo(c.updatedAt)}</span>
				<button class="del" aria-label="Delete conversation"
					onclick={(e) => {
						e.stopPropagation();
						onDelete(c.id);
					}}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.stopPropagation();
							onDelete(c.id);
						}
					}}
				>
					<svg width="10" height="10" viewBox="0 0 11 11" aria-hidden="true">
						<path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" stroke-width="1.5" fill="none" />
					</svg>
				</button>
			</div>
		{:else}
			<div class="none">No conversations yet</div>
		{/each}
	</nav>
</aside>
