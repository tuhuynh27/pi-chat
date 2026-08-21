<script lang="ts">
	import Dropdown from '$lib/components/Dropdown.svelte';
	import type { Theme } from '$lib/theme';

	let {
		model,
		models,
		thinking,
		busy,
		theme,
		onModel,
		onThinking,
		onNew,
		onShare,
		shareDisabled = false,
		onMenu,
		onLogout,
		onToggleTheme
	}: {
		model: string;
		models: { id: string; name: string; provider: string }[];
		thinking: string;
		busy: boolean;
		theme: Theme;
		onModel: (id: string) => void;
		onThinking: (level: string) => void;
		onNew: () => void;
		onShare: () => void;
		shareDisabled?: boolean;
		onMenu: () => void;
		onLogout: () => void;
		onToggleTheme: () => void;
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
			<span class="logo">K</span>
			<span class="title">Keva Chat</span>
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
		<button class="btn" onclick={onShare} disabled={shareDisabled} aria-label="Share conversation">
			<svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
				<path
					d="M5.5 6.5V1.8M3.6 3.7 5.5 1.8l1.9 1.9M1.8 4.2v5h7.4v-5"
					stroke="currentColor"
					stroke-width="1.4"
					fill="none"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
			<span class="btn-text">Share</span>
		</button>
		<button
			class="icon-btn"
			onclick={onToggleTheme}
			aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
			title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
		>
			{#if theme === 'dark'}
				<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
					<circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2" fill="none" />
					<path
						d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
					/>
				</svg>
			{:else}
				<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
					<path
						d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						fill="none"
					/>
				</svg>
			{/if}
		</button>
		<button class="icon-btn logout" onclick={onLogout} aria-label="Sign out" title="Sign out">
			<svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
				<path d="M5.5 1.5H2v10h3.5M8 3.5l3 3-3 3M4 6.5h7" stroke="currentColor" stroke-width="1.35" fill="none" />
			</svg>
		</button>
	</div>
</header>
