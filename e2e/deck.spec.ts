import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Deck QA for the public /deck build. Contract sources: docs/content-contract.md
// (one content/sections file = one column, `--` subslides below it, ::src chips link to a sha-pinned GitHub
// blob, KaTeX renders at build time, notes only in /presenter) and
// src/lib/deck/RevealDeck.svelte (reveal.js, hash routing #/h/v, 1280x720).

const SECTIONS_DIR = fileURLToPath(new URL('../content/sections', import.meta.url));
const SECTION_FILES = readdirSync(SECTIONS_DIR)
	.filter((f) => /^\d\d-[\w-]+\.md$/.test(f))
	.sort();

const POSTER = fileURLToPath(new URL('../tests/fixtures/deck/media/live.png', import.meta.url));
const SRC_CHIP = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[0-9a-f]{40}\/[^#\s]+(#L\d+(-L\d+)?)?$/;

async function openDeck(page: Page, path = '/deck') {
	await page.goto(path);
	await expect(page.locator('.reveal.ready')).toBeAttached({ timeout: 30_000 });
}

/** Vertical slide counts per horizontal column, read from the DOM. */
async function stackShape(page: Page): Promise<number[]> {
	return page
		.locator('.reveal .slides > section')
		.evaluateAll((cols) => cols.map((c) => c.querySelectorAll(':scope > section').length || 1));
}

async function goTo(page: Page, h: number, v: number) {
	await page.evaluate(([hh, vv]) => (location.hash = `#/${hh}${vv ? `/${vv}` : ''}`), [h, v]);
	await page.waitForFunction(
		([hh, vv]) => {
			const col = document.querySelectorAll('.reveal .slides > section')[hh];
			if (!col?.classList.contains('present')) return false;
			const subs = col.querySelectorAll(':scope > section');
			return subs.length === 0 ? vv === 0 : subs[vv]?.classList.contains('present');
		},
		[h, v],
	);
}

test('/deck boots reveal.js with one horizontal column per content/sections file', async ({ page }) => {
	await openDeck(page);
	const shape = await stackShape(page);
	expect(shape.length, `section files: ${SECTION_FILES.join(', ')}`).toBe(SECTION_FILES.length);
	const slugs = await page
		.locator('.reveal .slides > section')
		.evaluateAll((cols) => cols.map((c) => c.getAttribute('data-slug')));
	expect(slugs, 'columns follow file order').toEqual(SECTION_FILES.map((f) => f.replace(/\.md$/, '')));
	test.info().annotations.push({ type: 'deck-shape', description: JSON.stringify(shape) });
});

test('the right arrow walks every slide in file order', async ({ page }) => {
	await openDeck(page);
	const shape = await stackShape(page);
	for (let h = 1; h < shape.length; h++) {
		await page.keyboard.press('ArrowRight');
		await page.waitForFunction((hh) => location.hash === `#/${hh}`, h, { timeout: 5_000 });
	}
	await expect(page.locator('.deck-number')).toHaveText(`${shape.length} / ${shape.length}`);
});

test('/deck logs no console errors while every slide is visited', async ({ page }) => {
	const errors: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location().url}`);
	});
	page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
	// In production overlay/server.py serves /demo and /grafana; the preview does not.
	await page.route('**/demo?embed=1', (route) => route.fulfill({ contentType: 'text/html', body: '<p>demo</p>' }));
	await page.route('**/grafana/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>panel</p>' }));
	// The walkthrough video's poster, once src/lib/site.ts sets YOUTUBE_ID: the test reaches no YouTube host.
	await page.route('https://i.ytimg.com/**', (route) => route.fulfill({ path: POSTER, contentType: 'image/png' }));
	await openDeck(page);
	const shape = await stackShape(page);
	for (const [h, n] of shape.entries()) for (let v = 0; v < n; v++) await goTo(page, h, v);
	await page.waitForLoadState('networkidle');
	expect(errors).toEqual([]);
});

for (const vp of [
	{ width: 1280, height: 720 },
	{ width: 390, height: 844 },
]) {
	test(`/deck has no horizontal page overflow at ${vp.width}x${vp.height}`, async ({ page }) => {
		await page.setViewportSize(vp);
		await openDeck(page);
		const shape = await stackShape(page);
		const over: string[] = [];
		for (const [h, n] of shape.entries())
			for (let v = 0; v < n; v++) {
				await goTo(page, h, v);
				const { sw, iw } = await page.evaluate(() => ({
					sw: document.documentElement.scrollWidth,
					iw: window.innerWidth,
				}));
				if (sw > iw + 1) over.push(`${h}.${v}: scrollWidth ${sw} > ${iw}`);
			}
		expect(over).toEqual([]);
	});
}

test('every slide fits the 1280x720 reveal canvas (no clipped content)', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await openDeck(page);
	const shape = await stackShape(page);
	const clipped: string[] = [];
	for (const [h, n] of shape.entries())
		for (let v = 0; v < n; v++) {
			await goTo(page, h, v);
			const m = await page.evaluate(() => {
				const slides = document.querySelector<HTMLElement>('.reveal .slides')!;
				const present = Array.from(slides.querySelectorAll<HTMLElement>('section.present')).pop()!;
				return {
					content: present.scrollHeight,
					canvas: slides.offsetHeight,
					title: present.querySelector('h1,h2,h3')?.textContent ?? '',
				};
			});
			if (m.content > m.canvas + 2) clipped.push(`${h}.${v} "${m.title.trim()}": ${m.content}px > ${m.canvas}px`);
		}
	expect(clipped).toEqual([]);
});

test('every GitHub ::src chip links to a full-sha blob; external chips are https', async ({ page }) => {
	await openDeck(page);
	const ext = await page.locator('a.src-chip--ext').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
	expect(
		ext.filter((h) => !/^https:\/\//.test(h)),
		'external citation chips',
	).toEqual([]);
	const hrefs = await page
		.locator('a.src-chip:not(.src-chip--ext)')
		.evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
	expect(hrefs.filter((h) => !SRC_CHIP.test(h))).toEqual([]);
});

test('KaTeX rendered at build time: no raw $$ or TeX left in slide text, no math errors', async ({ page }) => {
	await openDeck(page);
	const result = await page.evaluate(() => {
		const slides = document.querySelector('.reveal .slides')!.cloneNode(true) as HTMLElement;
		const katexCount = slides.querySelectorAll('.katex').length;
		const mathErrors = Array.from(slides.querySelectorAll('.katex-error')).map((e) => e.textContent);
		slides.querySelectorAll('.katex, annotation, pre, code, .notes').forEach((n) => n.remove());
		const text = slides.textContent ?? '';
		const raw = [...text.matchAll(/.{0,40}(\$\$|\\(?:frac|tfrac|mathrm|sum|le|ge|text|min|max)\b).{0,40}/g)].map(
			(m) => m[0],
		);
		return { katexCount, mathErrors, raw };
	});
	expect(result.katexCount, 'KaTeX output is present').toBeGreaterThan(0);
	expect(result.mathErrors).toEqual([]);
	expect(result.raw).toEqual([]);
});

test('public /deck carries no speaker notes', async ({ page }) => {
	await openDeck(page);
	await expect(page.locator('aside.notes')).toHaveCount(0);
	await expect(page.locator('.reveal [class~="notes"]')).toHaveCount(0);
});

test('deck images load and media files resolve', async ({ page, request }) => {
	await openDeck(page);
	const imgs = await page
		.locator('.reveal .slides img')
		.evaluateAll((els) => els.map((i) => i.getAttribute('src') ?? ''));
	const missing: string[] = [];
	// The deck's own media; the video's poster (i.ytimg.com) is YouTube's.
	for (const src of imgs.filter((s) => s && !s.startsWith('data:') && !s.startsWith('https://'))) {
		const res = await request.get(new URL(src, page.url()).toString());
		if (res.status() !== 200) missing.push(`${src} -> ${res.status()}`);
	}
	expect(missing).toEqual([]);
});
