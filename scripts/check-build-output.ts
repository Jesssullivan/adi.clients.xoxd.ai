#!/usr/bin/env node
/**
 * `just leak-scan`: run the leak scan in scripts/lib/leak-scan.ts (the module
 * tests/leak-scan.test.ts tests) over a built static artefact.
 *
 * It fails loudly rather than quietly passing:
 *   exit 2: the build directory is absent, is not a directory, or contains no
 *           scannable text output (a scan with nothing to scan is not a pass);
 *   exit 2: the tree contains a file whose extension the scanner has no
 *           verdict for (fail-closed; see collectFiles);
 *   exit 1: one or more findings.
 *
 * Usage: node scripts/check-build-output.ts [build_dir]
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { cli } from './lib/deck.ts';
import { UnclassifiedOutputError, formatFindings, scanBuildDirectory } from './lib/leak-scan.ts';

const { positionals } = cli('leak-scan', {}, 1);
const buildDirectory = path.resolve(process.cwd(), positionals[0] ?? 'build');
if (!statSync(buildDirectory, { throwIfNoEntry: false })?.isDirectory()) {
	console.error(`leak-scan: ${buildDirectory} is not a directory. Run \`just build\` before scanning.`);
	process.exit(2);
}

let report;
try {
	report = scanBuildDirectory(buildDirectory);
} catch (error) {
	if (!(error instanceof UnclassifiedOutputError)) throw error;
	console.error(error.message);
	process.exit(2);
}
const { files, findings } = report;
if (files.length === 0) {
	console.error(`leak-scan: ${buildDirectory} contains no scannable text output.`);
	process.exit(2);
}
if (findings.length > 0) {
	console.error(formatFindings(findings));
	console.error(`leak-scan: ${findings.length} finding(s) in ${files.length} published file(s)`);
	process.exit(1);
}
console.log(
	`leak-scan: clean across ${files.length} published file(s) under gitleaks' default rules, leak-scan.toml and the host and mailbox checks`,
);
