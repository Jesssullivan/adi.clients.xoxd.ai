#!/usr/bin/env node
// `just notes-gate`: fail if speaker-note text reached a static file under the
// build directory. /presenter fetches its notes from /presenter/notes.json,
// which the overlay server serves from outside the static root under the
// owner-only Access path; everything under build/ is a static asset any
// signed-in guest can fetch, so no note may appear there.
//
// Probes: every run of 24 or more plain characters in a note's HTML (text
// between tags, entities, newlines and characters a JS or JSON string might
// escape) that does not also occur in the public slide HTML. Every note must
// yield at least one probe, or the gate cannot see that note and fails.
// Scanned: every file under the build directory, with .gz and .br files
// decompressed; text inside a PDF's compressed streams is not inflated.
// Also fails on an `<aside class="notes">` marker in any file, and on any
// class="notes" (in any quoting) in a build/_app chunk. With no notes (a
// deck built without --notes-dir) only these marker checks run.
//
// Usage: node scripts/notes-gate.ts [build_dir] [--notes <notes.json>]
//        [--public <deck-public.ts>]
// Exit: 0 clean; 1 findings; 2 bad input (missing build dir or inputs, or a
// note with no probe).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT, cli } from './lib/deck.ts';

const MIN_PROBE = 24;

const { values: opt, positionals } = cli(
	'notes-gate',
	{
		notes: { type: 'string', default: 'overlay/notes.json' },
		public: { type: 'string', default: 'src/lib/generated/deck-public.ts' },
	},
	1, // the build directory
);
const buildDir = path.resolve(process.cwd(), positionals[0] ?? 'build');
function bad(msg: string): never {
	console.error(`notes-gate: ${msg}`);
	process.exit(2);
}
if (!fs.existsSync(buildDir) || !fs.statSync(buildDir).isDirectory())
	bad(`${buildDir} is not a directory; run \`just build\``);

let notes: Record<string, string> | undefined;
let publicHtml: string | undefined;
try {
	notes = JSON.parse(fs.readFileSync(path.resolve(ROOT, opt.notes), 'utf8')).notes;
	const m = /^export const DECK_HTML: string = (".*");$/m.exec(fs.readFileSync(path.resolve(ROOT, opt.public), 'utf8'));
	publicHtml = m ? JSON.parse(m[1]) : null;
} catch (err) {
	bad(`cannot read the notes or the public deck: ${(err as Error).message}; run \`just deck\``);
}
if (!notes || typeof notes !== 'object') bad(`no notes object in ${opt.notes}`);
if (typeof publicHtml !== 'string') bad(`no DECK_HTML in ${opt.public}`);

const probes: { slide: string; text: string }[] = [];
const unprobed: string[] = [];
for (const [slide, html] of Object.entries(notes)) {
	const runs = String(html)
		.replace(/<annotation[\s\S]*?<\/annotation>/g, ' ')
		.split(/<[^>]*>|&[#\w]+;|[^\x20-\x7e]|["'`\\$<>&]|\s{2,}/);
	const mine = [...new Set(runs.map((r) => r.trim()).filter((r) => r.length >= MIN_PROBE && !publicHtml.includes(r)))];
	if (!mine.length) unprobed.push(slide);
	for (const text of mine) probes.push({ slide, text });
}
if (unprobed.length)
	bad(`note(s) ${unprobed.join(', ')} have no run of ${MIN_PROBE}+ plain characters absent from the public deck`);

const walk = (dir: string): string[] =>
	fs
		.readdirSync(dir, { withFileTypes: true })
		.flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const ASIDE = /<aside class=\\?["']notes\\?["']/;
const NOTES_CLASS = /class=\\?["']notes\\?["']/;
const findings: string[] = [];
let scanned = 0;
for (const file of walk(buildDir)) {
	const rel = path.relative(buildDir, file);
	let buf: Buffer = fs.readFileSync(file);
	try {
		if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
		else if (file.endsWith('.br')) buf = zlib.brotliDecompressSync(buf);
	} catch (err) {
		findings.push(`${rel}: cannot decompress (${(err as Error).message})`);
		continue;
	}
	const text = buf.toString('utf8');
	scanned++;
	const hits = probes.filter((p) => text.includes(p.text));
	if (hits.length) {
		const slides = [...new Set(hits.map((h) => h.slide))];
		const shown = slides.slice(0, 6).join(', ') + (slides.length > 6 ? ` and ${slides.length - 6} more` : '');
		findings.push(`${rel}: ${hits.length} probe(s) from the notes of slides ${shown}; first: "${hits[0].text}"`);
	}
	if (ASIDE.test(text)) findings.push(`${rel}: contains an <aside class="notes"> marker`);
	else if (rel.split(path.sep)[0] === '_app' && NOTES_CLASS.test(text))
		findings.push(`${rel}: _app chunk contains class="notes"`);
}
if (!scanned) bad(`${buildDir} has no files`);
if (findings.length) {
	console.error(`notes-gate: speaker notes reached ${path.relative(process.cwd(), buildDir) || buildDir}:`);
	for (const f of findings) console.error(`  - ${f}`);
	process.exit(1);
}
console.log(
	`notes-gate: ${Object.keys(notes).length} notes, ${probes.length} probes, ${scanned} files under ${path.relative(process.cwd(), buildDir) || buildDir}: no note text`,
);
