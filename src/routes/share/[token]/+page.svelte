<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import MessageItem from '$lib/components/MessageItem.svelte';
	import ToolLine from '$lib/components/ToolLine.svelte';
	import WebTool from '$lib/components/WebTool.svelte';
	import { initTheme, setTheme, type Theme } from '$lib/theme';
	import { isWebTool, toItems, type Item, type StoredItem } from '$lib/types';

	// Read-only guest view of a shared conversation. No composer, sidebar,
	// retry, or copy actions. The snapshot is fetched once and rendered as-is.
	const token = $page.params.token;
	let title = $state('');
	let updatedAt = $state<number | null>(null);
	let items = $state<Item[]>([]);
	let status = $state<'loading' | 'ok' | 'notfound'>('loading');
	let theme = $state<Theme>('light');
	let messageCount = $derived(items.filter((item) => item.role === 'user' || item.role === 'assistant').length);

	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
		setTheme(theme);
	}

	function formatDate(timestamp: number) {
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		}).format(timestamp);
	}

	async function loadConversation() {
		if (!token) {
			status = 'notfound';
			return;
		}

		const res = await fetch(`/api/share/${encodeURIComponent(token)}`).catch(() => null);
		if (!res?.ok) {
			status = 'notfound';
			return;
		}

		const body = (await res.json().catch(() => null)) as {
			title?: string;
			updatedAt?: number;
			items?: StoredItem[];
		} | null;
		if (!body) {
			status = 'notfound';
			return;
		}

		title = body.title ?? '';
		updatedAt = typeof body.updatedAt === 'number' ? body.updatedAt : null;
		items = toItems(body.items ?? [], false);
		status = 'ok';
	}

	onMount(() => {
		theme = initTheme();
		void loadConversation();
	});
</script>

<svelte:head>
	<title>{title ? `${title} - Keva Chat` : 'Shared conversation - Keva Chat'}</title>
	<meta name="description" content="A read-only conversation shared from Keva Chat." />
</svelte:head>

