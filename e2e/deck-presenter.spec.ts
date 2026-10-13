import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// /presenter ships the /deck slide HTML and attaches aside.notes at runtime from /presenter/notes.json, which
// overlay/server.py serves under the owner-only Access path. The preview server has no such route, so these
// tests answer it with one test note per slide for this deck build; the real notes stay out of git. No note text
// may reach the public /deck.
const DECK_ID = /DECK_ID: string = "([0-9a-f]+)"/.exec(readFileSync('src/lib/generated/deck-public.ts', 'utf8'))![1];
const SLIDES = readdirSync('content/sections').filter((f) => /^\d+-[\w-]+\.md$/.test(f)).length;
const NOTES = JSON.stringify({
	deck: DECK_ID,
	notes: Object.fromEntries(
		Array.from({ length: SLIDES }, (_, h) => [`${h}.0`, `<p>Presenter-only test note for slide number ${h}.</p>`]),
	),
});
test.beforeEach(({ page }) =>
	page.route('**/presenter/notes.json', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: NOTES }),
	),
);

test('/presenter without its notes endpoint shows the deck with no notes', async ({ page }) => {
	await page.unroute('**/presenter/notes.json');
	await page.goto('/presenter');
	await expect(page.locator('.reveal.ready')).toBeAttached({ timeout: 30_000 });
	expect(await page.locator('aside.notes').count()).toBe(0);
});

test('/presenter ignores notes for another deck build', async ({ page }) => {
	await page.unroute('**/presenter/notes.json');
	await page.route('**/presenter/notes.json', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ...JSON.parse(NOTES), deck: 'stale' }),
		}),
	);
	await page.goto('/presenter');
	await expect(page.locator('.reveal.ready')).toBeAttached({ timeout: 30_000 });
	expect(await page.locator('aside.notes').count()).toBe(0);
});

test('/presenter carries speaker notes and matches the /deck column shape', async ({ page }) => {
	const shape = async () =>
		page
			.locator('.reveal .slides > section')
			.evaluateAll((cols) => cols.map((c) => c.querySelectorAll(':scope > section').length || 1));
	await page.goto('/deck');
	await expect(page.locator('.reveal.ready')).toBeAttached({ timeout: 30_000 });
	const deckShape = await shape();
	await page.goto('/presenter');
	await expect(page.locator('.reveal.ready')).toBeAttached({ timeout: 30_000 });
	expect(await page.locator('aside.notes').count(), 'every note attached').toBe(
		Object.keys(JSON.parse(NOTES).notes).length,
	);
	expect(await shape(), 'presenter and deck have the same h/v shape').toEqual(deckShape);
});

test('no speaker-note text leaks into /deck', async ({ page }) => {
	await page.goto('/presenter');
	await expect(page.locator('.reveal.ready')).toBeAttached({ timeout: 30_000 });
	// Distinctive probes: the first 96 chars of each note's first list item or paragraph
	// of at least 32 chars, so a short "Clock m:ss to m:ss." cue (docs/style-rubric.md
	// section 4) never hides a note from the probe. Code is excluded on the deck
	// side: a note may legitimately restate a quoted code comment, and code text is
	// verbatim at a pinned sha anyway.
	const probes = await page.locator('aside.notes').evaluateAll((notes) =>
		notes
			.map(
				(n) =>
					Array.from(n.querySelectorAll('li, p'))
						.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
						.find((t) => t.length >= 32) ?? '',
			)
			.filter((t) => t.length >= 32)
			.map((t) => t.slice(0, 96)),
	);
	expect(probes.length).toBeGreaterThan(0);
	await page.goto('/deck');
	await expect(page.locator('.reveal.ready')).toBeAttached({ timeout: 30_000 });
	const deckText = await page.evaluate(() => {
		const slides = document.querySelector('.reveal .slides')!.cloneNode(true) as HTMLElement;
		slides.querySelectorAll('pre, annotation').forEach((n) => n.remove());
		return (slides.textContent ?? '').replace(/\s+/g, ' ');
	});
	const leaks = probes.filter((p) => deckText.includes(p));
	expect(leaks, 'note text found in public surfaces').toEqual([]);
});

test('presenter S key opens the speaker view', async ({ page }) => {
	await page.goto('/presenter');
	await expect(page.locator('.reveal.ready')).toBeAttached({ timeout: 30_000 });
	const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 15_000 }), page.keyboard.press('s')]);
	await popup.waitForLoadState('domcontentloaded');
	// reveal.js notes plugin speaker view: current/upcoming frames, notes and timer.
	await expect(popup.locator('.speaker-controls-notes')).toBeAttached({ timeout: 15_000 });
	await expect(popup.locator('.speaker-controls-time')).toBeAttached();
});
