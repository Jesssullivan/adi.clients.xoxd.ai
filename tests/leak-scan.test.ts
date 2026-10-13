import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	ALLOWED_HOSTS,
	ALLOWED_MAILBOXES,
	SKIP_EXTENSIONS,
	TEXT_EXTENSIONS,
	UnclassifiedOutputError,
	collectFiles,
	deckContentHosts,
	formatFindings,
	scanBuildDirectory,
	scanTexts,
} from '../scripts/lib/leak-scan.ts';
import { ROOT } from '../scripts/lib/deck.ts';

// Acceptance row: nothing private reaches the published artefact. The rules
// are proven here against synthetic material; `just leak-scan` runs the same
// rules over the real build, which is the variant that cannot live here.

/** The rule ids that fire for each text, one gitleaks run for the whole list. */
function firing(texts: string[]) {
	const ids = texts.map(() => new Set<string>());
	for (const f of scanTexts(texts.map((text, i) => ({ file: String(i), text })))) ids[Number(f.file)].add(f.ruleId);
	return ids;
}
/** Every text in `hits` fires `rule`; no text in `misses` does. */
function expectRule(rule: string, hits: string[], misses: string[]) {
	const ids = firing([...hits, ...misses]);
	hits.forEach((text, i) => expect([...ids[i]], `${rule} on ${text.slice(0, 24)}`).toContain(rule));
	misses.forEach((text, i) => expect([...ids[hits.length + i]], `${rule} on ${text}`).not.toContain(rule));
}

describe('leak-scan rule set', () => {
	const config = readFileSync(path.join(ROOT, 'scripts/lib/leak-scan.toml'), 'utf8');
	const ruleIds = [...config.matchAll(/^id = "([\w-]+)"$/gmu)].map((m) => m[1]);

	it("runs gitleaks' default rules and unique rules of its own", () => {
		expect(readFileSync(path.join(ROOT, '.gitleaks.toml'), 'utf8')).toMatch(/^\[extend\]\nuseDefault = true$/mu);
		expect(new Set(ruleIds).size).toBe(ruleIds.length);
		expect(ruleIds.sort()).toEqual([
			'developer-filesystem-path',
			'internal-hostname',
			'kubeconfig-fragment',
			'private-network-address',
			'secret-assignment',
			'secret-cloud-access-key',
			'secret-forge-token',
			'secret-json-web-token',
			'secret-pem-block',
			'secret-ssh-key',
			'source-map-or-dev-artifact',
		]);
	});
});

// Never-issued tokens shaped like real ones, assembled at run time so no
// gitleaks release sees a contiguous token in this file.
const SEQUENCE = ['x7Kq2mVb9TzR4wLs', '8YcN1dHf6JgP3aEu', '5XoW'].join('');
const FAKE_FORGE_TOKEN = ['ghp_', SEQUENCE].join('');
const FAKE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r'].join('.');

