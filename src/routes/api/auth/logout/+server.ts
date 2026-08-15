import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AUTH_COOKIE, secureCookie } from '$lib/server/auth';

export const POST: RequestHandler = ({ request, cookies }) => {
	cookies.delete(AUTH_COOKIE, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure: secureCookie(request)
	});
	return json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
};
