import { json } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit';
import { AUTH_COOKIE, verifyAuthToken } from '$lib/server/auth';

const PUBLIC_API_ROUTES = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/status']);

export const handle: Handle = async ({ event, resolve }) => {
	if (event.url.pathname.startsWith('/api/') && !PUBLIC_API_ROUTES.has(event.url.pathname)) {
		const authenticated = verifyAuthToken(event.cookies.get(AUTH_COOKIE));
		if (!authenticated) {
			return json(
				{ error: 'Authentication required.' },
				{ status: 401, headers: { 'cache-control': 'no-store' } }
			);
		}
	}

	return resolve(event);
};
