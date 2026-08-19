import { createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import bash from 'shiki/langs/bash.mjs';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import csharp from 'shiki/langs/csharp.mjs';
import css from 'shiki/langs/css.mjs';
import diff from 'shiki/langs/diff.mjs';
import dockerfile from 'shiki/langs/dockerfile.mjs';
import go from 'shiki/langs/go.mjs';
import graphql from 'shiki/langs/graphql.mjs';
import hcl from 'shiki/langs/hcl.mjs';
import html from 'shiki/langs/html.mjs';
import ini from 'shiki/langs/ini.mjs';
import java from 'shiki/langs/java.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import kotlin from 'shiki/langs/kotlin.mjs';
import makefile from 'shiki/langs/makefile.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import php from 'shiki/langs/php.mjs';
import powershell from 'shiki/langs/powershell.mjs';
import python from 'shiki/langs/python.mjs';
import ruby from 'shiki/langs/ruby.mjs';
import rust from 'shiki/langs/rust.mjs';
import scss from 'shiki/langs/scss.mjs';
import sql from 'shiki/langs/sql.mjs';
import svelte from 'shiki/langs/svelte.mjs';
import swift from 'shiki/langs/swift.mjs';
import toml from 'shiki/langs/toml.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import vue from 'shiki/langs/vue.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import githubDark from 'shiki/themes/github-dark.mjs';
import githubLight from 'shiki/themes/github-light.mjs';
import { fallbackHtml, resolveLang } from './code-utils';

const highlighter = createHighlighterCoreSync({
	engine: createJavaScriptRegexEngine(),
	langs: [
		bash,
		c,
		cpp,
		csharp,
		css,
		diff,
		dockerfile,
		go,
		graphql,
		hcl,
		html,
		ini,
		java,
		javascript,
		json,
		jsx,
		kotlin,
		makefile,
		markdown,
		php,
		powershell,
		python,
		ruby,
		rust,
		scss,
		sql,
		svelte,
		swift,
		toml,
		tsx,
		typescript,
		vue,
		xml,
		yaml
	],
	themes: [githubLight, githubDark]
});

const loadedLangs = new Set(highlighter.getLoadedLanguages());

export function highlight(code: string, lang: string): string {
	const resolved = resolveLang(lang);
	if (!resolved || !loadedLangs.has(resolved)) return fallbackHtml(code, resolved);
	try {
		return highlighter.codeToHtml(code, {
			lang: resolved,
			themes: { light: 'github-light', dark: 'github-dark' },
			defaultColor: false
		});
	} catch {
		return fallbackHtml(code, resolved);
	}
}
