const LANG_ALIASES: Record<string, string> = {
	'c#': 'csharp',
	'c++': 'cpp',
	console: 'bash',
	docker: 'dockerfile',
	fish: 'bash',
	golang: 'go',
	kt: 'kotlin',
	ps: 'powershell',
	ps1: 'powershell',
	py: 'python',
	rs: 'rust',
	sh: 'bash',
	shell: 'bash',
	tf: 'hcl',
	terraform: 'hcl',
	yml: 'yaml',
	zsh: 'bash'
};

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function resolveLang(lang: string): string {
	return LANG_ALIASES[lang.trim().toLowerCase()] ?? lang.trim().toLowerCase();
}

export function fallbackHtml(code: string, lang: string): string {
	const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
	return `<pre class="shiki shiki-fallback"${langAttr}><code>${escapeHtml(code)}</code></pre>`;
}
