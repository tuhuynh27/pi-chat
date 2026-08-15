<script lang="ts">
	let {
		busy,
		onSend,
		onStop
	}: {
		busy: boolean;
		onSend: (text: string) => void;
		onStop: () => void;
	} = $props();

	let text = $state('');
	let el: HTMLTextAreaElement;

	function autoresize() {
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 200) + 'px';
	}

	function submit() {
		const t = text.trim();
		if (!t || busy) return;
		text = '';
		requestAnimationFrame(autoresize);
		onSend(t);
	}
</script>

<div class="composer-wrap">
	<form
		class="composer"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<textarea
			bind:this={el}
			bind:value={text}
			rows="1"
			placeholder="Message pi…"
			autocapitalize="off"
			autocomplete="off"
			oninput={autoresize}
			onkeydown={(e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					submit();
				}
			}}
		></textarea>
		{#if busy}
			<button type="button" class="send stop" onclick={onStop} aria-label="Stop">
				<svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
					<rect x="1" y="1" width="9" height="9" fill="currentColor" />
				</svg>
			</button>
		{:else}
			<button type="submit" class="send" disabled={!text.trim()} aria-label="Send">
				<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
					<path d="M7 12V2M2.5 6.5 7 2l4.5 4.5" stroke="currentColor" stroke-width="1.6" fill="none" />
				</svg>
			</button>
		{/if}
	</form>
	<p class="hint">enter to send · shift+enter for a new line</p>
</div>
