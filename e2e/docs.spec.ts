import { expect, test } from '@playwright/test';
import { THESIS } from '../src/lib/site';

// The home page: the pine theme, the dear-reader greeting with its link to the FAQ, the three buttons, the "I love ..."
// text wrapped by CSS around the round portrait, then the video. The core's docs live only under /docs, as tabs.
// Screenshots go to test-results/.

const thesis = (page: import('@playwright/test').Page) => page.locator('.landing-hero__thesis');

for (const width of [320, 390, 768, 1024, 1440, 1920])
	test(`at ${width}px the hero text wraps around the portrait and never reaches it`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'pine');
		await page.evaluate(() => document.fonts.ready);
		const { beside, hits } = await thesis(page).evaluate((p) => {
			const img = document.querySelector('.landing-hero__portrait')!.getBoundingClientRect();
			const [cx, cy, r] = [img.left + img.width / 2, img.top + img.height / 2, img.width / 2];
			const range = document.createRange(); // one box per line of the text
			range.selectNodeContents(p);
			const lines = [...range.getClientRects()];
			// A line reaches the portrait when its box's nearest point to the centre lies inside the circle.
			const near = (l: DOMRect) =>
				Math.hypot(Math.max(l.left - cx, 0, cx - l.right), Math.max(l.top - cy, 0, cy - l.bottom));
			return {
				beside: lines.filter((l) => l.bottom > img.top && l.top < img.bottom).length,
				hits: lines.filter((l) => near(l) < r).map((l) => [l.left, l.top, l.right, l.bottom]),
			};
		});
		expect(beside, 'some lines sit beside the portrait').toBeGreaterThan(0);
		expect(hits, 'no line reaches the portrait').toEqual([]);
		await expect(thesis(page)).toHaveText(THESIS);
	});

test('without JS the float wraps the same text', async ({ browser }) => {
	const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
	await page.goto('/');
	await expect(thesis(page)).toHaveText(THESIS);
});

test('the home page runs greeting, buttons, "I love ...", video, links, and shows no docs', async ({ page }) => {
	await page.goto('/');
	const order = await page
		.locator('main > *')
		.evaluateAll((els) =>
			els.map((e) => e.getAttribute('aria-labelledby') ?? e.getAttribute('aria-label') ?? e.className),
		);
	expect(order).toEqual(['hi-title', expect.stringContaining('landing-cta'), 'About me', 'video-title', 'links-title']);
	await expect(page.locator('#hi-title')).toHaveText('Hi there!');
	const hi = page.locator('section[aria-labelledby="hi-title"]');
	await expect(hi.locator('a')).toHaveCount(1);
	await expect(hi.locator('a[href="/docs/faq"]')).toHaveText('FAQ');
	await expect(hi.locator('h3')).toHaveCount(0); // the questions and answers live in the FAQ
	const cta = page.locator('.landing-cta a');
	await expect(cta).toHaveText(['Open the deck', 'Live demo', 'Resume']);
	const tops = await cta.evaluateAll((as) =>
		as.map((a) => [a.getBoundingClientRect().top, a.getBoundingClientRect().height]),
	);
	expect(new Set(tops.map(String)).size, 'at 1280 px the three buttons sit in one row at one height').toBe(1);
	expect(await cta.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual([
		'/deck',
		'/demo',
		'/resume/jess_sullivan_resume.pdf',
	]);
	// No docs card, accordion or collapsible: no <details>, no disclosure button, no doc body.
	await expect(page.locator('main details, main [aria-expanded], main .doc-body, main [data-accordion]')).toHaveCount(
		0,
	);
	await expect(page.locator('main a[href^="/docs"]')).toHaveText(['FAQ', 'AI, recycling and resources']);
	await expect(page.locator('#ai-title')).toHaveCount(0);
	await expect(page.locator('.landing-links a[href="/docs/ai"]')).toBeVisible();
});

for (const width of [390, 1440])
	test(`at ${width}px the video box sits centered in the column`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/');
		const box = (await page.locator('.landing-video > *').boundingBox())!;
		const col = (await page.locator('section[aria-labelledby="video-title"]').boundingBox())!;
		expect(Math.abs(box.x - col.x - (col.x + col.width - box.x - box.width)), 'left and right gaps').toBeLessThan(1);
		const title = (await page.locator('#video-title').boundingBox())!;
		const range = await page.locator('#video-title').evaluate((h) => {
			const r = document.createRange();
			r.selectNodeContents(h);
			const b = r.getBoundingClientRect();
			return { left: b.left, right: b.right };
		});
		expect(
			Math.abs(range.left - title.x - (title.x + title.width - range.right)),
			'the title is centered',
		).toBeLessThan(2);
	});

