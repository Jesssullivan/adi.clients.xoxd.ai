// The core's docs (content/docs/, copied from Jesssullivan/adi-sms by `just docs`), rendered at build time. Each
// NN-slug.svx is YAML front matter {title, order, summary} over plain Markdown: tables, code fences and headings.
import katexPlugin from '@vscode/markdown-it-katex';
import katex from 'katex';
import MarkdownIt from 'markdown-it';
import pin from '../../../content/docs/source.json';

export type Doc = { slug: string; title: string; order: number; summary: string; html: string };

const files = import.meta.glob<string>('/content/docs/*.svx', { query: '?raw', import: 'default', eager: true });
const images = import.meta.glob<string>('/content/docs/*.svg', { query: '?url', import: 'default', eager: true });
/** The core's docs/ at the commit `just docs` copied. */
const source = `https://github.com/${pin.repo}/tree/${pin.ref}/docs`;
const slugOf = (file: string) => file.replace(/^.*\/\d+-|\.svx$/g, '');

// $..$ and $$..$$ as MathML, which browsers draw without KaTeX's stylesheet or fonts. The plugin is CommonJS with
// `exports.default`, which Node's default import wraps.
const mathPlugin = (katexPlugin as unknown as { default?: typeof katexPlugin }).default ?? katexPlugin;
const md = new MarkdownIt({ html: false, linkify: true }).use(mathPlugin, { katex, output: 'mathml' } as never);
// Skeleton's table, pre, blockquote and anchor styles; a link to a sibling shard or image points at its page or asset.
md.renderer.rules.table_open = () => '<div class="table-wrap"><table class="table">';
md.renderer.rules.table_close = () => '</table></div>';
md.core.ruler.push('skeleton', (state) => {
	const walk = (tokens: typeof state.tokens) => {
		for (const t of tokens) {
			if (t.type === 'blockquote_open') t.attrJoin('class', 'blockquote');
			if (t.type === 'link_open') {
				t.attrJoin('class', 'anchor');
				t.attrSet('href', String(t.attrGet('href')).replace(/^\.\/\d+-([\w-]+)\.svx/, '/docs/$1'));
			}
			const src = String(t.attrGet('src'));
			if (t.type === 'image') t.attrSet('src', images[src.replace(/^\.\//, '/content/docs/')] ?? src);
			if (t.children) walk(t.children);
		}
	};
	walk(state.tokens);
});
md.renderer.rules.fence = md.renderer.rules.code_block = (t, i) =>
	`<pre class="pre"><code>${md.utils.escapeHtml(t[i].content)}</code></pre>`;

/** Every shard in order. The leading `# title` line is dropped, because the page prints the front matter's title. */
export function docs(): Doc[] {
	return Object.entries(files)
		.map(([file, src]) => {
			const [, head = '', body = src] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(src) ?? [];
			const meta = Object.fromEntries(
				head.split('\n').map((l) => [
					l.split(':')[0].trim(),
					l
						.slice(l.indexOf(':') + 1)
						.trim()
						.replace(/^(['"])(.*)\1$/, '$2'),
				]),
			);
			const text = body.replace(/^\s*# .*\n/, '');
			return {
				slug: slugOf(file),
				title: meta.title,
				order: Number(meta.order),
				summary: meta.summary ?? '',
				html: md.render(text),
			};
		})
		.sort((a, b) => a.order - b.order);
}

/** A /docs page: every doc's slug and title for the tab bar, and the doc at `slug` (the first one when it is
 * undefined) with its neighbours. Undefined when no doc has that slug. */
export function docPage(slug?: string) {
	const all = docs();
	const i = slug === undefined ? 0 : all.findIndex((d) => d.slug === slug);
	if (i < 0) return undefined;
	const tabs = all.map(({ slug, title }) => ({ slug, title }));
	return { tabs, doc: all[i], prev: tabs[i - 1], next: tabs[i + 1], source };
}
