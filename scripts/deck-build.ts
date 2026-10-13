#!/usr/bin/env node
// `just deck`: compile content/ into the reveal.js deck, fully offline.
//
// Contract: docs/content-contract.md. Inputs: content/sections/NN-slug.md (in
// NN order, one column each; a `--` line starts a vertical subslide below the
// headline slide), <notes-dir>/NN.md (its speaker notes, split by `--` the same
// way), content/diagrams/*.svg, content/media/*. The notes live in a private
// directory outside this repo, passed to `just notes <context> <dir>`, and never
// enter git or the image; without --notes-dir the deck builds with no notes. `::media` shows a content/media image
// (its sha256 checked against a provenance sidecar when one records it). `::live` embeds a live surface as a
// lazy reveal iframe (data-src); print/PDF shows its title and link instead.
// `::video` leaves a hidden slot that RevealDeck fills with the walkthrough video.
//
// Rendering happens here, at build time, so no markdown/KaTeX/shiki code
// reaches the client: KaTeX for $..$ / $$..$$ (@vscode/markdown-it-katex), shiki (github-light/dark pair
// as CSS variables, defaultColor:false) for code fences, markdown-it for GFM.
//
// Outputs:
//   src/lib/generated/deck-public.ts     DECK_HTML (no notes) and its DECK_ID; /deck and
//                                        /presenter both ship it (committed)
//   overlay/notes.json                   {deck: DECK_ID, notes: {"h.v": notes HTML}};
//                                        the overlay image serves it at /presenter/notes.json,
//                                        outside the static root (`just notes-gate`; ignored)
//   static/deck-media/*                  copied from content/media (ignored)
//
// Usage: node scripts/deck-build.ts [--content <dir>] [--out <srcGeneratedDir>]
//        [--static <dir>] [--notes <file>] [--notes-dir <dir>] [--check]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import katexPlugin from '@vscode/markdown-it-katex';
import katex from 'katex';
import MarkdownIt from 'markdown-it';
import { type BundledLanguage, bundledLanguages, createHighlighter } from 'shiki';
import { ROOT, cli, fenceLines, parseAttrs, slideAttrs, splitSubslides } from './lib/deck.ts';

const SHIKI_THEMES = { light: 'github-light', dark: 'github-dark' };
const { values: flag } = cli('deck-build', {
	content: { type: 'string', default: 'content' },
	out: { type: 'string', default: 'src/lib/generated' },
	static: { type: 'string', default: 'static' },
	notes: { type: 'string', default: 'overlay/notes.json' },
	'notes-dir': { type: 'string' },
	check: { type: 'boolean', default: false },
});
const contentDir = path.resolve(ROOT, flag.content);
const outDir = path.resolve(ROOT, flag.out);
const staticDir = path.resolve(ROOT, flag.static);
const notesFile = path.resolve(ROOT, flag.notes);
const notesDir = flag['notes-dir'] === undefined ? '' : path.resolve(ROOT, flag['notes-dir']);
const checkMode = flag.check;

type Attrs = Record<string, string>;

const errors: string[] = [];
const fail = (where: string, msg: string) => errors.push(`${where}: ${msg}`);

// ─── Sections and their notes ─────────────────────────────────────────────
// `NN-slug.md` is slide NN; its speaker notes are `<notes-dir>/NN.md` when
// --notes-dir names a directory. No other place is read, so a stale copy
// in content/ fails the build instead of shipping.
function readSections() {
	const dir = path.join(contentDir, 'sections');
	const notes = new Map<string, string>();
	if (fs.existsSync(path.join(contentDir, 'notes')))
		fail('notes/', 'notes live outside this repo; move them out and pass the directory to `just notes`');
	if (notesDir && !fs.statSync(notesDir, { throwIfNoEntry: false })?.isDirectory())
		fail('--notes-dir', `${notesDir} is not a directory`);
	else if (notesDir && !path.relative(fs.realpathSync(ROOT), fs.realpathSync(notesDir)).startsWith('..'))
		fail('--notes-dir', `${notesDir} is inside this repo, where git or the static build can pick it up`);
	else if (notesDir) {
		for (const f of fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'))) {
			if (!/^\d+\.md$/.test(f)) fail(`notes/${f}`, 'name must be NN.md');
			else notes.set(f.slice(0, -3), fs.readFileSync(path.join(notesDir, f), 'utf8'));
		}
		if (!notes.size) fail('--notes-dir', `no NN.md notes in ${notesDir}`);
	}
	const out: { file: string; nn: string; slug: string; source: string; notes: string }[] = [];
	for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : []) {
		const m = /^(\d+)-[\w-]+\.md$/.exec(file);
		if (!m) {
			fail(`sections/${file}`, 'name must be NN-slug.md');
			continue;
		}
		out.push({
			file,
			nn: m[1],
			slug: file.slice(0, -3),
			source: fs.readFileSync(path.join(dir, file), 'utf8'),
			notes: '',
		});
	}
	out.sort((a, b) => parseInt(a.nn, 10) - parseInt(b.nn, 10));
	for (const [i, s] of out.entries())
		if (i && parseInt(s.nn, 10) === parseInt(out[i - 1].nn, 10))
			fail(`sections/${s.file}`, `two files for slide ${s.nn}`);
	for (const s of out) {
		s.notes = notes.get(s.nn) ?? '';
		notes.delete(s.nn);
	}
	for (const nn of notes.keys()) fail(`notes/${nn}.md`, `no content/sections/${nn}-*.md`);
	return out;
}

