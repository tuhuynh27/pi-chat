<script lang="ts">
	import Dropdown from '$lib/components/Dropdown.svelte';

	let {
		model,
		models,
		thinking,
		busy,
		onModel,
		onThinking,
		onNew,
		onMenu,
		onLogout
	}: {
		model: string;
		models: { id: string; name: string; provider: string }[];
		thinking: string;
		busy: boolean;
		onModel: (id: string) => void;
		onThinking: (level: string) => void;
		onNew: () => void;
		onMenu: () => void;
		onLogout: () => void;
	} = $props();

	const levels = ['off', 'minimal', 'low', 'medium', 'high'];
</script>

<header class="header">
	<div class="hdr-left">
		<button class="icon-btn" onclick={onMenu} aria-label="Toggle chat history">
			<svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
				<path d="M1 2.5h11M1 6.5h11M1 10.5h11" stroke="currentColor" stroke-width="1.5" fill="none" />
			</svg>
		</button>
		<div class="brand">
			<span class="logo">π</span>
			<span class="title">pi chat</span>
		</div>
	</div>
	<div class="controls">
		{#if models.length > 0}
			<Dropdown
				label="Model"
				value={model}
				options={models.map((m) => ({ value: m.id, label: m.name }))}
				disabled={busy}
				onChange={onModel}
			/>
		{/if}
		<Dropdown
			label="Thinking level"
			value={thinking}
			options={levels.map((l) => ({ value: l, label: `think: ${l}` }))}
			disabled={busy}
			onChange={onThinking}
		/>
		<button class="btn" onclick={onNew} disabled={busy} aria-label="New chat">
			<svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
				<path d="M5.5 1v9M1 5.5h9" stroke="currentColor" stroke-width="1.5" fill="none" />
			</svg>
			<span class="btn-text">New</span>
		</button>
		<button class="icon-btn logout" onclick={onLogout} aria-label="Sign out" title="Sign out">
			<svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
				<path d="M5.5 1.5H2v10h3.5M8 3.5l3 3-3 3M4 6.5h7" stroke="currentColor" stroke-width="1.35" fill="none" />
			</svg>
		</button>
	</div>
</header>
