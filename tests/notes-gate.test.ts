// Offline tests for scripts/notes-gate.ts: a speaker note in any static file
// under the build directory, compressed or not, fails the gate.
// No network.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import zlib from 'node:zlib';
import { ROOT } from '../scripts/lib/deck.ts';

const SCRIPT = path.join(ROOT, 'scripts/notes-gate.ts');
const NOTE = 'Only the presenter reads this fixture sentence aloud.';
const SHARED = 'This sentence is on the slide and in its note.';

function fixture(
	files: Record<string, string | Buffer>,
	notesBySlide: Record<string, string> = { '0.0': `<p>${NOTE}</p>\n<p>${SHARED}</p>` },
) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-gate-'));
	const notes = path.join(dir, 'notes.json');
	const pub = path.join(dir, 'deck-public.ts');
	fs.writeFileSync(notes, JSON.stringify({ deck: '0', notes: notesBySlide }));
	fs.writeFileSync(pub, `export const DECK_HTML: string = ${JSON.stringify(`<section><p>${SHARED}</p></section>`)};\n`);
	const build = path.join(dir, 'build');
	for (const [rel, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(build, rel)), { recursive: true });
		fs.writeFileSync(path.join(build, rel), body);
	}
	return spawnSync(process.execPath, [SCRIPT, build, '--notes', notes, '--public', pub], { encoding: 'utf8' });
}

test('clean build passes; text shared with the public slide is not a probe', () => {
	const r = fixture({ 'deck.html': `<p>${SHARED}</p>`, '_app/immutable/nodes/1.js': 'export {}' });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /1 notes, 1 probes, 2 files/);
});

test('note text in a page, in a JS string and in compressed copies fails', () => {
	const js = `const h=${JSON.stringify(`<p>${NOTE}</p>`)};`;
	for (const [rel, body] of [
		['presenter.html', `<p>${NOTE}</p>`],
		['_app/immutable/nodes/5.js', js],
		['presenter.html.gz', zlib.gzipSync(`<p>${NOTE}</p>`)],
		['_app/immutable/nodes/5.js.br', zlib.brotliCompressSync(js)],
	] as const) {
		const r = fixture({ [rel]: body });
		assert.equal(r.status, 1, `${rel}: ${r.stdout}`);
		assert.match(r.stderr, new RegExp(rel.replace(/\./g, '\\.')));
	}
});

test('a notes marker fails anywhere, class="notes" fails in _app', () => {
	assert.equal(fixture({ 'x.html': '<aside class="notes"></aside>' }).status, 1);
	assert.equal(fixture({ '_app/a.js': 'x.innerHTML=\'<i class="notes">\'' }).status, 1);
	assert.equal(fixture({ '_app/b.js': 'n.className="notes"' }).status, 0);
});

test('with no notes the marker checks still run', () => {
	const r = fixture({ 'deck.html': `<p>${SHARED}</p>` }, {});
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /0 notes, 0 probes, 1 files/);
	assert.equal(fixture({ 'x.html': '<aside class="notes"></aside>' }, {}).status, 1);
});

test('an unknown flag and a second build directory are bad input', () => {
	for (const argv of [
		['--note', 'x'],
		['build', 'build2'],
	])
		assert.equal(spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' }).status, 2, argv.join(' '));
});

test('a missing build directory is bad input', () => {
	const r = spawnSync(process.execPath, [SCRIPT, path.join(os.tmpdir(), 'no-such-build-dir-notes-gate')], {
		encoding: 'utf8',
	});
	assert.equal(r.status, 2);
});
