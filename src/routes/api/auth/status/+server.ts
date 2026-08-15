import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AUTH_COOKIE, authConfig, verifyAuthToken } from '$lib/server/auth';

export const GET: RequestHandler = ({ cookies }) => {
	const { configured } = authConfig();
	return json(
		{ configured, authenticated: verifyAuthToken(cookies.get(AUTH_COOKIE)) },
		{ headers: { 'cache-control': 'no-store' } }
	);
};
