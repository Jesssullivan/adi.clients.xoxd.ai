// Offline tests for scripts/deck-build.ts against tests/fixtures/deck and the notes in tests/fixtures/notes (no network).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ROOT } from '../scripts/lib/deck.ts';

const FIXTURE = path.join(ROOT, 'tests/fixtures/deck');
const NOTES = path.join(ROOT, 'tests/fixtures/notes');
const SCRIPT = path.join(ROOT, 'scripts/deck-build.ts');

function build(contentDir: string, notesDir: string | null = copy('deck-notes-dir-', NOTES)) {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-out-'));
	const stat = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-static-'));
	const notesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-notes-')), 'notes.json');
	const r = spawnSync(
		process.execPath,
		[
			SCRIPT,
			...['--content', contentDir, '--out', out, '--static', stat, '--notes', notesFile],
			...(notesDir === null ? [] : ['--notes-dir', notesDir]),
		],
		{ encoding: 'utf8' },
	);
	const read = (f: string) => fs.readFileSync(path.join(out, f), 'utf8');
	const notes = () => JSON.parse(fs.readFileSync(notesFile, 'utf8'));
	return { r, out, stat, read, notes };
}
const deckHtml = (ts: string) => JSON.parse(ts.match(/^export const DECK_HTML: string = (".*");$/m)![1]);
function copy(prefix: string, from = FIXTURE) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	execFileSync('cp', ['-R', `${from}/.`, tmp]);
	return tmp;
}

test('fixture builds: notes come from <notes-dir>/NN.md and reach only the notes file', () => {
	const { r, out, read, notes } = build(FIXTURE);
	assert.equal(r.status, 0, r.stderr);
	const pub = read('deck-public.ts');
	assert.ok(!pub.includes('Presenter-only fixture note'));
	assert.ok(!pub.includes('class=\\"notes\\"'));
	assert.ok(!fs.existsSync(path.join(out, 'deck-presenter.ts')), 'no notes-bearing page module');
	const payload = notes();
	assert.equal(payload.deck, pub.match(/^export const DECK_ID: string = "([0-9a-f]{16})";$/m)![1]);
	assert.deepEqual(Object.keys(payload.notes), ['0.0']);
	assert.match(payload.notes['0.0'], /Presenter-only fixture note/);
	assert.match(deckHtml(pub), /data-h="0" data-v="0"/);
});

test('without --notes-dir the deck builds with no notes', () => {
	const { r, notes } = build(FIXTURE, null);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(notes().notes, {});
});

test('a notes directory in content/, or a --notes-dir that is missing, empty or inside the repo fails the build', () => {
	const tmp = copy('deck-stale-notes-');
	execFileSync('cp', ['-R', NOTES, path.join(tmp, 'notes')]);
	const stale = build(tmp, null);
	assert.notEqual(stale.r.status, 0);
	assert.match(stale.r.stderr, /notes\/: notes live outside this repo/);
	const missing = build(FIXTURE, path.join(tmp, 'no-such-dir'));
	assert.match(missing.r.stderr, /--notes-dir: .*no-such-dir is not a directory/);
	const empty = build(FIXTURE, fs.mkdtempSync(path.join(os.tmpdir(), 'deck-empty-notes-')));
	assert.match(empty.r.stderr, /--notes-dir: no NN\.md notes in /);
	assert.match(build(FIXTURE, NOTES).r.stderr, /--notes-dir: .*fixtures\/notes is inside this repo/);
}, 60_000);

test('a Note: line in a slide or a notes file without its slide fails the build', () => {
	const tmp = copy('deck-bad-notes-');
	const notesDir = copy('deck-bad-notes-dir-', NOTES);
	fs.appendFileSync(path.join(tmp, 'sections/02-live.md'), '\nNote:\nA note in the slide.\n');
	fs.writeFileSync(path.join(notesDir, '07.md'), 'An orphan note.\n');
	const { r } = build(tmp, notesDir);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /02-live\.md slide 2: speaker notes go in the notes directory/);
	assert.match(r.stderr, /notes\/07\.md: no content\/sections\/07-\*\.md/);
});

