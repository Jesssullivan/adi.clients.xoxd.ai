/**
 * Leak scanner for everything this repository publishes: no secrets, private
 * endpoints, internal hostnames, kubeconfig fragments or developer paths in the
 * built output.
 *
 * `scripts/check-build-output.ts` (`just leak-scan`) and
 * `tests/leak-scan.test.ts` import this one module. The pattern rules are
 * gitleaks' default rules (`.gitleaks.toml`) and the ones in `leak-scan.toml`,
 * and gitleaks runs them. Two positive checks stay here, because gitleaks has no allowlist of
 * what may appear: every outbound host and every mailbox in the output must be
 * on a reviewed list. So does the walk that refuses a file type it cannot read.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from './deck.ts';

type Text = { file: string; text: string };
type LeakFinding = { file: string; ruleId: string; description: string; line: number };
/** allowedHosts defaults to ALLOWED_HOSTS plus the hosts content/ cites. */
type ScanOptions = { allowedHosts?: string[]; allowedMailboxes?: string[] };

const CONFIGS = [path.join(ROOT, '.gitleaks.toml'), path.join(import.meta.dirname, 'leak-scan.toml')];
const lists = JSON.parse(readFileSync(path.join(import.meta.dirname, 'leak-scan-rules.json'), 'utf8'));

export const ALLOWED_HOSTS: string[] = lists.allowedHosts;
export const ALLOWED_MAILBOXES: string[] = lists.allowedMailboxes;

/** Hosts cited by the reviewed deck sources (content/sections). */
export function deckContentHosts(root = ROOT) {
	const hosts = new Set<string>();
	const dir = path.join(root, 'content/sections');
	for (const f of readdirSync(dir)) {
		const text = readFileSync(path.join(dir, f), 'utf8');
		for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/giu)) hosts.add(m[1].toLowerCase());
	}
	return [...hosts].sort();
}

const DEFAULT_HOSTS = [...new Set([...ALLOWED_HOSTS, ...deckContentHosts()])];

/** Extensions whose bytes are scanned as UTF-8 text; `''` covers extensionless files such as `_headers`. */
export const TEXT_EXTENSIONS = new Set([
	'.html',
	'.js',
	'.mjs',
	'.css',
	'.json',
	'.svg',
	'.txt',
	'.xml',
	'.map',
	'.md',
	'',
]);

/** Extensions that are knowingly opaque to a text scanner. */
export const SKIP_EXTENSIONS = new Set([
	'.br',
	'.gz',
	'.woff',
	'.woff2',
	'.ttf',
	'.jpg',
	'.jpeg',
	'.png',
	'.webp',
	'.avif',
	'.ico',
	'.pdf',
]);

const URL_RE = /\bhttps?:\/\/([a-z0-9.-]+)/giu;
const MAILBOX_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/giu;

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/**
 * gitleaks over `texts`, once per config. Each text is staged as `<n>.txt`: gitleaks' default allowlist skips paths
 * such as `.svg`, and a published SVG is text this gate must read. A gitleaks that does not run is an error, never a pass.
 */
