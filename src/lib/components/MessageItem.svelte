<script lang="ts">
	import { renderMarkdown } from '$lib/markdown';
	import type { AssistantItem } from '$lib/types';

	let { item }: { item: AssistantItem } = $props();

	// The thinking block follows the model: open while thinking (full text
	// streams visibly), auto-collapsed once thinking stops. Manual toggles in
	// between are respected — the effect only writes `open` on active
	// transitions, not on every change.
	let open = $state(false);
	let wasActive = $state(false);

	$effect(() => {
		if (item.thinkingActive) {
			open = true;
			wasActive = true;
		} else if (wasActive) {
			open = false;
			wasActive = false;
		}
	});

	// Keep the (capped) thinking body scrolled to the newest line while live.
	let ttext = $state<HTMLDivElement | undefined>(undefined);
	$effect(() => {
		void item.thinking;
		if (ttext && item.thinkingActive) ttext.scrollTop = ttext.scrollHeight;
	});
</script>

{#if item.thinking}
	<details class="think" class:active={item.thinkingActive} bind:open={open}>
		<summary>
			<span>{item.thinkingActive ? 'thinking' : 'thought'}</span>
			{#if item.thinkingActive}<span class="tdots" aria-hidden="true"><i>·</i><i>·</i><i>·</i></span>{/if}
		</summary>
		<div class="ttext" bind:this={ttext}>{item.thinking}</div>
	</details>
{/if}

{#if item.text}
	{@const html = renderMarkdown(item.text)}
	<div class="md">{@html html}</div>
{:else if item.streaming && !item.thinkingActive}
	<span class="waiting" aria-label="waiting"><i>·</i><i>·</i><i>·</i></span>
{/if}
