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

<div class="auth-backdrop">
	<div class="auth-panel" role="dialog" aria-modal="true" aria-labelledby="auth-title">
		<div class="auth-head">
			<div class="auth-mark" aria-hidden="true">π</div>
			<div class="auth-kicker">Private workspace</div>
			<h1 id="auth-title">Sign in to Pi</h1>
			<p>Your conversations and coding agent are protected behind this access gate.</p>
		</div>

		{#if configured === null}
			<div class="auth-setup" role="alert">
				<strong>Server unavailable</strong>
				<span>Check that the Pi web server is running, then reload this page.</span>
			</div>
		{:else if !configured}
			<div class="auth-setup" role="alert">
				<strong>Authentication is not configured</strong>
				<span>Set <code>PI_WEB_USER</code> and <code>PI_WEB_PASS</code>, then restart the server.</span>
			</div>
		{:else}
			<form onsubmit={(event) => { event.preventDefault(); void login(); }}>
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

				<div class="auth-label-row">
					<label for="auth-password">Password</label>
					<span>Case-sensitive</span>
				</div>
				<input
					bind:value={password}
					id="auth-password"
					name="password"
					type="password"
					autocomplete="current-password"
					required
				/>

				{#if error}<div class="auth-error" role="alert">{error}</div>{/if}

				<button type="submit" disabled={submitting || !username || !password}>
					<span>{submitting ? 'Signing in' : 'Continue'}</span>
					<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
						<path d="M2 7h9M8 3.5 11.5 7 8 10.5" fill="none" stroke="currentColor" stroke-width="1.4" />
					</svg>
				</button>
			</form>
		{/if}

		<div class="auth-foot">
			<span class="auth-status" class:error={configured !== true} aria-hidden="true"></span>
			Secure session · expires in 24 hours
		</div>
	</div>
</div>

<style>
	.auth-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		padding: 24px 16px;
		background: color-mix(in srgb, var(--bg) 86%, transparent);
		backdrop-filter: blur(6px);
	}

	.auth-panel {
		width: min(408px, 100%);
		background: var(--bg);
		border: 1px solid var(--fg);
		animation: auth-enter 180ms ease-out both;
	}

	.auth-head {
		position: relative;
		padding: 28px 28px 24px;
		border-bottom: 1px solid var(--line);
	}

	.auth-mark {
		position: absolute;
		top: 22px;
		right: 27px;
		font-size: 28px;
		font-weight: 650;
		line-height: 1;
		letter-spacing: -0.04em;
	}

	.auth-kicker {
		margin-bottom: 34px;
		color: var(--muted);
		font-size: 10.5px;
		font-weight: 650;
		letter-spacing: 0.13em;
		text-transform: uppercase;
	}

	h1 {
		margin: 0;
		font-size: 24px;
		font-weight: 650;
		line-height: 1.2;
		letter-spacing: -0.035em;
	}

	p {
		margin: 7px 0 0;
		max-width: 310px;
		color: var(--muted);
		font-size: 13px;
		line-height: 1.55;
	}

	form {
		display: flex;
		flex-direction: column;
		padding: 24px 28px 28px;
	}

	label,
	.auth-label-row span {
		font-size: 11px;
		font-weight: 620;
		letter-spacing: 0.045em;
		text-transform: uppercase;
	}

	.auth-label-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-top: 17px;
	}

	.auth-label-row span {
		color: var(--faint);
		font-size: 9.5px;
		font-weight: 500;
	}

	input {
		width: 100%;
		height: 42px;
		margin-top: 6px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		background: var(--bg);
		font-size: 14px;
		outline: none;
	}

	input:hover {
		border-color: var(--faint);
	}

	input:focus {
		border-color: var(--fg);
		outline: 1px solid var(--fg);
		outline-offset: -2px;
	}

	button {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		height: 43px;
		margin-top: 22px;
		padding: 0 13px 0 15px;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: var(--accent-fg);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		opacity: 0.84;
	}

	button:focus-visible {
		outline: 2px solid var(--fg);
		outline-offset: 3px;
	}

	button:disabled {
		opacity: 0.32;
		cursor: default;
	}

	.auth-error {
		margin-top: 13px;
		padding-left: 9px;
		border-left: 2px solid var(--error);
		color: var(--error);
		font-size: 12.5px;
		line-height: 1.45;
	}

	.auth-setup {
		margin: 24px 28px 28px;
		padding: 13px 14px;
		border: 1px solid var(--line);
		color: var(--muted);
		font-size: 12.5px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		border-left-color: var(--error);
	}

	.auth-setup strong {
		color: var(--fg);
		font-weight: 600;
	}

	.auth-setup code {
		background: var(--soft);
		padding: 1px 4px;
		font-size: 11.5px;
	}

	.auth-foot {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 10px 28px;
		border-top: 1px solid var(--line);
		color: var(--faint);
		font-size: 10.5px;
		letter-spacing: 0.015em;
	}

	.auth-status {
		width: 6px;
		height: 6px;
		background: #2e9b57;
	}

	@keyframes auth-enter {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}

	@media (max-width: 480px) {
		.auth-backdrop {
			align-items: end;
			padding: 12px;
		}

		.auth-head {
			padding: 24px 22px 21px;
		}

		.auth-mark {
			top: 19px;
			right: 21px;
		}

		.auth-kicker {
			margin-bottom: 29px;
		}

		form {
			padding: 21px 22px 24px;
		}

		.auth-setup {
			margin: 21px 22px 24px;
		}

		.auth-foot {
			padding-inline: 22px;
		}
	}

	@media (max-width: 719px) {
		input {
			font-size: 16px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.auth-panel {
			animation: none;
		}
	}
</style>
