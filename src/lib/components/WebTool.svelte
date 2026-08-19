<script lang="ts">
	import { webToolKind, type ToolItem } from '$lib/types';

	let { item }: { item: ToolItem } = $props();

	let kind = $derived(webToolKind(item.name));
	// Details arriving is enough to treat the call as finished even if a
	// missed tool_end left status stuck on `running`.
	let status = $derived(item.status === 'running' && item.details ? 'done' : item.status);
	let details = $derived(item.details);
	let label = $derived(
		status === 'running'
			? kind === 'search'
				? 'searching'
				: 'fetching'
			: kind === 'search'
				? 'web search'
				: 'web fetch'
	);
	let meta = $derived.by(() => {
		if (status === 'error') return 'failed';
		if (!details) return '';
		const noun = details.kind === 'fetch' ? 'page' : 'source';
		if (details.itemCount === 0) return 'no results';
		return `${details.itemCount} ${noun}${details.itemCount === 1 ? '' : 's'}`;
	});
	let expandable = $derived(Boolean(details) || (status === 'error' && Boolean(item.output)));

	function host(url: string): string {
		try {
			return new URL(url).hostname.replace(/^www\./, '');
		} catch {
			return url;
		}
	}
</script>

{#snippet head()}
	<span class="wname">{label}</span>
	{#if item.detail}<span class="wdetail">{item.detail}</span>{/if}
	{#if status === 'running'}
		<span class="tdots" aria-hidden="true"><i>·</i><i>·</i><i>·</i></span>
	{:else if meta}
		<span class="wmeta">{meta}</span>
	{/if}
{/snippet}

{#if expandable}
	<details class="web" class:error={status === 'error'}>
		<summary>{@render head()}</summary>
		<div class="wbody">
			{#if details}
				{#each details.items as it, i (`${it.url}:${i}`)}
					<div class="wres">
						<div class="wtop">
							{#if it.url}
								<a class="wtitle" href={it.url} target="_blank" rel="noopener noreferrer">{it.title || it.url}</a>
							{:else}
								<span class="wtitle">{it.title || 'Untitled'}</span>
							{/if}
							{#if it.url}
								<span class="whost">{host(it.url)}</span>
							{/if}
							{#if it.status && it.status !== 'success'}
								<span class="wstat">{it.status}</span>
							{/if}
						</div>
						{#if it.preview}<div class="wprev">{it.preview}</div>{/if}
					</div>
				{:else}
					<div class="wempty">No results</div>
				{/each}
			{:else}
				<div class="werr">{item.output}</div>
			{/if}
		</div>
	</details>
{:else}
	<div class="web" class:running={status === 'running'} class:error={status === 'error'}>
		<div class="wrow">{@render head()}</div>
	</div>
{/if}
