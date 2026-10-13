// Offline tests for scripts/style-check.ts (docs/style-rubric.md): a clean generated deck passes, and
// each rule fails on a deck that breaks only that rule. No network.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterAll, test } from 'vitest';
import { ROOT } from '../scripts/lib/deck.ts';

const SCRIPT = path.join(ROOT, 'scripts/style-check.ts');
const NAMES = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'.split(' ');
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const made: string[] = [];
afterAll(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** One slide: its markdown and its note (null: no notes file). */
const slide = (body: string, note: string | null) => ({ body, note });
/** One route slide of `dwell` seconds starting at `at`, clean against every rule. */
const routeSlide = (name: string, at: number, dwell = 30) =>
	slide(
		`## Fixture slide ${name}\n`,
		`Clock ${clock(at)} to ${clock(at + dwell)}.\n\n- The ${name} line adds a fact the slide lacks.\n`,
	);
/** A slide off the route (no Clock cue) with a clean note, wrapping `body`. */
const sub = (body: string, note = '- A spoken line that adds a fact.\n\nSource: fixture.') => slide(body, note);

type Deck = {
	extra?: ReturnType<typeof slide>[];
	route?: number;
	diagrams?: Record<string, string>;
};
/** `route` clean route slides, then the `extra` slides, one sections/NN-*.md and notes/NN.md each. */
function writeDeck({ extra = [], route = 12, diagrams = {} }: Deck = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-fixture-'));
	made.push(dir);
	for (const d of ['sections', 'notes', 'diagrams']) fs.mkdirSync(path.join(dir, d));
	const slides = [...Array.from({ length: route }, (_, i) => routeSlide(NAMES[i], i * 30)), ...extra];
	slides.forEach((s, i) => {
		const nn = String(i).padStart(2, '0');
		fs.writeFileSync(path.join(dir, 'sections', `${nn}-${i < route ? NAMES[i] : 'extra'}.md`), s.body);
		if (s.note !== null) fs.writeFileSync(path.join(dir, 'notes', `${nn}.md`), s.note);
	});
	for (const [name, svg] of Object.entries(diagrams)) fs.writeFileSync(path.join(dir, 'diagrams', `${name}.svg`), svg);
	return dir;
}

function check(opts: Deck, edit = (_dir: string) => {}) {
	const dir = writeDeck(opts);
	edit(dir);
	const notes = fs.existsSync(path.join(dir, 'notes')) ? ['--notes-dir', path.join(dir, 'notes')] : [];
	const r = spawnSync(process.execPath, [SCRIPT, '--content', dir, ...notes], { encoding: 'utf8' });
	return { status: r.status, out: r.stdout + r.stderr };
}

test('a clean deck passes and reports its route', () => {
	const r = check({ extra: [sub('## Clean sub-slide\n\n::src{ref="https://example.org/" label="a source"}')] });
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /13 slides, 12 on the headline route \(0:00 to 6:00/);
});

test('without --notes-dir the note and route rules are skipped', () => {
	const r = check({ extra: [slide('## Clean title\n', null)] }, (dir) =>
		fs.rmSync(path.join(dir, 'notes'), { recursive: true }),
	);
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /13 slides, no --notes-dir \(note and route rules skipped\)/);
});

