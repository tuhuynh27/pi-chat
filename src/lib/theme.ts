export type Theme = 'light' | 'dark';

const KEY = 'pi-web-theme';

function systemTheme(): Theme {
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyThemeColor(theme: Theme) {
	document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d0d0f' : '#ffffff');
}

// Resolves to the stored preference if the user has toggled before, otherwise
// the OS preference (matches the un-attributed :root defaults in app.css).
export function resolvedTheme(): Theme {
	const stored = localStorage.getItem(KEY);
	return stored === 'light' || stored === 'dark' ? stored : systemTheme();
}

// Reconciles state that app.html's inline script already applied pre-paint;
// only needed to sync the toggle icon and theme-color meta after hydration.
export function initTheme(): Theme {
	const theme = resolvedTheme();
	applyThemeColor(theme);
	return theme;
}

export function setTheme(theme: Theme) {
	localStorage.setItem(KEY, theme);
	document.documentElement.setAttribute('data-theme', theme);
	applyThemeColor(theme);
}
