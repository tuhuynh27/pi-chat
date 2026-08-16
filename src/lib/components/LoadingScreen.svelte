<script lang="ts">
	import { fade } from 'svelte/transition';
</script>

<div class="loading-backdrop" role="status" aria-live="polite" aria-label="Loading" out:fade={{ duration: 140 }}>
	<div class="loading-mark">π</div>
</div>

<style>
	.loading-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		background: var(--bg);
		opacity: 0;
		animation: loading-reveal 0ms linear 160ms forwards;
	}

	.loading-mark {
		font-size: 30px;
		font-weight: 650;
		line-height: 1;
		letter-spacing: -0.04em;
		color: var(--fg);
		animation: loading-pulse 1.15s ease-in-out infinite;
	}

	@keyframes loading-reveal {
		to {
			opacity: 1;
		}
	}

	@keyframes loading-pulse {
		50% {
			opacity: 0.28;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-mark {
			animation: none;
		}
	}
</style>
