import { buildUnsupportedHTML } from '@humanspeak/svelte-markdown';
import {
	FootnoteRef,
	FootnoteSection,
	KatexRenderer,
	markedAlert,
	markedFootnote,
	markedKatex,
	markedMermaid
} from '@humanspeak/svelte-markdown/extensions';
import Alert from './Alert.svelte';
import CodeBlock from './CodeBlock.svelte';
import MdLink from './MdLink.svelte';
import MermaidBlock from './MermaidBlock.svelte';
import PlainDel from './PlainDel.svelte';
import TaskListItem from './TaskListItem.svelte';

export const markdownOptions = {
	gfm: true,
	breaks: true,
	headerIds: false
};

// Tokenizers for the LLM-chat extras: math ($ / $$ / \( \)), mermaid
// fences, GitHub alerts, and footnotes. Raw HTML stays blocked below.
export const markdownExtensions = [
	markedKatex({ singleDollarInline: true }),
	markedMermaid(),
	markedAlert(),
	markedFootnote()
];

export const markdownRenderers = {
	html: buildUnsupportedHTML(),
	code: CodeBlock,
	link: MdLink,
	listitem: TaskListItem,
	del: PlainDel,
	mermaid: MermaidBlock,
	alert: Alert,
	inlineKatex: KatexRenderer,
	blockKatex: KatexRenderer,
	footnoteRef: FootnoteRef,
	footnoteSection: FootnoteSection
};
