<script lang="ts">
	let { icon }: { icon: 'chart' | 'earnings' | 'fed' } = $props();
</script>

{#if icon === 'chart'}
	<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
		<path
			d="M2 13.5h12M3 10.5l3-3 2.5 2L13 4.5M13 4.5H10.5M13 4.5v2.5"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="square"
		/>
	</svg>
{:else if icon === 'earnings'}
	<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
		<path
			d="M4 2h8v12H4zM6.5 5.5h3M6.5 8h3M6.5 10.5h1.5"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="square"
		/>
	</svg>
{:else}
	<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
		<path
			d="M2 6l6-3.5L14 6M3 6.5v5.5M6.5 6.5v5.5M9.5 6.5v5.5M13 6.5v5.5M2 13.5h12"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="square"
		/>
	</svg>
{/if}
