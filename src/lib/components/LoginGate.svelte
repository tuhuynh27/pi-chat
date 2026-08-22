<script lang="ts">
	import { dev } from '$app/environment';

	let {
		configured,
		onAuthenticated
	}: {
		configured: boolean | null;
		onAuthenticated: () => void | Promise<void>;
	} = $props();

	let username = $state(dev ? 'dev' : '');
	let password = $state(dev ? 'dev' : '');
	let error = $state('');
	let submitting = $state(false);
	let showPassword = $state(false);
	let usernameInput = $state<HTMLInputElement>();

	$effect(() => {
		if (configured) usernameInput?.focus();
	});

	async function login() {
		if (!configured || submitting) return;
		error = '';
		submitting = true;

		try {
			const response = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ username, password })
			});
			const body = (await response.json().catch(() => null)) as { error?: string } | null;
			if (!response.ok) {
				error = body?.error ?? 'Unable to sign in.';
				return;
			}
			password = '';
			await onAuthenticated();
		} catch {
			error = 'Cannot reach the server. Try again.';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="auth-page">
	<header class="auth-brand" aria-label="Keva Chat">
		<svg class="auth-logo" viewBox="0 0 32 32" aria-hidden="true">
			<rect x="1" y="1" width="30" height="30" rx="9" />
			<path d="M10.5 8.5v15M21.8 8.5 10.7 19.2M15.7 14.4l6.1 9.1" />
		</svg>
		<span>Keva</span>
	</header>

	<main class="auth-main">
		<section class="auth-panel" aria-labelledby="auth-title">
			<div class="auth-head">
				<h1 id="auth-title">Welcome back</h1>
				<p>Sign in to continue to Keva Chat</p>
			</div>

			{#if configured === null}
				<div class="auth-setup" role="alert">
					<svg viewBox="0 0 20 20" aria-hidden="true">
						<path d="M10 6.6v3.8m0 3h.01M17.4 10a7.4 7.4 0 1 1-14.8 0 7.4 7.4 0 0 1 14.8 0Z" />
					</svg>
					<div>
						<strong>Server unavailable</strong>
						<span>Check that the Pi web server is running, then reload this page.</span>
					</div>
				</div>
			{:else if !configured}
				<div class="auth-setup" role="alert">
					<svg viewBox="0 0 20 20" aria-hidden="true">
						<path d="M10 6.6v3.8m0 3h.01M17.4 10a7.4 7.4 0 1 1-14.8 0 7.4 7.4 0 0 1 14.8 0Z" />
					</svg>
					<div>
						<strong>Authentication is not configured</strong>
						<span>Set <code>PI_WEB_USER</code> and <code>PI_WEB_PASS</code>, then restart the server.</span>
					</div>
				</div>
			{:else}
				<form onsubmit={(event) => { event.preventDefault(); void login(); }}>
					<div class="auth-field">
						<label for="auth-username">Username</label>
						<input
							bind:this={usernameInput}
							bind:value={username}
							id="auth-username"
							name="username"
							type="text"
							autocomplete="username"
							spellcheck="false"
							required
						/>
					</div>

					<div class="auth-field">
						<label for="auth-password">Password</label>
						<div class="auth-password">
							<input
								bind:value={password}
								id="auth-password"
								name="password"
								type={showPassword ? 'text' : 'password'}
								autocomplete="current-password"
								required
							/>
							<button
								class="auth-reveal"
								type="button"
								aria-label={showPassword ? 'Hide password' : 'Show password'}
								aria-pressed={showPassword}
								onclick={() => (showPassword = !showPassword)}
							>
								{#if showPassword}
									<svg viewBox="0 0 20 20" aria-hidden="true">
										<path d="m3 3 14 14M8.5 8.6a2.1 2.1 0 0 0 2.9 2.9M6.2 5.3A9.8 9.8 0 0 1 10 4.5c4.6 0 7.5 5.5 7.5 5.5a12.7 12.7 0 0 1-2.3 3.1M4.7 6.5A13.4 13.4 0 0 0 2.5 10s2.9 5.5 7.5 5.5c1 0 1.9-.2 2.7-.6" />
									</svg>
								{:else}
									<svg viewBox="0 0 20 20" aria-hidden="true">
										<path d="M17.5 10S14.6 4.5 10 4.5 2.5 10 2.5 10s2.9 5.5 7.5 5.5 7.5-5.5 7.5-5.5Z" />
										<circle cx="10" cy="10" r="2.2" />
									</svg>
								{/if}
							</button>
						</div>
					</div>

					{#if error}
						<div class="auth-error" role="alert">
							<svg viewBox="0 0 20 20" aria-hidden="true">
								<circle cx="10" cy="10" r="7.5" />
								<path d="M10 6.5v4.2m0 2.8h.01" />
							</svg>
							<span>{error}</span>
						</div>
					{/if}

					<button class="auth-submit" type="submit" disabled={submitting || !username || !password}>
						{#if submitting}<span class="auth-spinner" aria-hidden="true"></span>{/if}
						{submitting ? 'Signing in...' : 'Continue'}
					</button>
				</form>
			{/if}
		</section>
	</main>

	<footer class="auth-foot">
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<rect x="3.2" y="7" width="9.6" height="7" rx="1.8" />
			<path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
		</svg>
		<span>Private, secure workspace</span>
	</footer>
</div>

<style>
	.auth-page {
		--auth-accent: #10a37f;
		--auth-accent-hover: #0d8f70;
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		grid-template-rows: auto 1fr auto;
		min-height: 100dvh;
		overflow-y: auto;
		background: var(--bg);
		animation: auth-enter 180ms ease-out both;
	}

	.auth-brand {
		display: flex;
		align-items: center;
		gap: 10px;
		width: fit-content;
		margin: 28px 32px;
		font-size: 18px;
		font-weight: 650;
		line-height: 1;
		letter-spacing: -0.025em;
	}

	.auth-logo {
		width: 28px;
		height: 28px;
		flex: 0 0 auto;
	}

	.auth-logo rect {
		fill: var(--fg);
		stroke: none;
	}

	.auth-logo path {
		fill: none;
		stroke: var(--bg);
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.auth-main {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 32px 24px 88px;
	}

	.auth-panel {
		width: min(400px, 100%);
	}

	.auth-head {
		margin-bottom: 32px;
		text-align: center;
	}

	h1 {
		margin: 0;
		font-size: clamp(28px, 4vw, 32px);
		font-weight: 650;
		line-height: 1.2;
		letter-spacing: -0.04em;
	}

	p {
		margin: 10px 0 0;
		color: var(--muted);
		font-size: 14px;
		line-height: 1.5;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.auth-field {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	label {
		font-size: 14px;
		font-weight: 550;
		line-height: 1.35;
	}

	input {
		width: 100%;
		height: 52px;
		padding: 0 15px;
		border: 1px solid color-mix(in srgb, var(--fg) 24%, var(--line));
		border-radius: 8px !important;
		background: var(--bg);
		font-size: 16px;
		line-height: 1;
		outline: none;
		transition: border-color 140ms ease, box-shadow 140ms ease;
	}

	input:hover {
		border-color: color-mix(in srgb, var(--fg) 50%, var(--line));
	}

	input:focus {
		border-color: var(--auth-accent);
		box-shadow: 0 0 0 1px var(--auth-accent) !important;
	}

	.auth-password {
		position: relative;
	}

	.auth-password input {
		padding-right: 50px;
	}

	.auth-reveal {
		position: absolute;
		top: 50%;
		right: 8px;
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		padding: 0;
		transform: translateY(-50%);
		border: 0;
		border-radius: 6px !important;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.auth-reveal:hover {
		background: var(--soft);
		color: var(--fg);
	}

	.auth-reveal:focus-visible {
		outline: 2px solid var(--auth-accent);
		outline-offset: 1px;
	}

	.auth-reveal svg {
		width: 19px;
		height: 19px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.45;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.auth-submit {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 9px;
		width: 100%;
		height: 52px;
		margin-top: 4px;
		padding: 0 18px;
		border: 1px solid var(--auth-accent);
		border-radius: 8px !important;
		background: var(--auth-accent);
		color: #ffffff;
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 140ms ease, border-color 140ms ease, transform 100ms ease;
	}

	.auth-submit:hover:not(:disabled) {
		border-color: var(--auth-accent-hover);
		background: var(--auth-accent-hover);
	}

	.auth-submit:active:not(:disabled) {
		transform: scale(0.995);
	}

	.auth-submit:focus-visible {
		outline: 2px solid var(--auth-accent);
		outline-offset: 3px;
	}

	.auth-submit:disabled {
		border-color: color-mix(in srgb, var(--auth-accent) 45%, var(--bg));
		background: color-mix(in srgb, var(--auth-accent) 45%, var(--bg));
		cursor: default;
	}

	.auth-spinner {
		width: 17px;
		height: 17px;
		border: 2px solid color-mix(in srgb, #ffffff 40%, transparent);
		border-top-color: #ffffff;
		border-radius: 50% !important;
		animation: auth-spin 700ms linear infinite;
	}

	.auth-error {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin-top: -4px;
		color: var(--error);
		font-size: 13px;
		line-height: 1.45;
	}

	.auth-error svg {
		width: 17px;
		height: 17px;
		flex: 0 0 auto;
		margin-top: 1px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
	}

	.auth-setup {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 16px;
		border: 1px solid var(--line);
		border-radius: 8px !important;
		background: var(--soft);
		color: var(--muted);
		font-size: 13px;
		line-height: 1.5;
	}

	.auth-setup > svg {
		width: 20px;
		height: 20px;
		flex: 0 0 auto;
		fill: none;
		stroke: var(--error);
		stroke-width: 1.5;
		stroke-linecap: round;
	}

	.auth-setup div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.auth-setup strong {
		color: var(--fg);
		font-weight: 600;
	}

	.auth-setup code {
		padding: 1px 4px;
		background: color-mix(in srgb, var(--fg) 7%, var(--soft));
		font-size: 12px;
	}

	.auth-foot {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 24px;
		color: var(--faint);
		font-size: 12px;
		line-height: 1;
	}

	.auth-foot svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.3;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	@keyframes auth-enter {
		from { opacity: 0; }
	}

	@keyframes auth-spin {
		to { transform: rotate(360deg); }
	}

	@media (max-width: 600px) {
		.auth-brand {
			margin: 22px 20px;
		}

		.auth-main {
			align-items: flex-start;
			padding: clamp(56px, 12vh, 104px) 24px 48px;
		}

		.auth-head {
			margin-bottom: 30px;
		}

		.auth-foot {
			padding: 20px 24px 24px;
		}
	}

	@media (max-width: 360px) {
		.auth-main {
			padding-inline: 18px;
		}
	}

	@media (max-height: 680px) {
		.auth-main {
			align-items: flex-start;
			padding-top: 28px;
			padding-bottom: 40px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.auth-page,
		.auth-spinner {
			animation: none;
		}
	}
</style>
