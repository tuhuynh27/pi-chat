import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

export const AUTH_COOKIE = 'pi_web_session';
export const AUTH_TTL_SECONDS = 60 * 60 * 24;

const ISSUER = 'pi-web';
const JWT_HEADER = { alg: 'HS256', typ: 'JWT' } as const;

interface JwtPayload {
	sub: string;
	iss: typeof ISSUER;
	iat: number;
	exp: number;
}

export function authConfig() {
	const username = env.PI_WEB_USER?.trim() || (dev ? 'dev' : '');
	const password = env.PI_WEB_PASS || (dev ? 'dev' : '');
	return { username, password, configured: Boolean(username && password) };
}

function encode(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signingKey(username: string, password: string): Buffer {
	return createHash('sha256')
		.update('pi-web-jwt\0')
		.update(username)
		.update('\0')
		.update(password)
		.digest();
}

function signature(input: string, username: string, password: string): string {
	return createHmac('sha256', signingKey(username, password)).update(input).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
	const leftHash = createHash('sha256').update(left).digest();
	const rightHash = createHash('sha256').update(right).digest();
	return timingSafeEqual(leftHash, rightHash);
}

export function credentialsMatch(username: unknown, password: unknown): boolean {
	const config = authConfig();
	if (!config.configured || typeof username !== 'string' || typeof password !== 'string') return false;
	const usernameMatches = safeEqual(username, config.username);
	const passwordMatches = safeEqual(password, config.password);
	return usernameMatches && passwordMatches;
}

export function createAuthToken(now = Math.floor(Date.now() / 1000)): string {
	const config = authConfig();
	if (!config.configured) throw new Error('Authentication is not configured.');

	const header = encode(JWT_HEADER);
	const payload = encode({
		sub: config.username,
		iss: ISSUER,
		iat: now,
		exp: now + AUTH_TTL_SECONDS
	} satisfies JwtPayload);
	const input = `${header}.${payload}`;
	return `${input}.${signature(input, config.username, config.password)}`;
}

export function verifyAuthToken(token: string | undefined, now = Math.floor(Date.now() / 1000)): boolean {
	const config = authConfig();
	if (!config.configured || !token || token.length > 4096) return false;

	const parts = token.split('.');
	if (parts.length !== 3) return false;
	const [headerPart, payloadPart, receivedSignature] = parts;
	const input = `${headerPart}.${payloadPart}`;
	const expectedSignature = signature(input, config.username, config.password);
	if (!safeEqual(receivedSignature, expectedSignature)) return false;

	try {
		const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString()) as Record<string, unknown>;
		const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString()) as Partial<JwtPayload>;
		return (
			header.alg === JWT_HEADER.alg &&
			header.typ === JWT_HEADER.typ &&
			payload.iss === ISSUER &&
			payload.sub === config.username &&
			typeof payload.iat === 'number' &&
			payload.iat <= now &&
			typeof payload.exp === 'number' &&
			payload.exp > now
		);
	} catch {
		return false;
	}
}

export function secureCookie(request: Request): boolean {
	const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
	return forwardedProtocol === 'https' || env.ORIGIN?.startsWith('https://') === true;
}
