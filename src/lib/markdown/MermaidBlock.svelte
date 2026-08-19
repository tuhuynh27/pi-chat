<script lang="ts">
	import { onMount } from 'svelte';

	let { text }: { text: string } = $props();

	let svg = $state('');
	let failed = $state(false);
	let mermaidMod = $state<typeof import('mermaid').default | null>(null);
	let gen = 0;

	function isDark(): boolean {
		const theme = document.documentElement.getAttribute('data-theme');
		if (theme === 'dark') return true;
		if (theme === 'light') return false;
		return window.matchMedia('(prefers-color-scheme: dark)').matches;
	}

	async function render(src: string) {
		if (!mermaidMod) return;
		const current = ++gen;
		try {
			const theme = isDark() ? 'dark' : 'neutral';
			const id = `mermaid-${crypto.randomUUID()}`;
			const result = await mermaidMod.render(id, `%%{init: {'theme':'${theme}'}}%%\n${src}`);
			if (current !== gen) return;
			svg = result.svg;
			failed = false;
		} catch {
			if (current !== gen) return;
			svg = '';
			failed = true;
		}
	}

	onMount(() => {
		let cancelled = false;
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const rerender = () => {
			if (mermaidMod) void render(text);
		};

		void (async () => {
			try {
				const mod = (await import('mermaid')).default;
				if (cancelled) return;
				mod.initialize({ startOnLoad: false, securityLevel: 'strict' });
				mermaidMod = mod;
			} catch {
				if (!cancelled) failed = true;
			}
		})();

		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (mutation.attributeName === 'data-theme') {
					rerender();
					return;
				}
			}
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		mq.addEventListener('change', rerender);

		return () => {
			cancelled = true;
			observer.disconnect();
			mq.removeEventListener('change', rerender);
		};
	});

	$effect(() => {
		if (mermaidMod) void render(text);
	});
</script>

{#if failed}
	<div class="mermaid-block mermaid-failed">
		<div class="mermaid-error">Couldn't render diagram</div>
		<pre><code>{text}</code></pre>
	</div>
{:else if svg}
	<div class="mermaid-block">
		{@html svg}
	</div>
{:else}
	<div class="mermaid-block mermaid-pending">Rendering diagram…</div>
{/if}
