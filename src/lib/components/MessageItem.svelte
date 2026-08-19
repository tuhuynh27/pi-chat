<script lang="ts">
	import SvelteMarkdown from '@humanspeak/svelte-markdown';
	import { markdownExtensions, markdownOptions, markdownRenderers } from '$lib/markdown';
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
	// Reading scrollHeight forces a synchronous layout, so this is rAF-throttled
	// the same way the main thread scroll is (+page.svelte's scrollBottom) -
	// thinking deltas can arrive many times per frame, and without throttling
	// each one forces its own layout pass, visibly stuttering the stream.
	let ttext = $state<HTMLDivElement | undefined>(undefined);
	let scrollFrame = 0;
	$effect(() => {
		void item.thinking;
		if (!ttext || !item.thinkingActive || scrollFrame) return;
		scrollFrame = requestAnimationFrame(() => {
			scrollFrame = 0;
			if (ttext) ttext.scrollTop = ttext.scrollHeight;
		});
	});

	$effect(() => {
		return () => {
			if (scrollFrame) cancelAnimationFrame(scrollFrame);
		};
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
	<div class="md">
		<SvelteMarkdown
			source={item.text}
			streaming={item.streaming}
			streamId={item.id}
			options={markdownOptions}
			extensions={markdownExtensions}
			renderers={markdownRenderers}
		/>
	</div>
{:else if item.streaming && !item.thinkingActive && !item.thinking}
	<span class="waiting" aria-label="waiting"><i>·</i><i>·</i><i>·</i></span>
{/if}
