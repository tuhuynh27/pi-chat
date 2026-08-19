<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		href = '',
		title,
		children
	}: {
		href?: string;
		title?: string;
		children?: Snippet;
	} = $props();

	const external = $derived(/^https?:\/\//i.test(href));
</script>

{#if external}
	<a {href} {title} target="_blank" rel="noopener noreferrer">{@render children?.()}</a>
{:else}
	<a {href} {title}>{@render children?.()}</a>
{/if}
