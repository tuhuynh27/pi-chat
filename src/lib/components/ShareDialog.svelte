<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';

	let {
		url,
		onClose
	}: {
		url: string;
		onClose: () => void;
	} = $props();

	let panel = $state<HTMLDivElement | undefined>();
	let closeBtn = $state<HTMLButtonElement | undefined>();
	let input = $state<HTMLInputElement | undefined>();
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	const previous =
		typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

	onMount(() => {
		closeBtn?.focus();
		const onWin = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			e.preventDefault();
			e.stopImmediatePropagation();
			onClose();
		};
		window.addEventListener('keydown', onWin, true);
		return () => {
			window.removeEventListener('keydown', onWin, true);
			if (copyTimer) clearTimeout(copyTimer);
			previous?.focus?.();
		};
	});

	function onKey(e: KeyboardEvent) {
		if (e.key !== 'Tab' || !panel) return;
		const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input')];
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	async function copy() {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(url);
			} else {
				input?.select();
				document.execCommand('copy');
			}
			copied = true;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 1800);
		} catch {
			// Clipboard blocked (insecure context) — the field is selectable, so
			// just surface the URL for a manual copy.
			input?.select();
		}
	}
</script>

<svelte:window onkeydown={onKey} />

<div
	class="share-backdrop"
	role="presentation"
	transition:fade={{ duration: 120 }}
	onpointerdown={(e) => {
		if (e.target === e.currentTarget) onClose();
	}}
>
	<div
		bind:this={panel}
		class="share-panel"
		role="dialog"
		aria-modal="true"
		aria-labelledby="share-title"
		aria-describedby="share-message"
		tabindex="-1"
	>
		<div class="share-body">
			<h2 id="share-title">Share this conversation</h2>
			<p id="share-message">
				Anyone with this link can view the conversation. It is read-only - viewers can't send
				messages or change anything. The same link is reused and stops working if you delete
				the chat.
			</p>
			<div class="share-url-row">
				<input
					bind:this={input}
					class="share-url"
					type="text"
					readonly
					value={url}
					onclick={(e) => (e.currentTarget as HTMLInputElement).select()}
					aria-label="Share link"
				/>
				<button type="button" class="share-copy" onclick={copy} aria-label="Copy link">
					{#if copied}
						<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
							<path d="m2 6.3 2.4 2.4L10 3.2" stroke="currentColor" stroke-width="1.4" fill="none" />
						</svg>
						Copied
					{:else}
						<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
							<path d="M4 3V1.5h6.5V8H9M1.5 4H8v6.5H1.5z" stroke="currentColor" stroke-width="1.2" fill="none" />
						</svg>
						Copy
					{/if}
				</button>
			</div>
		</div>
		<div class="share-actions">
			<button bind:this={closeBtn} type="button" class="share-btn" onclick={onClose}>
				Close
			</button>
		</div>
	</div>
</div>

<style>
	.share-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: grid;
		place-items: center;
		padding: 24px 16px;
		background: color-mix(in srgb, var(--bg) 78%, transparent);
		backdrop-filter: blur(2px);
	}

	.share-panel {
		width: min(440px, 100%);
		background: var(--bg);
		border: 1px solid var(--line);
		animation: share-enter 160ms ease-out both;
	}

	.share-body {
		padding: 22px 22px 18px;
	}

	h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 650;
		letter-spacing: -0.02em;
		line-height: 1.3;
	}

	p {
		margin: 8px 0 0;
		color: var(--muted);
		font-size: 13.5px;
		line-height: 1.5;
	}

	.share-url-row {
		display: flex;
		gap: 8px;
		margin-top: 16px;
	}

	.share-url {
		flex: 1;
		min-width: 0;
		height: 38px;
		padding: 0 10px;
		border: 1px solid var(--line);
		background: var(--soft);
		color: var(--fg);
		font-size: 12.5px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		outline: none;
	}

	.share-url:focus {
		border-color: var(--fg);
	}

	.share-copy {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 38px;
		padding: 0 13px;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: var(--accent-fg);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	.share-copy:hover {
		opacity: 0.86;
	}

	.share-copy:focus-visible {
		outline: 2px solid var(--fg);
		outline-offset: 2px;
	}

	.share-actions {
		display: flex;
		justify-content: flex-end;
		padding: 12px 14px;
		border-top: 1px solid var(--line);
	}

	.share-btn {
		border: 1px solid var(--line);
		background: var(--bg);
		color: var(--fg);
		padding: 6px 12px;
		font-size: 13px;
		font-weight: 550;
		cursor: pointer;
	}

	.share-btn:hover {
		background: var(--soft);
	}

	.share-btn:focus-visible {
		outline: 2px solid var(--fg);
		outline-offset: 2px;
	}

	@keyframes share-enter {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}

	@media (max-width: 480px) {
		.share-backdrop {
			align-items: end;
			padding: 12px;
		}

		.share-body {
			padding: 20px 18px 16px;
		}

		.share-actions {
			padding: 12px;
		}

		.share-btn {
			flex: 1;
			padding: 9px 12px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.share-panel {
			animation: none;
		}
	}
</style>
