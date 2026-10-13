#!/usr/bin/env node
// `just style`: the mechanical half of docs/style-rubric.md, fully offline.
//
// Reads content/sections/NN-slug.md (the slides, in NN order as scripts/deck-build.ts orders them, a `--` line
// starting a vertical subslide), their speaker notes in <notes-dir>/NN.md (split by `--` the same way) and the
// label text of the hand-authored diagrams in content/diagrams/*.svg (labels, never sentences). Each finding prints as
//   content/sections/<file> <h>[.<v>] "<title>": <rule>: <detail>
// where h.v is the slide's reveal address (/deck#/h/v). Only headline slides (v = 0) carry a Clock cue, so the
// route and its clock never count a subslide: subslides are optional drill-downs below their headline slide. Any finding exits 1. The notes live outside this repo; without --notes-dir the
// note and route rules are skipped and say so. What a pattern cannot see (one claim per slide, the three-lens audit)
// stays with the reviewer and the rubric's checklist.
//
// Usage: node scripts/style-check.ts [--content <dir>] [--notes-dir <dir>] [--route]
//   --route   also print the headline route, one line per slide: address, clock, dwell, spoken words, title.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, cli, fenceLines, parseAttrs, slideAttrs, splitSubslides } from './lib/deck.ts';

const { values: flag } = cli('style-check', {
	content: { type: 'string', default: 'content' },
	'notes-dir': { type: 'string' },
	route: { type: 'boolean', default: false },
});
const contentDir = path.resolve(ROOT, flag.content);
const showRoute = flag.route;

// docs/style-rubric.md sections 3 and 4.
const LIMITS = {
	titleWords: 10,
	proseWords: 12, // the title plus paragraph text: a headline and one line
	slideWords: 25, // prose plus lists, captions and callouts; tables, code, math and diagrams excluded
	listItems: 4,
	itemWords: 6,
	cellWords: 12,
	captionWords: 25,
	equations: 1,
	evidenceTags: 1,
	sentenceWords: 18,
	wordsPerSecond: 2.5, // 150 words a minute: the spoken budget of a headline slide
	dwell: 240, // seconds on one headline slide
	liveDwell: 360, // a ::live slide changes on its own, and its note names each change
	route: [10, 14], // headline slides: about 12 for a 30-minute talk
	fragmentWords: 3, // 2.11: a comma-separated part this short, in a run of such parts, is a fragment
	talk: 30 * 60,
	labelWords: 10, // one text element of a hand-authored diagram: a label, never a sentence
};

// Section 2: banned words and phrases, matched case-insensitively as whole words outside code and math.
const BANNED = [
	['2.1 abstract noun', 'understanding|granularity|specificity|iterable|breadth|depth|enthusiastic|generosity'],
	['2.1 place-to-point motif', 'somewhere to|a place to'],
	[
		'2.5 inflated word',
		'tenets?|siloed|invites?|front-load(?:s|ed|ing)?|leverag(?:e|es|ed|ing)|robust(?:ly|ness)?|journeys?|landscapes?|meaningful(?:ly)?|seamless(?:ly)?|delve|crucial|pivotal|showcases?|empower(?:s|ed)?|tapestry|testament|realm|game-chang\\w*|cutting-edge|state of the art|world-class',
	],
	['2.5 self-praise', 'honest(?:ly|y)?|powerful(?:ly)?|vital'],
	['2.5 minimizer', 'simply|obviously|just'],
	[
		'2.7 emotional beat',
		'i love|amazing|extraordinary|beautiful(?:ly)?|elegant(?:ly)?|exciting|excited|magic(?:al)?|delightful',
	],
	['2.2 aphorism', 'the whole (?:job|talk|idea|point|story)|which is the point|pays for itself|as a story|still true'],
	['2.4 status caveat', 'prototype|experimental|shelved|unrun|not proven|not deployed|missed (?:the )?target'],
	[
		'2.6 empty transition',
		"let['’]s|moving on|next up|without further ado|as you can see|dive into|deep dive|turning to|with that,|now,",
	],
].map(([rule, alt]) => [rule, new RegExp(`(?<![\\w-])(?:${alt})(?![\\w-])`, 'i')] as const);