describe('leak-scan detections', () => {
	it("catches secret material with gitleaks' default rules", () => {
		expectRule('aws-access-token', [['AKIA', 'Q3EGUZ7XLMN2PRST'].join('')], ['AKIA', 'an AKIA prefix']);
		expectRule('github-pat', [FAKE_FORGE_TOKEN], ['ghp_short']);
		expectRule('gitlab-pat', [['glpat-', SEQUENCE.slice(0, 20)].join('')], ['glpat-short']);
		expectRule('jwt', [FAKE_JWT], [FAKE_JWT.split('.')[0]]);
		expectRule('generic-api-key', [`api_key = "${SEQUENCE.slice(0, 24)}"`], ['api_key = ""']);
	});

	it('catches secret material the default rules allow', () => {
		const sequence = '0123456789abcdefghijklmnopqrstuvwxyz';
		expectRule('secret-cloud-access-key', ['AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE'], ['AKIA', 'AKIAshort']);
		expectRule(
			'secret-forge-token',
			[`ghp_${sequence}`, `github_pat_${sequence}`, `glpat-${sequence.slice(0, 20)}`, 'xoxb-0123456789'],
			['ghp_short', 'xoxb-short'],
		);
		expectRule('secret-json-web-token', [FAKE_JWT], [FAKE_JWT.split('.')[0]]);
		expectRule(
			'secret-assignment',
			[
				'api_key = "s3cret-value-abcdefghij"',
				"password: 'aaaaaaaaaaaaaaaa'",
				'client-secret="s3cret-value-abcdefghij"',
			],
			['api_key = ""', 'password: "short"', 'the password is long enough'],
		);
		expectRule(
			'secret-pem-block',
			['-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN CERTIFICATE-----'],
			['-----BEGIN PGP SIGNATURE-----'],
		);
		expectRule(
			'secret-ssh-key',
			[`ssh-ed25519 AAAA${SEQUENCE}`, `ssh-rsa AAAA${SEQUENCE}`],
			['ssh-ed25519 is a key type'],
		);
	});

	it('catches cluster and kubeconfig fragments', () => {
		expectRule(
			'kubeconfig-fragment',
			['client-certificate-data: LS0tLS1CRUdJTg==', 'Client-Key-Data', 'current-context: x', 'serviceaccount/token'],
			['a client certificate', 'the current context'],
		);
		// Minified code such as an e.INTERNAL enum member is not a hostname: the
		// rule is case-sensitive, so uppercase code never fires it.
		expectRule(
			'internal-hostname',
			[
				'forms.default.svc',
				'forms.default.svc.cluster.local',
				'runner.example.ts.net',
				'db.internal',
				'wiki.intranet',
				'printer.lan',
				'nas.home.arpa',
			],
			['e[e.INTERNAL=0]="INTERNAL";t.kind??r.INTERNAL', 'adi.clients.xoxd.ai', 'github.com'],
		);
		expectRule(
			'private-network-address',
			['10.20.30.40', '172.16.0.1', '172.31.255.1', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.101.102.103'],
			['8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.1.1'],
		);
	});

	it('catches developer artefacts', () => {
		expectRule(
			'source-map-or-dev-artifact',
			['//# sourceMappingURL=app.js.map', '//# sourceURL=x', 'from node_modules/x'],
			['a source map', 'node modules'],
		);
		expectRule(
			'developer-filesystem-path',
			['/Users/example/git/site/src', '/home/example/x', '/private/var/folders/x', '/root/.cache', 'C:\\Users\\x'],
			['/usr/share/doc', '/srv/site'],
		);
	});

	it('flags any outbound host or mailbox that has not been reviewed', () => {
		expectRule(
			'unreviewed-outbound-host',
			['<a href="https://analytics.example.com/x">x</a>'],
			['<a href="https://adi.clients.xoxd.ai/">home</a>'],
		);
		expectRule('unreviewed-mailbox', ['mailto:someone@example.com'], ['no mailbox here']);
	});

	it('never echoes the matched material in its own report', () => {
		const report = formatFindings(scanTexts([{ file: 'fixture.html', text: `token: ${FAKE_FORGE_TOKEN}` }]));
		expect(report).toContain('[github-pat]');
		expect(report).not.toContain(FAKE_FORGE_TOKEN);
	});

	it('reports the file and line of each finding', () => {
		const findings = scanTexts([{ file: 'a.html', text: 'ok\nok\n10.0.0.1\n' }]);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ file: 'a.html', line: 3, ruleId: 'private-network-address' });
	});

	it('fails, never passes, when gitleaks does not run', () => {
		const { PATH } = process.env;
		process.env.PATH = '';
		try {
			expect(() => scanTexts([{ file: 'a.html', text: 'ok' }])).toThrow(/gitleaks did not run/u);
		} finally {
			process.env.PATH = PATH;
		}
	});
});

describe('leak-scan over the checked-in public inputs', () => {
	// The published artefact is gated by `just leak-scan`; this proves the same
	// rules already hold for the reviewed sources that produce it.
	const publicRoots = ['src/routes', 'src/lib/components', 'static'];
	const textExtensions = new Set(['.html', '.svelte', '.svx', '.svg', '.txt', '.xml', '.css', '.ts', '.js', '.md']);

	const files: Array<{ path: string; text: string }> = [];
	for (const root of publicRoots) {
		const walk = (directory: string) => {
			for (const entry of readdirSync(directory)) {
				const absolute = path.join(directory, entry);
				if (statSync(absolute).isDirectory()) {
					walk(absolute);
					continue;
				}
				if (!textExtensions.has(path.extname(absolute).toLowerCase())) continue;
				files.push({ path: path.relative(ROOT, absolute), text: readFileSync(absolute, 'utf8') });
			}
		};
		walk(path.join(ROOT, root));
	}

	it('found the public inputs it claims to scan', () => {
		expect(files.length).toBeGreaterThan(5);
		expect(files.map((file) => file.path)).toContain('src/routes/(site)/+page.svelte');
	});

	it('carries no leak-scan findings', () => {
		const findings = scanTexts(files.map((file) => ({ file: file.path, text: file.text })));
		expect(formatFindings(findings)).toBe('leak-scan: no findings');
	});

	it('keeps the reviewed allowlists tight', () => {
		expect(ALLOWED_MAILBOXES).toEqual([]);
		expect(deckContentHosts()).toContain('github.com');
		for (const host of ALLOWED_HOSTS) expect(host).not.toMatch(/^\*|\s/u);
		expect(ALLOWED_HOSTS).toContain('github.com');
	});
});