const FAILS: [string, ReturnType<typeof slide>, RegExp][] = [
	['a banned word in a title', sub('## Robust retries for every sender'), /2\.5 inflated word: "Robust"/],
	['self-praise in a note', sub('## Clean title', '- An honest count of every chunk.'), /2\.5 self-praise: "honest"/],
	['an empty transition', sub('## Clean title', "- Let's look at the ledger now."), /2\.6 empty transition/],
	['a minimizer', sub('## Clean title', '- The sender simply retries.'), /2\.5 minimizer: "simply"/],
	[
		'"just" as a minimizer',
		sub('## Clean title', '- It just retries; `just check` is fine.'),
		/2\.5 minimizer: "just"/,
	],
	['comma-strung fragments', sub('## Clean title', '- One server, one hostname.'), /2\.11 comma-strung fragments/],
	['a fragment title', sub('## Pure fate, exact totals'), /2\.11 comma-strung fragments in slide/],
	['a title ending in a period', sub('## The ledger commits once.'), /title ends in a period/],
	['an imperative title', sub('## Run it yourself'), /title starts with an imperative \("Run"\)/],
	['an "X, not Y" title', sub('## Backlog, not CPU utilisation'), /"X, not Y" contrast/],
	['a semicolon title', sub('## Graham bounds makespan; queue bounds memory'), /semicolon \(slogan\)/],
	['an "X is Y" title', sub('## Fate is pure'), /"X is Y" assertion/],
	['a first-person title', sub('## Where I commit to one reading'), /first person/],
	[
		'prose over 12 words',
		sub('## Clean title\n\nEvery sender sleeps through each attempt and then commits its finished chunk.'),
		/prose \(title and paragraphs\) has 14 words/,
	],
	['a list over 4 items', sub('## Clean title\n\n- one\n- two\n- three\n- four\n- five'), /list has 5 items/],
	['a list item over 6 words', sub('## Clean title\n\n- one two three four five six seven'), /list item has 7 words/],
	['a label: assertion lead-in', sub('## Clean title\n\n- **Is:** a typed language'), /2\.2 label: assertion item/],
	[
		'a long table cell',
		sub(
			'## Clean title\n\n| a | b |\n|---|---|\n| short | one two three four five six seven eight nine ten eleven twelve thirteen |',
		),
		/table cell has 13 words/,
	],
	[
		'a long caption',
		sub(`## Clean title\n\n::live{src="/x" title="t" caption="${'word '.repeat(26).trim()}"}`),
		/caption has 26 words/,
	],
	['two display equations', sub('## Clean title\n\n$$\na = b\n$$\n\n$$\nc = d\n$$'), /2 display equations/],
	['two evidence tags', sub('## Throughput sweep (rehearsal)\n\nA count (measured) here.'), /2 evidence tags/],
	[
		'a number with no source',
		slide('## Throughput at four pods\n\n| a | b |\n|---|---|\n| 89 | 112 |\n', '- A spoken line that adds a fact.\n'),
		/a number on screen has no source/,
	],
	['a slide with no note', slide('## Clean title\n', null), /slide has no speaker note/],
	[
		'a long spoken sentence',
		sub(
			'## Clean title',
			'- One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen.',
		),
		/note sentence has 19 words/,
	],
	[
		'a first spoken sentence that restates the title',
		sub('## The ledger machine', '- The ledger machine checks every move.'),
		/2\.8 the first spoken sentence restates the title/,
	],
	[
		'a tracker id in a note',
		sub('## Clean title', '- Tracked as TIN-1234 for later.'),
		/tracker or ruling id "TIN-1234"/,
	],
];
for (const [what, slide, rule] of FAILS) {
	test(`fails on ${what}, naming the slide`, () => {
		const r = check({ extra: [slide] });
		assert.equal(r.status, 1, r.out);
		assert.match(r.out, rule);
		assert.match(r.out, /content\/sections\/12-extra\.md 12/);
	});
}

test('the route: dwell, contiguity, length and spoken budget', () => {
	const longDwell = check({ extra: [routeSlide('long', 360, 300)] });
	assert.match(longDwell.out, /dwell 300 s \(> 240 s/);
	const gap = check({ extra: [routeSlide('late', 420)] });
	assert.match(gap.out, /clock starts at 7:00, the route is at 6:00/);
	const short = check({ route: 8 });
	assert.match(short.out, /8 headline slides \(want 10 to 14/);
	const chatty = check({
		extra: [
			slide(
				'## Clean title\n',
				`Clock 6:00 to 6:10.\n\n- ${'word '.repeat(17).trim()}.\n- ${'word '.repeat(17).trim()}.\n`,
			),
		],
	});
	assert.match(chatty.out, /34 spoken words in 10 s \(> 25, 150 wpm\)/);
	for (const r of [longDwell, gap, short, chatty]) assert.equal(r.status, 1, r.out);
});

test('a `--` subslide stays off the route and keeps every slide rule', () => {
	const below = (note: string) =>
		routeSlide('mike', 360).body +
		'\n--\n\n## Fixture drill-down\n\n::src{ref="https://example.org/" label="a source"}\n';
	const head = routeSlide('mike', 360).note!;
	const ok = check({ extra: [slide(below(''), `${head}\n--\n\n- A spoken line that adds a fact.\n`)] });
	assert.equal(ok.status, 0, ok.out);
	assert.match(ok.out, /14 slides \(1 of them subslides\), 13 on the headline route \(0:00 to 6:30/);
	const cued = check({
		extra: [slide(below(''), `${head}\n--\n\nClock 6:30 to 7:00.\n\n- A spoken line that adds a fact.\n`)],
	});
	assert.match(cued.out, /12-extra\.md 12\.1 "Fixture drill-down": a subslide is off the route/);
	const silent = check({ extra: [slide(below(''), head)] });
	assert.match(silent.out, /12\.1 "Fixture drill-down": slide has no speaker note/);
	for (const r of [cued, silent]) assert.equal(r.status, 1, r.out);
});

test('diagram labels are checked', () => {
	const svg = '<svg viewBox="0 0 10 10"><text>queue</text><text>The loop never blocks on a sender.</text></svg>';
	const diagram = check({ extra: [sub('## Clean title\n\n::svg{src="01-box"}')], diagrams: { '01-box': svg } });
	assert.equal(diagram.status, 1, diagram.out);
	assert.match(diagram.out, /content\/diagrams\/01-box\.svg: label is a sentence \(7 words, ends in a period\)/);
	assert.doesNotMatch(diagram.out, /"queue"/);
});