test('math, directives and fences render, one slide per file', () => {
	const { read } = build(FIXTURE);
	const pub = deckHtml(read('deck-public.ts'));
	assert.match(pub, /class="katex"/);
	assert.match(pub, /class="katex-display"/);
	assert.match(pub, /costs \$5 and \$10 stay text/);
	assert.match(pub, /<code>\$a\$<\/code> and <a href="https:\/\/example.com\/\$b\$"/);
	assert.match(pub, /class="src-chip"/);
	assert.match(pub, /<pre class="shiki/);
	assert.match(pub, /<svg class="diagram" data-diagram="01-box"/);
	assert.match(
		pub,
		/<div class="deck-video" data-video="fixture video" hidden><\/div>/,
		'::video is an id-free hidden slot',
	);
	assert.match(pub, /data-state="dense"/);
	assert.equal((pub.match(/<section [^>]*data-v=/g) ?? []).length, 3);
});

test('a `--` line starts a vertical subslide, and the notes split the same way', () => {
	const tmp = copy('deck-sub-');
	const notesDir = copy('deck-sub-notes-', NOTES);
	fs.appendFileSync(path.join(tmp, 'sections/00-title.md'), '\n--\n\n## Below\n\n````text\n```\n--\n````\n');
	fs.appendFileSync(path.join(notesDir, '00.md'), '\n--\n\nSubslide fixture note.\n');
	const { r, read, notes } = build(tmp, notesDir);
	assert.equal(r.status, 0, r.stderr);
	const pub = deckHtml(read('deck-public.ts'));
	assert.match(
		pub,
		/data-h="0" data-v="0">[\s\S]*?<\/section><section data-slug="00-title" data-h="0" data-v="1"><h2>Below/,
	);
	assert.equal((pub.match(/<section class="stack"/g) ?? []).length, 3, 'still one column per file');
	assert.equal((pub.match(/<section [^>]*data-v=/g) ?? []).length, 4);
	assert.deepEqual(Object.keys(notes().notes), ['0.0', '0.1']);
	assert.match(notes().notes['0.1'], /Subslide fixture note/);
	fs.appendFileSync(path.join(notesDir, '00.md'), '\n--\n\nA note without a slide.\n');
	const extra = build(tmp, notesDir);
	assert.notEqual(extra.r.status, 0);
	assert.match(extra.r.stderr, /notes\/00\.md: 3 parts for the 2 slides of 00-title\.md/);
});

test('::live renders a lazy iframe, and a title and link line for print/PDF', () => {
	const { r, read } = build(FIXTURE);
	assert.equal(r.status, 0, r.stderr);
	const pub = deckHtml(read('deck-public.ts'));
	assert.match(
		pub,
		/<figure class="deck-live"><iframe class="deck-live__frame" data-src="\/resume\?embed=1" data-preload title="fixture live" style="height:480px"/,
	);
	// reveal sets src from iframe[data-src] near the slide and keeps it there; a plain src would load at page load.
	assert.doesNotMatch(pub, /class="deck-live__frame" src=/);
	assert.match(
		pub,
		/<p class="deck-live__print">fixture live · <a href="https:\/\/adi\.clients\.xoxd\.ai\/resume\?embed=1">https:\/\/adi\.clients\.xoxd\.ai\/resume\?embed=1<\/a><\/p>/,
	);
	assert.doesNotMatch(pub, /deck-live__toggle|<img/);
});

test('::live rejects unsafe src, a missing title and any attribute but src, title, height and caption', () => {
	const tmp = copy('deck-live-');
	const bad = [
		'# Bad live',
		'::live{src="javascript:alert(1)" title="t"}',
		'::live{src="//evil.example/x" title="t"}',
		// parseAttrs unescapes `\\` to one backslash: the attribute value is `/\evil.example/x`.
		'::live{src="/\\\\evil.example/x" title="t"}',
		'::live{src="http://plain.example/" title="t"}',
		'::live{src="/demo?embed=1"}',
		'::live{src="/demo?embed=1" title="old shot" fallback="live.png"}',
		'::live{src="/demo?embed=1" title="old text" fallback-text="f" provenance="p"}',
	].join('\n\n');
	fs.writeFileSync(path.join(tmp, 'sections/03-bad-live.md'), `${bad}\n`);
	const { r } = build(tmp);
	assert.notEqual(r.status, 0);
	for (const src of ['javascript:alert(1)', '//evil.example/x', '/\\evil.example/x', 'http://plain.example/'])
		assert.ok(
			r.stderr.includes(`::live src must be a /path on this site or an https URL, got ${JSON.stringify(src)}`),
			src,
		);
	assert.match(r.stderr, /::live needs title=/);
	assert.match(r.stderr, /::live takes only src, title, height, caption; remove fallback\n/);
	assert.match(r.stderr, /::live takes only src, title, height, caption; remove fallback-text, provenance/);
});

test('a mistyped flag, a flag without its value and an extra positional are bad input', () => {
	for (const argv of [['--chek'], ['--out'], ['--out', '--check'], ['stray']]) {
		const r = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' });
		assert.equal(r.status, 2, argv.join(' '));
		assert.match(r.stderr, /^deck-build: /);
	}
});

test('an unknown directive fails the build', () => {
	const tmp = copy('deck-bad-');
	fs.writeFileSync(path.join(tmp, 'sections/03-bad.md'), '# Bad\n\n::bogus\n');
	const { r } = build(tmp);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /unknown directive ::bogus/);
});
