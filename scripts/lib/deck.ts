// What scripts/deck-build.ts and scripts/style-check.ts share: the repository root, the flags, the `::name{k="v"}`
// attributes, the `<!-- .slide: -->` lines and the code-fence lines. Contract: docs/content-contract.md. Build-time only; never imported from src/.
import path from 'node:path';
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import MarkdownIt from 'markdown-it';

export const ROOT = path.resolve(import.meta.dirname, '../..');
const md = new MarkdownIt({ html: true });

/** The indexes of the lines of `lines` that belong to a code fence, its fence lines included, as markdown-it parses it. */
export function fenceLines(lines: string[]): Set<number> {
	const inside = new Set<number>();
	for (const t of md.parse(lines.join('\n'), {}))
		if (t.type === 'fence' && t.map) for (let i = t.map[0]; i < t.map[1]; i++) inside.add(i);
	return inside;
}

/** The command line under `options`. An unknown flag, a flag without its value or an extra positional exits 2. */
export function cli<T extends ParseArgsOptionsConfig>(name: string, options: T, positionals = 0) {
	try {
		const args = parseArgs({ options, strict: true, allowPositionals: true });
		if (args.positionals.length > positionals) throw new Error(`at most ${positionals} positional argument(s)`);
		return args;
	} catch (e) {
		console.error(`${name}: ${(e as Error).message}`);
		process.exit(2);
	}
}

export function parseAttrs(s = ''): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of s.matchAll(/([\w-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) out[m[1]] = m[2].replace(/\\(.)/g, '$1');
	return out;
}

/** A slide's lines without its `<!-- .slide: ... -->` lines, and the attributes those lines carry. */
export function slideAttrs(source: string[]): { attrs: string; lines: string[] } {
	let attrs = '';
	const lines = source.filter((l) => {
		const m = /^\s*<!--\s*\.slide:\s*([\s\S]*?)\s*-->\s*$/.exec(l);
		if (m) attrs += ` ${m[1]}`;
		return !m;
	});
	return { attrs: attrs.trim(), lines };
}

/**
 * A slide file's (or a notes file's) parts: a `--` line outside a code fence starts the next vertical subslide.
 * Part 0 is the headline slide; parts 1.. sit below it, one level deep.
 */
export function splitSubslides(source: string[]): string[][] {
	const parts: string[][] = [[]];
	const fenced = fenceLines(source);
	for (const [i, line] of source.entries()) {
		if (!fenced.has(i) && line.trim() === '--') parts.push([]);
		else parts.at(-1)!.push(line);
	}
	return parts;
}