// ─── Renderer ─────────────────────────────────────────────────────────────
const loadedLangs = new Set(['text']);
async function ensureLang(lang: string) {
	const l = (lang || 'text').toLowerCase();
	if (loadedLangs.has(l)) return l;
	if (!(l in bundledLanguages)) return 'text';
	await highlighter.loadLanguage(l as BundledLanguage);
	loadedLangs.add(l);
	return l;
}
const codeHtml = (code: string, lang: string) =>
	highlighter.codeToHtml(code, {
		lang: loadedLangs.has(lang) ? lang : 'text',
		themes: SHIKI_THEMES,
		defaultColor: false,
	});

const md = new MarkdownIt({
	html: true,
	linkify: true,
	typographer: false,
	highlight: (code, lang) => codeHtml(code.replace(/\n$/, ''), (lang || 'text').toLowerCase()),
});
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
	const href = String(tokens[idx].attrGet('href') ?? '');
	if (/^https?:\/\//.test(href)) {
		tokens[idx].attrSet('target', '_blank');
		tokens[idx].attrSet('rel', 'noopener noreferrer');
	}
	return self.renderToken(tokens, idx, options);
};
// The plugin is CommonJS with `exports.default`, which Node's default import wraps. It passes its options to KaTeX.
const mathPlugin = (katexPlugin as unknown as { default?: typeof katexPlugin }).default ?? katexPlugin;
md.use(mathPlugin, { katex, throwOnError: true, strict: 'ignore', output: 'htmlAndMathml' } as never);
const { escapeHtml } = md.utils;