<div class="share-app">
	<header class="share-header">
		<div class="share-header-inner">
			<a class="share-brand" href="/" aria-label="Open Keva Chat">
				<svg class="share-logo" viewBox="0 0 32 32" aria-hidden="true">
					<rect x="1" y="1" width="30" height="30" />
					<path d="M10.5 8.5v15M21.8 8.5 10.7 19.2M15.7 14.4l6.1 9.1" />
				</svg>
				<span>Keva Chat</span>
			</a>

			<div class="share-actions">
				<span class="shared-badge">
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<rect x="3.2" y="7" width="9.6" height="7" />
						<path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
					</svg>
					<span>Shared <span class="badge-detail">read-only</span></span>
				</span>
				<button
					class="theme-toggle"
					type="button"
					onclick={toggleTheme}
					aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
					title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
				>
					{#if theme === 'dark'}
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<circle cx="12" cy="12" r="4.5" />
							<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
						</svg>
						<span class="theme-label">Light</span>
					{:else}
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="M20.5 14.4A8.5 8.5 0 0 1 9.6 3.5 8.5 8.5 0 1 0 20.5 14.4Z" />
						</svg>
						<span class="theme-label">Dark</span>
					{/if}
				</button>
			</div>
		</div>
	</header>

	<main class="share-main">
		{#if status === 'notfound'}
			<section class="status-panel" aria-labelledby="unavailable-title">
				<div class="status-mark" aria-hidden="true">
					<svg viewBox="0 0 32 32">
						<path d="M11.5 10.5 8.7 7.7a4 4 0 0 0-5.7 5.7l4.2 4.2a4 4 0 0 0 5.7 0l2.3-2.3M20.5 21.5l2.8 2.8a4 4 0 0 0 5.7-5.7l-4.2-4.2a4 4 0 0 0-5.7 0l-2.3 2.3M10.5 21.5l11-11M5 5l22 22" />
					</svg>
				</div>
				<p class="status-kicker">Link unavailable</p>
				<h1 id="unavailable-title">This conversation can’t be opened</h1>
				<p class="status-copy">The link may have expired, or the original conversation was deleted.</p>
				<a class="home-link" href="/">Open Keva Chat</a>
			</section>
		{:else if status === 'loading'}
			<div class="status-panel loading" role="status" aria-live="polite">
				<svg class="loading-logo" viewBox="0 0 32 32" aria-hidden="true">
					<rect x="1" y="1" width="30" height="30" />
					<path d="M10.5 8.5v15M21.8 8.5 10.7 19.2M15.7 14.4l6.1 9.1" />
				</svg>
				<span>Opening shared conversation</span>
			</div>
		{:else}
			<article class="thread">
				<header class="share-intro">
					<p class="share-kicker">Shared conversation</p>
					<h1>{title || 'Untitled conversation'}</h1>
					<div class="share-meta">
						<span>Keva Chat</span>
						<span class="meta-dot" aria-hidden="true"></span>
						<span>{messageCount} {messageCount === 1 ? 'message' : 'messages'}</span>
						{#if updatedAt}
							<span class="meta-dot" aria-hidden="true"></span>
							<span>Updated {formatDate(updatedAt)}</span>
						{/if}
					</div>
				</header>

				<div class="transcript" aria-label="Conversation transcript">
					{#each items as item (item.id)}
						{#if item.role === 'user'}
							<section class="share-turn user" aria-label="Prompt">
								<span class="turn-label">Prompt</span>
								{#if item.images?.length}
									<div class="share-images">
										{#each item.images as img (img.mimeType + img.data.length)}
											<img src={`data:${img.mimeType};base64,${img.data}`} alt="Shared attachment" />
										{/each}
									</div>
								{/if}
								{#if item.text}
									<div class="bubble">{item.text}</div>
								{/if}
							</section>
						{:else if item.role === 'assistant'}
							{#if item.text || item.thinking}
								<section class="share-turn assistant" aria-label="Assistant response">
									<MessageItem item={item} />
								</section>
							{/if}
						{:else if item.role === 'tool'}
							<div class="share-tool">
								{#if isWebTool(item)}
									<WebTool item={item} />
								{:else}
									<ToolLine item={item} />
								{/if}
							</div>
						{:else}
							<div class="share-error" role="alert">{item.text}</div>
						{/if}
					{/each}
				</div>
			</article>
		{/if}
	</main>
</div>

<style>
	.share-app {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
		background: var(--bg);
	}

	.share-header {
		position: relative;
		z-index: 10;
		flex: 0 0 auto;
		border-bottom: 1px solid var(--line);
		background: color-mix(in srgb, var(--bg) 94%, transparent);
		backdrop-filter: blur(12px);
	}

	.share-header-inner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
		width: min(1180px, 100%);
		min-height: 62px;
		margin: 0 auto;
		padding: 12px max(24px, env(safe-area-inset-right)) 12px max(24px, env(safe-area-inset-left));
	}

	.share-brand {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		color: var(--fg);
		font-size: 15px;
		font-weight: 650;
		line-height: 1;
		letter-spacing: -0.02em;
		text-decoration: none;
	}

	.share-logo,
	.loading-logo {
		width: 28px;
		height: 28px;
		flex: 0 0 auto;
	}

	.share-logo rect,
	.loading-logo rect {
		fill: var(--fg);
		stroke: none;
	}

	.share-logo path,
	.loading-logo path {
		fill: none;
		stroke: var(--bg);
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.share-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.shared-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 34px;
		padding: 0 11px;
		border: 1px solid var(--line);
		background: var(--soft);
		color: var(--muted);
		font-size: 11px;
		font-weight: 600;
		line-height: 1;
		letter-spacing: 0.055em;
		text-transform: uppercase;
	}

	.shared-badge svg {
		width: 13px;
		height: 13px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.35;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.badge-detail::before {
		content: '\00b7';
		margin: 0 4px;
	}

	.theme-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		height: 36px;
		padding: 0 11px;
		border: 1px solid var(--line);
		background: var(--bg);
		color: var(--fg);
		font-size: 12px;
		font-weight: 550;
		cursor: pointer;
		transition: border-color 140ms ease, background-color 140ms ease;
	}

	.theme-toggle:hover {
		border-color: var(--faint);
		background: var(--soft);
	}

	.theme-toggle:focus-visible,
	.home-link:focus-visible,
	.share-brand:focus-visible {
		outline: 2px solid var(--fg);
		outline-offset: 3px;
	}

	.theme-toggle svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.7;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.share-main {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
	}

	.thread {
		width: min(800px, 100%);
		max-width: none;
		margin: 0 auto;
		padding: 64px 24px 96px;
	}

	.share-intro {
		margin-bottom: 52px;
		padding-bottom: 28px;
		border-bottom: 1px solid var(--line);
	}

	.share-kicker,
	.status-kicker {
		margin: 0 0 12px;
		color: var(--muted);
		font-size: 11px;
		font-weight: 650;
		line-height: 1;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.share-intro h1 {
		margin: 0;
		font-size: clamp(30px, 5vw, 40px);
		font-weight: 650;
		line-height: 1.14;
		letter-spacing: -0.045em;
		text-wrap: balance;
	}

	.share-meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 16px;
		color: var(--faint);
		font-size: 12px;
		line-height: 1.4;
	}

	.meta-dot {
		width: 3px;
		height: 3px;
		background: currentColor;
	}

	.transcript {
		display: flow-root;
	}

	.share-turn {
		margin-bottom: 34px;
	}

	.share-turn.user {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
	}

	.turn-label {
		display: block;
		margin-bottom: 7px;
		color: var(--faint);
		font-size: 11px;
		font-weight: 600;
		line-height: 1;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.share-turn.user .bubble {
		max-width: min(82%, 620px);
		padding: 11px 15px;
		border: 1px solid color-mix(in srgb, var(--fg) 5%, var(--line));
		background: var(--soft);
		font-size: 14.5px;
		line-height: 1.6;
		white-space: pre-wrap;
		overflow-wrap: break-word;
	}

	.share-tool {
		margin-bottom: 18px;
	}

	.share-tool :global(.tool),
	.share-tool :global(.web) {
		margin-bottom: 0;
	}

	.share-error {
		margin-bottom: 28px;
		padding: 10px 12px;
		border-left: 2px solid var(--error);
		color: var(--error);
		font-size: 13px;
	}

	.share-images {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 160px));
		gap: 7px;
		max-width: min(82%, 327px);
		margin-bottom: 8px;
	}

	.share-images img {
		display: block;
		width: 100%;
		aspect-ratio: 1;
		object-fit: cover;
		border: 1px solid var(--line);
		background: var(--soft);
	}

	.status-panel {
		display: flex;
		min-height: 100%;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		padding: 64px 24px 112px;
		text-align: center;
	}

	.status-mark {
		display: grid;
		place-items: center;
		width: 58px;
		height: 58px;
		margin-bottom: 26px;
		border: 1px solid var(--line);
		background: var(--soft);
		color: var(--muted);
	}

	.status-mark svg {
		width: 28px;
		height: 28px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.35;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.status-panel h1 {
		max-width: 520px;
		margin: 0;
		font-size: clamp(26px, 4vw, 34px);
		font-weight: 650;
		line-height: 1.2;
		letter-spacing: -0.04em;
		text-wrap: balance;
	}

	.status-copy {
		max-width: 430px;
		margin: 12px 0 0;
		color: var(--muted);
		font-size: 14px;
		line-height: 1.6;
	}

	.home-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 42px;
		margin-top: 24px;
		padding: 0 17px;
		background: var(--fg);
		color: var(--bg);
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
	}

	.status-panel.loading {
		gap: 14px;
		color: var(--muted);
		font-size: 13px;
	}

	.loading-logo {
		width: 32px;
		height: 32px;
		animation: loading-pulse 1.2s ease-in-out infinite;
	}

	@keyframes loading-pulse {
		50% { opacity: 0.35; }
	}

	@media (max-width: 640px) {
		.share-header-inner {
			min-height: 58px;
			padding: 10px max(14px, env(safe-area-inset-right)) 10px max(14px, env(safe-area-inset-left));
		}

		.share-brand {
			font-size: 14px;
		}

		.share-logo {
			width: 26px;
			height: 26px;
		}

		.shared-badge {
			height: 32px;
			padding-inline: 9px;
		}

		.badge-detail {
			display: none;
		}

		.theme-toggle {
			width: 34px;
			height: 34px;
			padding: 0;
		}

		.theme-label {
			display: none;
		}

		.thread {
			padding: 42px 18px max(72px, env(safe-area-inset-bottom));
		}

		.share-intro {
			margin-bottom: 40px;
			padding-bottom: 23px;
		}

		.share-kicker {
			margin-bottom: 10px;
		}

		.share-intro h1 {
			font-size: 29px;
		}

		.share-turn {
			margin-bottom: 29px;
		}

		.share-turn.user .bubble,
		.share-images {
			max-width: 88%;
		}

		.status-panel {
			align-items: flex-start;
			padding: 72px 24px 120px;
			text-align: left;
		}

		.status-panel.loading {
			align-items: center;
			text-align: center;
		}

		.status-panel h1 {
			font-size: 28px;
		}
	}

	@media (max-width: 390px) {
		.share-brand span {
			display: none;
		}

		.share-actions {
			gap: 7px;
		}

		.share-images {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-logo {
			animation: none;
		}
	}
</style>
