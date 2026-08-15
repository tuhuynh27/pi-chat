<script lang="ts">
	import type { ToolItem } from '$lib/types';

	let { item }: { item: ToolItem } = $props();
</script>

<details class="tool" class:running={item.status === 'running'} class:error={item.status === 'error'}>
	<summary>
		<span class="dot" aria-hidden="true"></span>
		<span class="tname">{item.name}</span>
		{#if item.detail}<span class="tdetail">{item.detail}</span>{/if}
	</summary>
	{#if item.output}
		<pre>{item.output}</pre>
	{/if}
</details>
