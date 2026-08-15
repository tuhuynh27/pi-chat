<script lang="ts">
	import type { ToolItem } from '$lib/types';

	let { item }: { item: ToolItem } = $props();

	let touched = $state(false);
	// Auto-open when the run finishes so results are visible; stop forcing
	// once the user has toggled the panel themselves.
	let autoOpen = $derived(!touched && (item.status === 'done' || item.status === 'error'));

	let details = $derived(item.details);
	let isSearch = $derived(details?.kind === 'search');
	let label = $derived(isSearch ? 'Exa search' : 'Exa fetch');
	let meta = $derived(
		details
			? `${details.itemCount} ${details.kind === 'search' ? 'result' : 'page'}${details.itemCount === 1 ? '' : 's'}${
					details.searchTimeMs !== undefined ? ` · ${(details.searchTimeMs / 1000).toFixed(1)}s` : ''
				}`
			: isSearch
				? 'searching…'
				: 'fetching…'
	);
</script>

<details
	class="exa"
	class:running={item.status === 'running'}
	class:error={item.status === 'error'}
	class:open={autoOpen}
	ontoggle={() => (touched = true)}
>
	<summary>
		<span class="dot" aria-hidden="true"></span>
		<span class="tname">{label}</span>
		{#if item.detail}<span class="tdetail">{item.detail}</span>{/if}
		<span class="meta">{meta}</span>
	</summary>
	{#if details}
		<div class="body">
			{#each details.items as it (it.url + it.title)}
				<div class="res">
					<div class="rt">
						{it.title}
						{#if it.status && it.status !== 'success'}
							<span class="rstat" class:bad={it.status !== 'success'}>{it.status}</span>
						{/if}
					</div>
					<div class="ru">{it.url}</div>
					{#if it.preview}<div class="rp">{it.preview}</div>{/if}
				</div>
			{:else}
				<div class="res empty">No results</div>
			{/each}
		</div>
	{/if}
</details>
