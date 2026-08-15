import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	AUTH_COOKIE,
	AUTH_TTL_SECONDS,
	authConfig,
	createAuthToken,
	credentialsMatch,
	secureCookie
} from '$lib/server/auth';

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!authConfig().configured) {
		return json(
			{ error: 'Set PI_WEB_USER and PI_WEB_PASS in the server environment.' },
			{ status: 503, headers: { 'cache-control': 'no-store' } }
		);
	}

	const body = await request.json().catch(() => null);
	if (!credentialsMatch(body?.username, body?.password)) {
		return json(
			{ error: 'Username or password is incorrect.' },
			{ status: 401, headers: { 'cache-control': 'no-store' } }
		);
	}

	cookies.set(AUTH_COOKIE, createAuthToken(), {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure: secureCookie(request),
		maxAge: AUTH_TTL_SECONDS
	});

	return json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
};
