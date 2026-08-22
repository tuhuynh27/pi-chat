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
	const modelOptions = $derived(models.map((item) => ({ value: item.id, label: item.name })));
	const visibleModelOptions = $derived(
		modelOptions.length > 0
			? modelOptions
			: model
				? [{ value: model, label: model.split('/').pop() || model }]
				: []
	);
</script>

<header class="header">
	<div class="hdr-left">
		<button class="icon-btn" onclick={onMenu} aria-label="Toggle chat history">
			<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
				<path d="M2 3.5h12M2 8h12M2 12.5h12" stroke="currentColor" stroke-width="1.4" fill="none" />
			</svg>
		</button>
		<div class="brand" aria-label="Keva Chat">
			<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
				<rect x="1" y="1" width="30" height="30" />
				<path d="M10.5 8.5v15M21.8 8.5 10.7 19.2M15.7 14.4l6.1 9.1" />
			</svg>
			<span class="brand-name">Keva Chat</span>
			<span class="brand-context">Private workspace</span>
		</div>
	</div>
	<div class="controls">
		<div class="context-controls">
			<Dropdown
				label="Model"
				value={model}
				options={visibleModelOptions}
				disabled={busy || models.length === 0}
				onChange={onModel}
			/>
			<Dropdown
				label="Thinking level"
				value={thinking}
				options={levels.map((l) => ({ value: l, label: `think: ${l}` }))}
				disabled={busy}
				onChange={onThinking}
			/>
			<button class="btn" onclick={onNew} disabled={busy} aria-label="New chat">
				<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
					<path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="1.4" fill="none" />
				</svg>
				<span class="btn-text">New chat</span>
			</button>
			<button class="btn" onclick={onShare} disabled={shareDisabled} aria-label="Share conversation">
				<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
					<path
						d="M6 7V1.8M3.8 4 6 1.8 8.2 4M1.8 4.8v5.4h8.4V4.8"
						stroke="currentColor"
						stroke-width="1.3"
						fill="none"
						stroke-linecap="square"
						stroke-linejoin="miter"
					/>
				</svg>
				<span class="btn-text">Share</span>
			</button>
		</div>
		<div class="account-controls">
			<button
				class="icon-btn"
				onclick={onToggleTheme}
				aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
				title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
			>
				{#if theme === 'dark'}
					<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="1.8" fill="none" />
						<path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" />
					</svg>
				{:else}
					<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter" fill="none" />
					</svg>
				{/if}
			</button>
			<button class="icon-btn logout" onclick={onLogout} aria-label="Sign out" title="Sign out">
				<svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
					<path d="M6.2 1.8H2.3v11.4h3.9M9 4.2l3.4 3.3L9 10.8M4.8 7.5h7.5" stroke="currentColor" stroke-width="1.3" fill="none" />
				</svg>
			</button>
		</div>
	</div>
</header>
