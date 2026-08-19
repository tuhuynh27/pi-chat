<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';

	let {
		title,
		message,
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		danger = false,
		onConfirm,
		onCancel
	}: {
		title: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string;
		danger?: boolean;
		onConfirm: () => void;
		onCancel: () => void;
	} = $props();

	let panel = $state<HTMLDivElement | undefined>();
	let cancelBtn = $state<HTMLButtonElement | undefined>();
	const previous =
		typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

	onMount(() => {
		cancelBtn?.focus();
		const onWin = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			e.preventDefault();
			e.stopImmediatePropagation();
			onCancel();
		};
		window.addEventListener('keydown', onWin, true);
		return () => {
			window.removeEventListener('keydown', onWin, true);
			previous?.focus?.();
		};
	});

	function onKey(e: KeyboardEvent) {
		if (e.key !== 'Tab' || !panel) return;
		const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled)')];
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
</script>

<svelte:window onkeydown={onKey} />

<div
	class="confirm-backdrop"
	role="presentation"
	transition:fade={{ duration: 120 }}
	onpointerdown={(e) => {
		if (e.target === e.currentTarget) onCancel();
	}}
>
	<div
		bind:this={panel}
		class="confirm-panel"
		role="dialog"
		aria-modal="true"
		aria-labelledby="confirm-title"
		aria-describedby="confirm-message"
		tabindex="-1"
	>
		<div class="confirm-body">
			<h2 id="confirm-title">{title}</h2>
			<p id="confirm-message">{message}</p>
		</div>
		<div class="confirm-actions">
			<button bind:this={cancelBtn} type="button" class="confirm-btn" onclick={onCancel}>
				{cancelLabel}
			</button>
			<button type="button" class="confirm-btn primary" class:danger onclick={onConfirm}>
				{confirmLabel}
			</button>
		</div>
	</div>
</div>

<style>
	.confirm-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: grid;
		place-items: center;
		padding: 24px 16px;
		background: color-mix(in srgb, var(--bg) 78%, transparent);
		backdrop-filter: blur(2px);
	}

	.confirm-panel {
		width: min(400px, 100%);
		background: var(--bg);
		border: 1px solid var(--line);
		animation: confirm-enter 160ms ease-out both;
	}

	.confirm-body {
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

	.confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 12px 14px;
		border-top: 1px solid var(--line);
	}

	.confirm-btn {
		border: 1px solid var(--line);
		background: var(--bg);
		color: var(--fg);
		padding: 6px 12px;
		font-size: 13px;
		font-weight: 550;
		cursor: pointer;
	}

	.confirm-btn:hover {
		background: var(--soft);
	}

	.confirm-btn:focus-visible {
		outline: 2px solid var(--fg);
		outline-offset: 2px;
	}

	.confirm-btn.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-fg);
	}

	.confirm-btn.primary:hover {
		opacity: 0.86;
		background: var(--accent);
	}

	.confirm-btn.primary.danger {
		border-color: var(--error);
		background: var(--error);
		color: #fff;
	}

	@keyframes confirm-enter {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}

	@media (max-width: 480px) {
		.confirm-backdrop {
			align-items: end;
			padding: 12px;
		}

		.confirm-body {
			padding: 20px 18px 16px;
		}

		.confirm-actions {
			padding: 12px;
		}

		.confirm-btn {
			flex: 1;
			padding: 9px 12px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.confirm-panel {
			animation: none;
		}
	}
</style>
