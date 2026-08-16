<script lang="ts">
	let { onRetry, disabled = false }: { onRetry: () => void; disabled?: boolean } = $props();
</script>

<button class="retry-message" type="button" onclick={onRetry} {disabled} aria-label="Retry from this message">
	<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
		<path
			d="M9.5 3.3A4 4 0 1 0 10.5 6"
			stroke="currentColor"
			stroke-width="1.2"
			fill="none"
			stroke-linecap="round"
		/>
		<path d="M9.3 1.2v2.6H6.7" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
	</svg>
	Retry
</button>
