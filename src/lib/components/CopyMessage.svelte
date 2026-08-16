<script lang="ts">
	import { onDestroy } from 'svelte';

	let { text }: { text: string } = $props();
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

<button class="copy-message" type="button" onclick={copy} aria-label="Copy message as Markdown">
	{#if status === 'copied'}
		<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
			<path d="m2 6.3 2.4 2.4L10 3.2" stroke="currentColor" stroke-width="1.4" fill="none" />
		</svg>
		Copied
	{:else}
		<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
			<path d="M4 3V1.5h6.5V8H9M1.5 4H8v6.5H1.5z" stroke="currentColor" stroke-width="1.2" fill="none" />
		</svg>
		{status === 'error' ? 'Copy failed' : 'Copy'}
	{/if}
</button>
<span class="sr-only" aria-live="polite">
	{status === 'copied' ? 'Message copied as Markdown' : status === 'error' ? 'Unable to copy message' : ''}
</span>
