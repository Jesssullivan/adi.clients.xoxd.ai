#!/usr/bin/env node
// `just docs <ref> <ports-ref>`: copy the core's docs/ shards (*.svx) and the images they link (*.svg) at one commit into
// content/docs/, and record that commit in content/docs/source.json. The site renders content/docs/ at build time
// (src/lib/server/docs.ts), so a build never reaches the network. Copy the ports' bench chart at one commit to
// content/media/10-bench.svg, record that commit and its sha256 in the sidecar `just deck` checks, and point every
// adi-sms-ports link in content/sections/ at that commit.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, cli } from './lib/deck.ts';

const repo = 'Jesssullivan/adi-sms';
const gh = (url: string, raw = false) =>
	execFileSync('gh', ['api', ...(raw ? ['-H', 'Accept: application/vnd.github.raw'] : []), url], {
		encoding: 'utf8',
		maxBuffer: 64 << 20,
	});
const sha = (r: string, at = 'main') => JSON.parse(gh(`repos/${r}/commits/${at}`)).sha as string;
const [coreRef, portsRef] = cli('docs-sync', {}, 2).positionals;
const ref = sha(repo, coreRef);
const names = (JSON.parse(gh(`repos/${repo}/contents/docs?ref=${ref}`)) as { name: string }[])
	.map((f) => f.name)
	.filter((n) => /^\d+-[\w-]+\.svx$|\.svg$/.test(n));
if (!names.some((n) => n.endsWith('.svx'))) throw new Error(`${repo}@${ref} has no docs/NN-slug.svx`);
const dir = path.join(ROOT, 'content/docs');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir);
for (const n of names) fs.writeFileSync(path.join(dir, n), gh(`repos/${repo}/contents/docs/${n}?ref=${ref}`, true));
fs.writeFileSync(path.join(dir, 'source.json'), `{ "repo": "${repo}", "ref": "${ref}" }\n`);
console.log(`content/docs: ${names.join(', ')} from ${repo}@${ref}`);

const ports = 'Jesssullivan/adi-sms-ports';
const pref = sha(ports, portsRef);
const chart = gh(`repos/${ports}/contents/bench/chart.svg?ref=${pref}`, true);
const sha256 = createHash('sha256').update(chart).digest('hex');
fs.writeFileSync(path.join(ROOT, 'content/media/10-bench.svg'), chart);
const side = { file: 'content/media/10-bench.svg', repo: ports, sha: pref, path: 'bench/chart.svg', sha256 };
fs.writeFileSync(path.join(ROOT, 'content/media/10-bench.provenance.json'), JSON.stringify(side, null, '\t') + '\n');
for (const f of fs.globSync(path.join(ROOT, 'content/sections/*.md')))
	fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/(adi-sms-ports\/(?:tree|blob)\/)[0-9a-f]{40}/g, `$1${pref}`));
console.log(`content/media/10-bench.svg: bench/chart.svg from ${ports}@${pref}`);