/** Markdown to HTML; a formula KaTeX cannot parse fails the build. */
function renderMarkdown(lines: string[], where: string) {
	const html = md.render(lines.join('\n'));
	for (const m of html.matchAll(/katex-error" title="([^"]*)">([^<]*)/g)) fail(where, `KaTeX: ${m[2]} in ${m[1]}`);
	return html;
}

function srcChip(attrs: Attrs, where: string) {
	if (/^https:\/\/[^\s"<>]+$/.test(attrs.ref ?? '')) {
		// External primary source (paper, vendor doc): a plain citation chip.
		const label = attrs.label || attrs.ref.replace(/^https:\/\//, '');
		return `<a class="src-chip src-chip--ext" href="${escapeHtml(attrs.ref)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(attrs.ref)}"><span class="src-chip__icon" aria-hidden="true">↗</span>${escapeHtml(label)}</a>`;
	}
	const m = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{7,40}):([^#]+)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(attrs.ref ?? '');
	if (!m) {
		fail(where, `::src ref must be OWNER/REPO@sha:path#Lx-Ly or an https URL, got ${JSON.stringify(attrs.ref)}`);
		return '';
	}
	const [, repo, sha, p, a, b] = m;
	const anchor = a ? `#L${a}${b ? `-L${b}` : ''}` : '';
	const href = `https://github.com/${repo}/blob/${sha}/${p}${anchor}`;
	const label = attrs.label || `${repo}@${sha.slice(0, 7)}:${p}${anchor}`;
	return `<a class="src-chip" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(attrs.ref)}"><span class="src-chip__icon" aria-hidden="true">⌥</span>${escapeHtml(label)}</a>`;
}

const mediaUsed = new Set<string>();
/** A content/media image in a figure: a ::media chart. */
function mediaHtml(attrs: Attrs, where: string) {
	const src = attrs.src ?? '';
	const file = path.join(contentDir, 'media', src);
	if (!src || src.includes('..') || !fs.existsSync(file)) {
		fail(where, `::media src ${JSON.stringify(src)} not found under content/media`);
		return '';
	}
	const side = file.replace(/\.\w+$/, '.provenance.json');
	const want = fs.existsSync(side) && JSON.parse(fs.readFileSync(side, 'utf8')).sha256;
	if (want && createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== want)
		fail(where, `${src} differs from the sha256 in its provenance sidecar`);
	mediaUsed.add(src);
	const url = `/deck-media/${src.split('/').map(encodeURIComponent).join('/')}`;
	return `<figure class="media"><img src="${url}" alt="${escapeHtml(attrs.alt ?? '')}" loading="lazy" decoding="async" /></figure>`;
}

function svgHtml(attrs: Attrs, where: string) {
	const name = (attrs.src ?? '').replace(/\.svg$/, '');
	const file = path.join(contentDir, 'diagrams', `${name}.svg`);
	if (!name || name.includes('/') || !fs.existsSync(file)) {
		fail(where, `::svg src ${JSON.stringify(attrs.src)} not found under content/diagrams`);
		return '';
	}
	let svg = fs
		.readFileSync(file, 'utf8')
		.replace(/<\?xml[\s\S]*?\?>/, '')
		.replace(/<!DOCTYPE[\s\S]*?>/i, '')
		.trim();
	if (!/^<svg[\s>]/.test(svg)) fail(where, `${name}.svg does not start with <svg>`);
	if (/<script[\s>]/i.test(svg)) fail(where, `${name}.svg carries a <script>; diagrams are static SVG`);
	if (!/viewBox=/.test(svg)) fail(where, `${name}.svg has no viewBox`);
	svg = svg.replace(/^<svg/, `<svg class="diagram" data-diagram="${escapeHtml(name)}"`);
	return `<figure class="diagram-wrap">${svg}</figure>`;
}

/** A slide body as markdown runs and `::name{attrs}` directive lines (outside code fences). */
function parseBlocks(lines: string[], where: string) {
	const nodes: { type: string; attrs: Attrs; lines: string[] }[] = [];
	const fenced = fenceLines(lines);
	for (const [i, line] of lines.entries()) {
		if (!fenced.has(i) && /^Notes?:/.test(line)) fail(where, 'speaker notes go in the notes directory, not the slide');
		const d = fenced.has(i) ? null : /^::([a-z]+)(?:\{(.*)\})?\s*$/.exec(line.trim());
		if (!d) {
			if (nodes.at(-1)?.type !== 'md') nodes.push({ type: 'md', attrs: {}, lines: [] });
			nodes.at(-1)!.lines.push(line);
		} else if (['svg', 'src', 'media', 'live', 'video'].includes(d[1]))
			nodes.push({ type: d[1], attrs: parseAttrs(d[2]), lines: [] });
		else fail(where, `unknown directive ::${d[1]}`);
	}
	return nodes;
}

/** A slide's HTML. */
function renderNodes(nodes: ReturnType<typeof parseBlocks>, where: string) {
	let html = '';
	for (const { type, attrs, lines } of nodes) {
		if (type === 'md') {
			if (lines.some((l) => l.trim())) html += renderMarkdown(lines, where);
		} else if (type === 'svg') html += svgHtml(attrs, where);
		else if (type === 'src') html += srcChip(attrs, where);
		else if (type === 'media') html += mediaHtml(attrs, where);
		else if (type === 'live') html += liveHtml(attrs, where);
		else if (type === 'video') html += videoHtml(attrs, where);
	}
	return html;
}

// A /path on this site or an https URL; no protocol-relative `//` or `/\` form,
// no scheme other than https, no whitespace, quotes or angle brackets.
const LIVE_SRC = /^(?:\/(?![/\\])[^\s"'<>\\]*|https:\/\/[a-z0-9.-]+(?::\d+)?(?:[/?#][^\s"'<>\\]*)?)$/i;
const LIVE_ATTRS = ['src', 'title', 'height', 'caption'];
const SITE = 'https://adi.clients.xoxd.ai';

/**
 * ::live{src="/path" title="..." height="600" caption="..."}: a live surface in an iframe that reveal loads once its
 * slide is within viewDistance and keeps while it stays there (data-src with data-preload), so the frame is warm when
 * its slide shows. Print and PDF cannot render a frame: there it is one line, the title and an absolute link.
 */
function liveHtml(attrs: Attrs, where: string) {
	const src = attrs.src ?? '';
	if (!LIVE_SRC.test(src)) {
		fail(where, `::live src must be a /path on this site or an https URL, got ${JSON.stringify(src)}`);
		return '';
	}
	const extra = Object.keys(attrs).filter((k) => !LIVE_ATTRS.includes(k));
	if (extra.length) fail(where, `::live takes only ${LIVE_ATTRS.join(', ')}; remove ${extra.join(', ')}`);
	if (!attrs.title) fail(where, '::live needs title="..." (the iframe accessible name)');
	const h = /^\d+(px|vh)?$/.test(attrs.height ?? '') ? attrs.height : '600';
	const height = /\d$/.test(h) ? `${h}px` : h;
	const title = escapeHtml(attrs.title ?? '');
	const url = escapeHtml(new URL(src, SITE).href);
	return (
		`<figure class="deck-live">` +
		`<iframe class="deck-live__frame" data-src="${escapeHtml(src)}" data-preload title="${title}" ` +
		`style="height:${height}" referrerpolicy="strict-origin" allow="fullscreen"></iframe>` +
		`<p class="deck-live__print">${title} · <a href="${url}">${url}</a></p>` +
		`<figcaption class="deck-live__caption"><a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">open live</a> · ${escapeHtml(attrs.caption ?? attrs.title ?? '').replace(/`([^`]+)`/g, '<code>$1</code>')}</figcaption>` +
		`</figure>`
	);
}

/**
 * ::video{title="..."}: a hidden slot. RevealDeck fills it with src/lib/components/YouTubeLite.svelte when
 * src/lib/site.ts sets YOUTUBE_ID, so the deck HTML never carries the id and setting it needs no `just deck`.
 */
function videoHtml(attrs: Attrs, where: string) {
	if (!attrs.title) fail(where, '::video needs title="..." (the player accessible name)');
	return `<div class="deck-video" data-video="${escapeHtml(attrs.title ?? '')}" hidden></div>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────
const sections = readSections();
const langs = new Set<string>();
for (const s of sections) for (const m of s.source.matchAll(/^\s*(?:`{3,}|~{3,})\s*([\w+-]+)/gm)) langs.add(m[1]);
const highlighter = await createHighlighter({ themes: Object.values(SHIKI_THEMES), langs: [] });
for (const l of langs) await ensureLang(l);

let publicHtml = '';
// Speaker notes by slide ("h.v" -> notes HTML), served to /presenter at
// runtime by the overlay server (owner-only path), never part of a page bundle.
const notes: Record<string, string> = {};
for (const [h, s] of sections.entries()) {
	// Part 0 is the headline slide; each `--` part below it is subslide v, and note part v is its note.
	const parts = splitSubslides(s.source.split('\n'));
	const noteParts = splitSubslides(s.notes.split('\n'));
	if (s.notes.trim() && noteParts.length > parts.length)
		fail(`notes/${s.nn}.md`, `${noteParts.length} parts for the ${parts.length} slides of ${s.file}`);
	let column = '';
	for (const [v, part] of parts.entries()) {
		const where = `${s.file} slide ${h}${v ? `.${v}` : ''}`;
		const { attrs, lines } = slideAttrs(part);
		const html = renderNodes(parseBlocks(lines, where), where);
		column += `<section${attrs ? ` ${attrs}` : ''} data-slug="${s.slug}" data-h="${h}" data-v="${v}">${html}</section>`;
		const note = (noteParts[v] ?? []).join('\n');
		if (note.trim()) notes[`${h}.${v}`] = renderMarkdown(note.split('\n'), `notes/${s.nn}.md${v ? ` part ${v}` : ''}`);
	}
	publicHtml += `<section class="stack" data-slug="${s.slug}">${column}</section>`;
}
if (/class="notes"/.test(publicHtml)) fail('public deck', 'speaker notes leaked into the public build');
// Ties the notes payload to the exact slide HTML it annotates: /presenter
// drops notes whose DECK_ID differs (a page loaded before a deploy).
const deckId = createHash('sha256').update(publicHtml).digest('hex').slice(0, 16);

if (errors.length) {
	console.error(`deck-build: ${errors.length} error(s):`);
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

const banner = '// GENERATED by scripts/deck-build.ts from content/. Do not edit; run `just deck`.\n';
const outputs = new Map([
	[
		path.join(outDir, 'deck-public.ts'),
		`${banner}export const DECK_ID: string = ${JSON.stringify(deckId)};\nexport const DECK_HTML: string = ${JSON.stringify(publicHtml)};\n`,
	],
]);
if (checkMode) {
	const drift = [...outputs].filter(([f, c]) => !fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== c);
	if (drift.length) {
		console.error(
			`deck-build: generated output drifted; run \`just deck\`:\n  - ${drift.map(([f]) => path.relative(ROOT, f)).join('\n  - ')}`,
		);
		process.exit(1);
	}
} else {
	outputs.set(notesFile, JSON.stringify({ deck: deckId, notes }, null, '\t') + '\n');
	for (const [file, content] of outputs) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	// Media: content/media -> static/deck-media (only what slides use).
	const mediaOut = path.join(staticDir, 'deck-media');
	fs.rmSync(mediaOut, { recursive: true, force: true });
	for (const src of mediaUsed) {
		fs.mkdirSync(path.dirname(path.join(mediaOut, src)), { recursive: true });
		fs.copyFileSync(path.join(contentDir, 'media', src), path.join(mediaOut, src));
	}
}
console.log(
	`deck-build: ${sections.length} columns, ${(publicHtml.match(/data-v="/g) ?? []).length} slides, ${Object.keys(notes).length} notes, ${mediaUsed.size} media${checkMode ? ' (check: current)' : ''}`,
);