function gitleaks(texts: Text[]): LeakFinding[] {
	const stage = mkdtempSync(path.join(tmpdir(), 'leak-scan-'));
	try {
		texts.forEach((t, i) => writeFileSync(path.join(stage, `${i}.txt`), t.text));
		const flags = ['--no-banner', '--redact', '--log-level', 'error', '--report-format', 'json', '--report-path', '-'];
		type Hit = { File: string; RuleID: string; Description: string; StartLine: number };
		return CONFIGS.flatMap((config) => {
			const run = spawnSync('gitleaks', ['dir', stage, '--config', config, ...flags], {
				encoding: 'utf8',
				maxBuffer: 256 << 20,
			});
			if (run.status !== 0 && run.status !== 1)
				throw new Error(`leak-scan: gitleaks did not run: ${run.error?.message ?? run.stderr}`);
			return (JSON.parse(run.stdout) as Hit[]).map((hit) => ({
				file: texts[Number.parseInt(path.basename(hit.File))].file,
				ruleId: hit.RuleID,
				description: hit.Description,
				line: hit.StartLine,
			}));
		});
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

/** The findings in `texts`: gitleaks' rules, then the host and mailbox allowlists. No finding echoes a matched secret. */
export function scanTexts(texts: Text[], options: ScanOptions = {}) {
	const findings = gitleaks(texts);
	const allowedHosts = new Set(options.allowedHosts ?? DEFAULT_HOSTS);
	const allowedMailboxes = new Set((options.allowedMailboxes ?? ALLOWED_MAILBOXES).map((box) => box.toLowerCase()));
	for (const { file, text } of texts) {
		const add = (ruleId: string, description: string, index: number) =>
			findings.push({ file, ruleId, description, line: lineOf(text, index) });
		for (const match of text.matchAll(URL_RE)) {
			const host = match[1].toLowerCase().replace(/\.$/u, '');
			if (!allowedHosts.has(host))
				add('unreviewed-outbound-host', `outbound host ${host} is not on the reviewed allowlist`, match.index);
		}
		for (const match of text.matchAll(MAILBOX_RE)) {
			const mailbox = match[0].toLowerCase();
			if (!allowedMailboxes.has(mailbox))
				add('unreviewed-mailbox', `mailbox ${mailbox} is not one of the reviewed addresses`, match.index);
		}
	}
	const order = (f: LeakFinding) => [f.file, String(f.line).padStart(9, '0'), f.ruleId].join('\0');
	return findings.sort((left, right) => order(left).localeCompare(order(right)));
}

export function formatFindings(findings: LeakFinding[]) {
	if (findings.length === 0) return 'leak-scan: no findings';
	return findings.map((f) => `${f.file}:${f.line}: [${f.ruleId}] ${f.description}`).join('\n');
}

/** Raised by {@link collectFiles} when the published tree contains a file type the scanner has no verdict for. */
export class UnclassifiedOutputError extends Error {
	constructor(files: string[]) {
		super(
			`leak-scan: ${files.length} published file(s) have an extension that is in neither ` +
				`TEXT_EXTENSIONS nor SKIP_EXTENSIONS, so the scan cannot claim the output is clean:\n` +
				files.map((file) => `  ${file}`).join('\n') +
				`\nAdd each extension to TEXT_EXTENSIONS (it is UTF-8 and must be scanned) or to ` +
				`SKIP_EXTENSIONS (it is opaque binary) in scripts/lib/leak-scan.ts, then re-run.`,
		);
		this.name = 'UnclassifiedOutputError';
	}
}

/**
 * Walks a published tree and returns the absolute paths of the files to scan.
 *
 * FAILS CLOSED: a file whose extension is in neither {@link TEXT_EXTENSIONS}
 * nor {@link SKIP_EXTENSIONS} throws {@link UnclassifiedOutputError} rather
 * than being silently dropped. A scanner whose whole purpose is proving the
 * absence of secrets must not report "clean" over output it never opened.
 */
export function collectFiles(root: string) {
	const found: string[] = [];
	const unclassified: string[] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory).sort()) {
			const absolute = path.join(directory, entry);
			const extension = path.extname(absolute).toLowerCase();
			if (statSync(absolute).isDirectory()) walk(absolute);
			else if (TEXT_EXTENSIONS.has(extension)) found.push(absolute);
			else if (!SKIP_EXTENSIONS.has(extension)) unclassified.push(path.relative(root, absolute));
		}
	};
	walk(root);
	if (unclassified.length > 0) throw new UnclassifiedOutputError(unclassified.sort());
	return found.sort();
}

/**
 * Scans a built directory. Returns the report the CLI prints; throws
 * {@link UnclassifiedOutputError} on an unknown file type. `buildDirectory` is the absolute path of the tree.
 */
export function scanBuildDirectory(buildDirectory: string, options: ScanOptions = {}) {
	const files = collectFiles(buildDirectory);
	const texts = files.map((absolute) => ({
		file: path.relative(buildDirectory, absolute),
		text: readFileSync(absolute, 'utf8'),
	}));
	return { files, findings: scanTexts(texts, options) };
}
