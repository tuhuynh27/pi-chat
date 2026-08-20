import { json } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit';
import { AUTH_COOKIE, verifyAuthToken } from '$lib/server/auth';

const PUBLIC_API_ROUTES = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/status']);

function logApi(event: Parameters<Handle>[0]['event'], status: number, startedAt: number) {
	const length = event.request.headers.get('content-length') ?? '-';
	console.log(
		`api ${event.request.method} ${event.url.pathname} ${status} cl=${length} ${Date.now() - startedAt}ms`
	);
}

export const handle: Handle = async ({ event, resolve }) => {
	const startedAt = Date.now();
	const isApi = event.url.pathname.startsWith('/api/');
	if (isApi && !PUBLIC_API_ROUTES.has(event.url.pathname)) {
		const authenticated = verifyAuthToken(event.cookies.get(AUTH_COOKIE));
		if (!authenticated) {
			logApi(event, 401, startedAt);
			return json(
				{ error: 'Authentication required.' },
				{ status: 401, headers: { 'cache-control': 'no-store' } }
			);
		}
	}

	// The HTML shell contains deployment-specific hashed asset URLs. Never let a
	// browser or reverse proxy reuse it after a new image has been deployed.
	if (
		event.request.method === 'GET' &&
		!event.url.pathname.startsWith('/api/')
	) {
		event.setHeaders({
			'cache-control': 'private, no-store, max-age=0',
			pragma: 'no-cache',
			expires: '0'
		});
	}

	const response = await resolve(event);
	if (isApi) logApi(event, response.status, startedAt);
	return response;
};