describe('collectFiles fails closed on unknown file types', () => {
	const publishedTree = (files: Record<string, string>) => {
		const root = mkdtempSync(path.join(tmpdir(), 'leak-scan-'));
		for (const [relative, text] of Object.entries(files)) {
			const absolute = path.join(root, relative);
			mkdirSync(path.dirname(absolute), { recursive: true });
			writeFileSync(absolute, text, 'utf8');
		}
		return root;
	};

	it('classifies every extension it walks as text or knowingly-opaque', () => {
		for (const extension of TEXT_EXTENSIONS) expect(SKIP_EXTENSIONS.has(extension)).toBe(false);
		expect(TEXT_EXTENSIONS.has('')).toBe(true);
		expect(TEXT_EXTENSIONS.has('.md')).toBe(true);
	});

	it('collects the text output and skips the opaque output', () => {
		const root = publishedTree({
			'index.html': '<!doctype html>',
			_headers: 'X-Frame-Options: DENY',
			'nested/app.js': 'export {};',
			'font.woff2': 'binary',
			'photo.png': 'binary',
		});
		expect(collectFiles(root).map((file) => path.relative(root, file))).toEqual([
			'_headers',
			'index.html',
			path.join('nested', 'app.js'),
		]);
	});

	it('throws, naming every offending file, rather than skipping an unknown type', () => {
		const root = publishedTree({
			'index.html': '<!doctype html>',
			'site.webmanifest': '{}',
			'nested/schedule.ics': 'BEGIN:VCALENDAR',
		});
		let raised: unknown;
		try {
			collectFiles(root);
		} catch (error) {
			raised = error;
		}
		expect(raised).toBeInstanceOf(UnclassifiedOutputError);
		const message = (raised as Error).message;
		expect(message).toContain('site.webmanifest');
		expect(message).toContain('schedule.ics');
	});

	it('scans an SVG as the text it is', () => {
		const root = publishedTree({ 'index.html': 'ok', 'media/chart.svg': '<svg><!-- 10.20.30.40 --></svg>' });
		expect(scanBuildDirectory(root).findings).toMatchObject([
			{ file: path.join('media', 'chart.svg'), line: 1, ruleId: 'private-network-address' },
		]);
	});

	it('scans a clean published tree end to end', () => {
		const root = publishedTree({ 'index.html': '<a href="https://adi.clients.xoxd.ai/">home</a>' });
		const report = scanBuildDirectory(root);
		expect(report.files).toHaveLength(1);
		expect(report.findings).toEqual([]);
	});
});

describe('the leak-scan gate has exactly one implementation', () => {
	const runner = readFileSync(path.join(ROOT, 'scripts/check-build-output.ts'), 'utf8');

	it('imports the tested module instead of re-deriving the scan', () => {
		expect(runner).toContain("from './lib/leak-scan.ts'");
		for (const forbidden of [
			'function scanTexts',
			'function collectFiles',
			'matchAll(',
			'new RegExp(',
			'gitleaks dir',
		]) {
			expect(runner, `check-build-output.ts must not re-implement ${forbidden}`).not.toContain(forbidden);
		}
	});
});

describe('the credential ruleset stays unreachable from shipped code', () => {
	const shipped: string[] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory)) {
			const absolute = path.join(directory, entry);
			if (statSync(absolute).isDirectory()) {
				walk(absolute);
				continue;
			}
			if (/\.(svelte|ts|js)$/u.test(absolute) && !/\.test\.ts$/u.test(absolute)) shipped.push(absolute);
		}
	};
	walk(path.join(ROOT, 'src/routes'));
	walk(path.join(ROOT, 'src/lib/components'));

	it('found the shipped sources it claims to check', () => {
		expect(shipped.length).toBeGreaterThan(3);
	});

	it('never imports the build-time modules under scripts/lib', () => {
		for (const file of shipped) {
			const source = readFileSync(file, 'utf8');
			expect(source, `${path.relative(ROOT, file)} imports scripts/lib`).not.toMatch(
				/from\s+['"][^'"]*scripts\/lib\//u,
			);
		}
	});
});
