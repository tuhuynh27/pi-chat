<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		children,
		task,
		checked
	}: {
		children?: Snippet;
		task?: boolean;
		checked?: boolean;
		text?: string;
		loose?: boolean;
		listItemIndex?: number;
	} = $props();
</script>

{#if task}
	<li class="task">
		<input type="checkbox" checked={checked} disabled />
		<span class="task-body">{@render children?.()}</span>
	</li>
{:else}
	<li>{@render children?.()}</li>
{/if}