// Public safety: no tracker or ruling ids on a slide or in a note.
const IDS = /\b(?:TIN-\d+|LAB-[A-Z0-9-]{3,}|R-[A-Z]+\d+[a-z]?)\b/;

// Titles: imperative first words. Verbs that are rarely nouns always count; verbs that are also nouns
// ("Lease lifecycle") count only when a determiner, pronoun or preposition follows.
const VERBS = new Set(
	'give make let keep freeze take use see watch look think try meet ask read trust avoid prefer choose pick put send follow mind remember go bring get derive specify prove measure never always do dont'.split(
		' ',
	),
);
const NOUN_VERBS = new Set(
	'run scale push count commit start stop build lease report retry test check open show note change split sum fold drain'.split(
		' ',
	),
);
const OBJECTS = new Set(
	'it the a an this that these those them your every one on with to up down out back more less nothing something someone yourself all'.split(
		' ',
	),
);

type At = { where?: string; file?: string; h?: number; v?: number; title?: string };
type Finding = At & { rule: string };
const findings: Finding[] = [];
let slideCount = 0;
let subCount = 0;

// ─── Text helpers ─────────────────────────────────────────────────────────
const MATH_INLINE = /\$(?=[^\s$])[^$\n]*?[^\s\\$]\$|\$[^\s$]\$/g;

