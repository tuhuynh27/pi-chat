<script lang="ts">
	import type { AlertType } from '@humanspeak/svelte-markdown/extensions';

	let { text, alertType }: { text: string; alertType: AlertType } = $props();

	const titles: Record<AlertType, string> = {
		note: 'Note',
		tip: 'Tip',
		important: 'Important',
		warning: 'Warning',
		caution: 'Caution'
	};
</script>

<div class="alert alert-{alertType}" role="note">
	<div class="alert-title">{titles[alertType]}</div>
	<div class="alert-body">{text}</div>
</div>