const tabs = (page: import('@playwright/test').Page) => page.getByRole('tablist', { name: 'Docs' }).getByRole('tab');
const selected = (page: import('@playwright/test').Page) => page.locator('[role="tab"][aria-selected="true"]');

test('/docs shows every doc as a tab, and each page renders its body', async ({ page }) => {
	test.slow(); // one load per doc
	await page.goto('/docs');
	expect(await tabs(page).count()).toBeGreaterThanOrEqual(2);
	await expect(tabs(page).first()).toHaveAttribute('aria-selected', 'true');
	await page.setViewportSize({ width: 390, height: 900 });
	for (const href of await tabs(page).evaluateAll((as) => as.map((a) => a.getAttribute('href')!))) {
		await page.goto(href);
		await expect(selected(page)).toHaveAttribute('href', href);
		const width = await page.evaluate(() => document.documentElement.scrollWidth);
		expect(width, `${href} overflow`).toBeLessThanOrEqual(390);
		const box = (await selected(page).boundingBox())!;
		expect(box.x >= 0 && box.x + box.width <= 390, `${href}: the selected tab is in view`).toBe(true);
	}
	await page.goto('/docs');
	await page.locator('[role="tab"][href="/docs/ai"]').click();
	await expect(page).toHaveURL(/\/docs\/ai$/);
	await expect(page.locator('h1')).toHaveText('AI, recycling and resources');
	await expect(page.locator('.doc-body h2').first()).toHaveText('adi-sms');
	await expect(page.locator('.doc-body details')).toHaveCount(0);
});

test('the docs tabs follow the arrow keys, Home and End, the URL and history', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 900 });
	await page.goto('/docs');
	const hrefs = await tabs(page).evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
	const at = async (href: string) => {
		await expect(page).toHaveURL(new RegExp(`${href}$`));
		await expect(selected(page)).toHaveAttribute('href', href);
		await expect(page.locator('h1')).toHaveText((await selected(page).textContent())!.trim());
	};
	await page.goto(hrefs[1]); // a deep link selects its tab
	await at(hrefs[1]);
	const list = page.getByRole('tablist', { name: 'Docs' });
	expect(await list.evaluate((l) => l.scrollWidth > l.clientWidth), 'the bar scrolls at 390 px').toBe(true);
	await selected(page).focus();
	await page.keyboard.press('ArrowRight');
	await at(hrefs[2]);
	await expect(selected(page)).toBeFocused();
	await page.keyboard.press('End');
	await at(hrefs.at(-1)!);
	await page.keyboard.press('Home');
	await at(hrefs[0]);
	await page.keyboard.press('ArrowLeft'); // focus wraps
	await at(hrefs.at(-1)!);
	await page.goBack();
	await at(hrefs[0]);
	await page.goBack();
	await at(hrefs.at(-1)!);
	await page.goForward();
	await at(hrefs[0]);
	await page.getByRole('link', { name: /^Next doc/ }).click();
	await at(hrefs[1]);
});

test('without JS a deep link renders its doc and the tabs are links', async ({ browser }) => {
	const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
	await page.goto('/docs/ai');
	await expect(selected(page)).toHaveAttribute('href', '/docs/ai');
	await expect(page.locator('h1')).toHaveText('AI, recycling and resources');
	await page.locator('[role="tab"][href="/docs/design"]').click();
	await expect(page).toHaveURL(/\/docs\/design$/);
	await expect(page.locator('h1')).toHaveText('Design');
});

for (const mode of ['light', 'dark'])
	for (const width of [390, 1440])
		test(`screenshot: home and a doc, ${mode} at ${width}px`, async ({ page }, info) => {
			await page.addInitScript((m) => localStorage.setItem('color-mode', m), mode);
			await page.emulateMedia({ reducedMotion: 'reduce' }); // no interstitial over the shot
			await page.setViewportSize({ width, height: 900 });
			await page.goto('/');
			await page.evaluate(() => document.fonts.ready);
			await page.screenshot({ path: info.outputPath(`home-${mode}-${width}.png`), fullPage: true });
			await page.goto('/docs/design');
			await page.screenshot({ path: info.outputPath(`doc-${mode}-${width}.png`), fullPage: true });
			await page.goto((await tabs(page).last().getAttribute('href'))!); // the last tab: the bar scrolls it into view
			await page.screenshot({ path: info.outputPath(`doc-tabs-${mode}-${width}.png`) });
		});
