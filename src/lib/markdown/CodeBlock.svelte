<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { fallbackHtml, resolveLang } from './code-utils';

	let { lang, text }: { lang: string; text: string } = $props();

	const label = $derived(resolveLang(lang) || 'text');
	const pendingMermaid = $derived(label === 'mermaid');

	// Shiki grammars are large; load them once, then highlight synchronously
	// so streaming updates don't flicker through the unstyled fallback.
	let highlighter = $state<typeof import('./highlight').highlight | null>(null);
	const html = $derived(
		pendingMermaid ? '' : highlighter ? highlighter(text, lang) : fallbackHtml(text, label)
	);

	onMount(() => {
		void import('./highlight').then((mod) => {
			highlighter = mod.highlight;
		});
	});

	let status = $state<'idle' | 'copied' | 'error'>('idle');
	let resetTimer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
			} else {
				const textarea = document.createElement('textarea');
				textarea.value = text;
				textarea.setAttribute('readonly', '');
				textarea.style.position = 'fixed';
				textarea.style.opacity = '0';
				document.body.appendChild(textarea);
				textarea.select();
				const copied = document.execCommand('copy');
				textarea.remove();
				if (!copied) throw new Error('Copy command failed');
			}
			status = 'copied';
		} catch {
			status = 'error';
		}

		if (resetTimer) clearTimeout(resetTimer);
		resetTimer = setTimeout(() => (status = 'idle'), 1800);
	}

	onDestroy(() => {
		if (resetTimer) clearTimeout(resetTimer);
	});
</script>

<div class="code-block">
	<div class="code-bar">
		<span class="code-lang">{label}</span>
		<button class="code-copy" type="button" onclick={copy} aria-label="Copy code">
			{status === 'copied' ? 'Copied' : status === 'error' ? 'Copy failed' : 'Copy'}
		</button>
	</div>
	{#if pendingMermaid}
		<pre class="shiki shiki-fallback" data-lang="mermaid"><code>{text}</code></pre>
	{:else}
		{@html html}
	{/if}
</div>