/** Prose view of one markdown line: code spans and inline math become one token each, markup goes. */
function prose(s: string) {
	return String(s)
		.replace(/\\\$/g, 'S')
		.replace(/`+[^`]*`+/g, ' C ')
		.replace(MATH_INLINE, ' M ')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&[a-z]+;/g, ' ')
		.replace(/\*\*|__/g, '')
		.replace(/(^|\s)[*_]|[*_](?=\s|$|[.,;:!?)])/g, '$1');
}
const countWords = (s: string) =>
	prose(s)
		.split(/\s+/)
		.filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
/** Text for the banned-word scan: code spans and math removed, so identifiers never trip it. */
const scanText = (s: string) =>
	String(s)
		.replace(/`+[^`]*`+/g, ' ')
		.replace(MATH_INLINE, ' ');
const norm = (s: string) =>
	prose(s)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/** A title as the deck index shows it: code and math delimiters dropped, the text kept. */
const display = (s: string) =>
	String(s)
		.replace(/`([^`]*)`/g, '$1')
		.replace(/\$([^$]*)\$/g, '$1')
		.replace(/\*+/g, '')
		.replace(/\s+/g, ' ')
		.trim();

/** Sentences of a note block; a split needs end punctuation, a space and a character that is not lower case. */
const sentences = (s: string) =>
	s
		.split(/(?<=[.!?])\s+(?=[^\p{Ll}])/u)
		.map((x) => x.trim())
		.filter((x) => countWords(x) > 0);

// ─── Deck structure (the same slide order as scripts/deck-build.ts) ───
const haveNotes = flag['notes-dir'] !== undefined;
const notesDir = path.resolve(ROOT, flag['notes-dir'] ?? '');
function readSlides() {
	const dir = path.join(contentDir, 'sections');
	const files = fs.readdirSync(dir).filter((f) => /^\d+-[\w-]+\.md$/.test(f)); // deck-build reports other names
	return files
		.sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
		.flatMap((file, h) => {
			const note = path.join(notesDir, `${file.split('-')[0]}.md`);
			const notes = splitSubslides(haveNotes && fs.existsSync(note) ? fs.readFileSync(note, 'utf8').split('\n') : []);
			const parts = splitSubslides(fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').split('\n'));
			return parts.map((lines, v) => ({ file, h, v, lines, note: notes[v] ?? [] }));
		});
}

/** One slide's body, split into the parts the rubric counts differently. */
type List = { items: { text: string; top: boolean }[] };
function parseBody(lines: string[]) {
	const out = {
		title: null as string | null,
		paragraphs: [] as string[],
		lists: [] as List[],
		cells: [] as string[],
		equations: 0,
		directives: [] as { name: string; attrs: Record<string, string> }[],
		raw: [] as string[],
	};
	const fenced = fenceLines(lines);
	let inMath = false;
	let list: List | null = null;
	for (const [i, line] of lines.entries()) {
		const t = line.trim();
		if (fenced.has(i)) {
			out.raw.push(line);
			list = null;
			continue;
		}
		if (inMath || t.startsWith('$$')) {
			if (!inMath) out.equations += 1;
			const opens: boolean = !inMath;
			inMath = !(t.endsWith('$$') && (t.length > 2 || !opens));
			out.raw.push(line);
			continue;
		}
		if (!t || /^<!--[\s\S]*-->$/.test(t)) {
			if (!t) list = null;
			continue;
		}
		const d = /^::([a-z]+)(?:\{(.*)\})?\s*$/.exec(t);
		if (d) {
			out.directives.push({ name: d[1], attrs: parseAttrs(d[2]) });
			list = null;
			continue;
		}
		out.raw.push(line);
		const h = /^#{1,6}\s+(.*)$/.exec(t);
		if (h) {
			if (out.title === null) out.title = h[1].trim();
			else out.paragraphs.push(h[1].trim());
			list = null;
			continue;
		}
		if (t.startsWith('|')) {
			if (!/^\|?[\s:|-]+\|?$/.test(t))
				for (const c of t.replace(/^\||\|$/g, '').split(/(?<!\\)\|/)) if (c.trim()) out.cells.push(c.trim());
			list = null;
			continue;
		}
		const li = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (li) {
			if (!list) out.lists.push((list = { items: [] }));
			list.items.push({ text: li[2], top: li[1].length < 2 });
			continue;
		}
		if (list && /^\s{2,}\S/.test(line)) list.items.at(-1)!.text += ` ${t}`;
		else out.paragraphs.push(t);
	}
	return out;
}

/** A note's blocks: list items (spoken, or "If asked" answers), the Clock cue, Source lines and instructions. */
function parseNote(lines: string[]) {
	const blocks: { kind: string; text: string }[] = [];
	let cur: (typeof blocks)[number] | null = null;
	for (const line of lines) {
		const t = line.trim();
		if (!t) {
			cur = null;
			continue;
		}
		const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (li) blocks.push((cur = { kind: 'item', text: li[1] }));
		else if (cur) cur.text += ` ${t}`;
		else blocks.push((cur = { kind: 'para', text: t }));
	}
	for (const b of blocks) {
		if (b.kind === 'item') b.kind = /^If asked\b/i.test(b.text) ? 'asked' : 'spoken';
		else if (/^Clock\s/.test(b.text)) b.kind = 'cue';
		else if (/^Sources?:/.test(b.text)) b.kind = 'source';
		else b.kind = 'instruction';
	}
	return blocks;
}

function titleFindings(title: string) {
	const out: string[] = [];
	const words = prose(title)
		.split(/\s+/)
		.filter((w) => /[\p{L}\p{N}]/u.test(w));
	const bare = scanText(title);
	const first = (words[0] ?? '').toLowerCase().replace(/[^a-z']/g, '');
	const second = (words[1] ?? '').toLowerCase().replace(/[^a-z]/g, '');
	if (words.length > LIMITS.titleWords) out.push(`title has ${words.length} words (> ${LIMITS.titleWords})`);
	if (/[.!]\s*$/.test(bare)) out.push('title ends in a period or an exclamation mark');
	if (/[.!?]\s+\S/.test(bare)) out.push('title holds more than one sentence');
	if (/\?\s*$/.test(bare)) out.push('title is a question');
	if (/;/.test(bare)) out.push('title joins two clauses with a semicolon (slogan)');
	if (/,\s*(?:not|never)\b/i.test(bare)) out.push('title is an "X, not Y" contrast (slogan)');
	if (/^\s*(?:why|how)\b/i.test(bare)) out.push('title is a rhetorical "why/how" (name the thing)');
	if (/\b(?:I|we|our|my)\b/.test(bare)) out.push('title speaks in the first person');
	if (/\b(?:is|are|was|were)\b/i.test(bare)) out.push('title is an "X is Y" assertion (name the thing)');
	if (VERBS.has(first.replace(/'/g, '')) || (NOUN_VERBS.has(first) && OBJECTS.has(second)))
		out.push(`title starts with an imperative ("${words[0]}")`);
	return out;
}

function bannedFindings(text: string, where: string) {
	const out: string[] = [];
	const s = scanText(text);
	for (const [rule, re] of BANNED) {
		const m = re.exec(s);
		if (m) out.push(`${rule}: "${m[0]}"${where ? ` in ${where}` : ''}`);
	}
	if (IDS.test(text)) out.push(`tracker or ruling id "${IDS.exec(text)![0]}"${where ? ` in ${where}` : ''}`);
	return out;
}

/** 2.11: two or more short parts strung with commas in place of a sentence ("One server, one hostname."). */
function fragmentChain(text: string) {
	const parts = prose(text)
		.replace(/[.!?]\s*$/, '')
		.split(/[,;]\s+/);
	return parts.length >= 2 && parts.every((p) => countWords(p) <= LIMITS.fragmentWords);
}
const fragmentFindings = (text: string, where: string) =>
	sentences(text)
		.filter(fragmentChain)
		.map((x) => `2.11 comma-strung fragments in ${where}: "${x.slice(0, 50)}"`);

const labelLeadIn = (t: string) => /^\*\*[^*]+?[.:]\*\*\s*\S/.test(t) || /^\*\*[^*]+\*\*\s*[:.]\s*\S/.test(t);
const parseClock = (m: string, s: string) => parseInt(m, 10) * 60 + parseInt(s, 10);
const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

// ─── Main pass ────────────────────────────────────────────────────────────
const route: (At & { start: number; end: number; live: boolean; spoken: number; spokenItems: number })[] = [];
const diagramsUsed = new Set<string>();
for (const slide of readSlides()) {
	const { h, v } = slide;
	const at = { file: slide.file, h, v, title: '', where: '' };
	slideCount += 1;
	if (v) subCount += 1;
	const report = (rule: string) => findings.push({ ...at, rule });
	const { attrs, lines } = slideAttrs(slide.lines);
	const titleSlide = parseAttrs(attrs)['data-state'] === 'title';
	const body = parseBody(lines);
	const note = parseNote(slide.note);
	at.title = body.title ? display(body.title) : '';

	// Titles (section 3: the title names the thing).
	if (!body.title) report('slide has no title');
	else for (const f of titleFindings(body.title)) report(f);

	// Body words (section 3: word limit, lists, captions, equations, evidence tags).
	const captions = [];
	for (const d of body.directives) {
		if (d.name === 'svg') diagramsUsed.add(d.attrs.src);
		if (d.name === 'live' && d.attrs.caption) captions.push(d.attrs.caption);
	}
	for (const c of captions) {
		const n = countWords(c);
		if (n > LIMITS.captionWords) report(`caption has ${n} words (> ${LIMITS.captionWords})`);
		for (const f of [...bannedFindings(c, 'caption'), ...fragmentFindings(c, 'caption')]) report(f);
	}
	const titleWords = body.title ? countWords(body.title) : 0;
	const paraWords = body.paragraphs.reduce((n, p) => n + countWords(p), 0);
	const listWords = body.lists.reduce((n, l) => n + l.items.reduce((m, it) => m + countWords(it.text), 0), 0);
	const captionWords = captions.reduce((n, c) => n + countWords(c), 0);
	if (!titleSlide && titleWords + paraWords > LIMITS.proseWords)
		report(`prose (title and paragraphs) has ${titleWords + paraWords} words (> ${LIMITS.proseWords})`);
	const total = titleWords + paraWords + listWords + captionWords;
	if (total > LIMITS.slideWords)
		report(`slide has ${total} words of prose, lists and captions (> ${LIMITS.slideWords})`);
	for (const l of body.lists) {
		const top = l.items.filter((it) => it.top).length;
		if (top > LIMITS.listItems) report(`list has ${top} items (> ${LIMITS.listItems})`);
		for (const it of l.items) {
			const n = countWords(it.text);
			if (n > LIMITS.itemWords) report(`list item has ${n} words (> ${LIMITS.itemWords}): "${it.text.slice(0, 60)}"`);
			if (labelLeadIn(it.text)) report(`2.2 label: assertion item: "${it.text.slice(0, 40)}"`);
		}
	}
	for (const p of body.paragraphs) if (labelLeadIn(p)) report(`2.2 label: assertion line: "${p.slice(0, 40)}"`);
	for (const c of body.cells) {
		const n = countWords(c);
		if (n > LIMITS.cellWords) report(`table cell has ${n} words (> ${LIMITS.cellWords}): "${c.slice(0, 60)}"`);
	}
	const prosed = [body.title ?? '', ...body.paragraphs, ...body.lists.flatMap((l) => l.items.map((i) => i.text))];
	for (const t of [...prosed, ...body.cells]) for (const f of bannedFindings(t, 'slide')) report(f);
	for (const t of prosed) for (const f of fragmentFindings(t, 'slide')) report(f);
	if (body.equations > LIMITS.equations)
		report(`${body.equations} display equations (> ${LIMITS.equations}); split the slide`);
	const tags = (scanText([...prosed, ...body.cells].join(' ')).match(/\((?:measured|rehearsal|design|model)\)/gi) ?? [])
		.length;
	if (tags > LIMITS.evidenceTags) report(`${tags} evidence tags (> ${LIMITS.evidenceTags})`);

	// Provenance (section 3: a number on screen has a recorded source).
	const sourced =
		body.directives.some(
			(d) =>
				d.name === 'src' ||
				(d.name === 'svg' && fs.existsSync(path.join(contentDir, 'diagrams', `${d.attrs.src}.provenance.json`))),
		) || note.some((b) => b.kind === 'source');
	if (/\d/.test(body.raw.join('\n')) && !sourced)
		report('a number on screen has no source: add ::src or a "Source:" line in the note');

	// Speaker notes (section 4).
	if (haveNotes && !note.length) report('slide has no speaker note');
	for (const b of note) {
		if (b.kind !== 'source' && b.kind !== 'cue')
			for (const f of [...bannedFindings(b.text, 'note'), ...fragmentFindings(b.text, 'note')]) report(f);
		else if (IDS.test(b.text)) report(`tracker or ruling id "${IDS.exec(b.text)![0]}" in note`);
		if (b.kind === 'source') continue;
		for (const s of sentences(b.text)) {
			const n = countWords(s);
			if (n > LIMITS.sentenceWords)
				report(`note sentence has ${n} words (> ${LIMITS.sentenceWords}): "${s.slice(0, 60)}"`);
		}
	}
	const spoken = note.filter((b) => b.kind === 'spoken');
	const firstSpoken = spoken.length ? sentences(spoken[0].text)[0] : null;
	if (firstSpoken && body.title && countWords(body.title) >= 2) {
		const a = norm(firstSpoken);
		const t = norm(body.title);
		if (a.startsWith(t) || t.startsWith(a)) report('2.8 the first spoken sentence restates the title');
	}
	const cue = note.find((b) => b.kind === 'cue');
	if (cue && v) report('a subslide is off the route: its note has no Clock cue');
	else if (cue) {
		const m = /^Clock (\d+):(\d{2}) to (\d+):(\d{2})\b/.exec(cue.text);
		if (!m) report('cue must read "Clock m:ss to m:ss."');
		else
			route.push({
				...at,
				start: parseClock(m[1], m[2]),
				end: parseClock(m[3], m[4]),
				live: body.directives.some((d) => d.name === 'live'),
				spoken: spoken.reduce((n, b) => n + countWords(b.text), 0),
				spokenItems: spoken.length,
			});
	}
}

// ─── Deck shape (section 4) ───────────────────────────────────────────────
let clock = 0;
for (const r of route) {
	const dwell = r.end - r.start;
	const cap = r.live ? LIMITS.liveDwell : LIMITS.dwell;
	if (r.start !== clock)
		findings.push({ ...r, rule: `clock starts at ${fmt(r.start)}, the route is at ${fmt(clock)}` });
	if (dwell <= 0) findings.push({ ...r, rule: `clock ${fmt(r.start)} to ${fmt(r.end)} has no dwell` });
	if (dwell > cap) findings.push({ ...r, rule: `dwell ${dwell} s (> ${cap} s without a screen change)` });
	if (!r.spokenItems) findings.push({ ...r, rule: 'headline slide has no spoken line (a "- " item in the note)' });
	const budget = Math.floor(dwell * LIMITS.wordsPerSecond);
	if (r.spoken > budget) findings.push({ ...r, rule: `${r.spoken} spoken words in ${dwell} s (> ${budget}, 150 wpm)` });
	clock = r.end;
}
if (route.length && clock > LIMITS.talk)
	findings.push({ ...route.at(-1), rule: `route ends at ${fmt(clock)} (> 30:00)` });
if (haveNotes && (route.length < LIMITS.route[0] || route.length > LIMITS.route[1]))
	findings.push({
		where: 'deck',
		rule: `${route.length} headline slides (want ${LIMITS.route[0]} to ${LIMITS.route[1]})`,
	});

// ─── Diagram labels (section 3: a diagram labels parts; its sentences belong in the note) ───
for (const name of [...diagramsUsed].sort()) {
	const file = path.join(contentDir, 'diagrams', `${name}.svg`);
	if (!fs.existsSync(file) || fs.existsSync(path.join(contentDir, 'diagrams', `${name}.provenance.json`))) continue;
	const where = `content/diagrams/${name}.svg`;
	for (const m of fs.readFileSync(file, 'utf8').matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)) {
		const label = m[1]
			.replace(/<[^>]+>/g, '')
			.replace(/&[a-z]+;/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		const n = countWords(label);
		if (/[.!?]$/.test(label) || n > LIMITS.labelWords)
			findings.push({
				where,
				rule: `label is a sentence (${n} words${/[.!?]$/.test(label) ? ', ends in a period' : ''}): "${label.slice(0, 60)}"`,
			});
		for (const f of bannedFindings(label, 'label')) findings.push({ where, rule: f });
	}
}

// ─── Report ───────────────────────────────────────────────────────────────
if (showRoute)
	for (const r of route)
		console.log(
			`route ${String(r.h).padStart(2)}  ${fmt(r.start).padStart(5)} to ${fmt(r.end).padStart(5)}  ${String(r.end - r.start).padStart(3)} s  ${String(r.spoken).padStart(3)} words  ${r.title}`,
		);
if (findings.length) {
	console.error(`style-check: ${findings.length} finding(s) against docs/style-rubric.md:`);
	for (const f of findings)
		console.error(
			`  ${f.where || `content/sections/${f.file} ${f.h}${f.v ? `.${f.v}` : ''}${f.title ? ` "${f.title}"` : ''}`}: ${f.rule}`,
		);
	process.exit(1);
}
const spokenTotal = route.reduce((n, r) => n + r.spoken, 0);
console.log(
	`style-check: ${slideCount} slides${subCount ? ` (${subCount} of them subslides)` : ''}, ${haveNotes ? `${route.length} on the headline route (0:00 to ${fmt(clock)}, ${spokenTotal} spoken words)` : 'no --notes-dir (note and route rules skipped)'}: ok`,
);
