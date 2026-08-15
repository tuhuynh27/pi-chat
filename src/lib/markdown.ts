import MarkdownIt from 'markdown-it';

/**
 * Markdown rendering for assistant messages.
 * `html: false` (default) escapes raw HTML in the source, so output is
 * safe to inject without a second sanitization pass.
 */
const md = new MarkdownIt({
	html: false,
	linkify: true,
	breaks: true
});

export function renderMarkdown(src: string): string {
	return md.render(src);
}
