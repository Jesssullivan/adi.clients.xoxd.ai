import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Deck QA (2026-10-08): the landing page carries the title framing from
// docs/content-contract.md, the headshot, no site footer, and no document-level
// horizontal overflow at the deck's two QA viewports.

// The walkthrough video's poster, once src/lib/site.ts sets YOUTUBE_ID: the tests reach no YouTube host.
const POSTER = fileURLToPath(new URL('../tests/fixtures/deck/media/live.png', import.meta.url));
const poster = (page: Page) =>
	page.route('https://i.ytimg.com/**', (route) => route.fulfill({ path: POSTER, contentType: 'image/png' }));

const VIEWPORTS = [
	{ label: 'desktop', width: 1280, height: 720 },
	{ label: 'phone', width: 390, height: 844 },
];

test('the landing page leads with the greeting as its one heading', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('h1')).toHaveCount(1);
	await expect(page.locator('h1#hi-title')).toHaveText('Hi there!');
	await expect(page.locator('main')).not.toContainText('SMS Simulation Exercise (adi-sms)');
	await expect(page.locator('a[href="/deck"]').first()).toBeVisible();
	await expect(page.locator('a[href="/resume"]').first()).toBeVisible();
	const portrait = page.locator('.landing-hero__portrait img');
	await expect(portrait).toHaveAttribute('src', '/media/jesssullivan-github-460.webp');
	await expect(page.locator('a.landing-hero__portrait')).toHaveAttribute('href', '/deck#/0');
});

for (const vp of VIEWPORTS) {
	test(`landing has no horizontal page overflow at ${vp.width}x${vp.height}`, async ({ page }) => {
		await page.setViewportSize({ width: vp.width, height: vp.height });
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		const { scrollWidth, innerWidth } = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			innerWidth: window.innerWidth,
		}));
		expect(scrollWidth, `${vp.label} document overflow`).toBeLessThanOrEqual(innerWidth + 1);
	});
}

test('landing does not shift while it loads', async ({ page }) => {
	await page.addInitScript(() => {
		const w = window as unknown as { cls: number };
		w.cls = 0;
		new PerformanceObserver((l) => {
			for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
				if (!e.hadRecentInput) w.cls += e.value;
		}).observe({ type: 'layout-shift', buffered: true });
	});
	await poster(page);
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	expect(await page.evaluate(() => (window as unknown as { cls: number }).cls)).toBeLessThan(0.01); // a font's sub-pixel settle on CI is about 0.001
});

test('landing has no site footer', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('footer')).toHaveCount(0);
});

test('landing logs no console errors', async ({ page }) => {
	const errors: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});
	page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
	await poster(page);
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	expect(errors).toEqual([]);
});

test('the interstitial says Hello Analog! after load and lifts by itself', async ({ page }) => {
	await page.goto('/');
	const veil = page.getByTestId('saturn-interstitial');
	await expect(veil).toBeVisible();
	await expect(veil).toHaveText('Hello Analog!');
	await expect(veil).toBeHidden({ timeout: 5000 });
});

// The blog header's rainbow (jesssullivan.github.io, .hero-banner-description) at its own size: 7rem at 1280 px.
const RAINBOW =
	'linear-gradient(90deg, rgb(255, 107, 107), rgb(255, 165, 0), rgb(255, 215, 0), rgb(78, 205, 196), rgb(69, 183, 209), rgb(153, 102, 204), rgb(255, 107, 157), rgb(255, 107, 107))';
const lineStyle = (page: Page) =>
	page
		.getByTestId('saturn-interstitial')
		.locator('span')
		.evaluate((e) => {
			const s = getComputedStyle(e);
			return {
				image: s.backgroundImage,
				clip: s.backgroundClip,
				size: s.fontSize,
				name: s.animationName,
				time: s.animationDuration,
			};
		});

test('the interstitial line flows in the blog header rainbow, 8 s a cycle', async ({ page }) => {
	await page.clock.install();
	await page.clock.pauseAt(Date.now() + 1000); // the 3.2 s lift never fires, so a slow runner cannot miss the line
	await page.goto('/');
	await expect(page.locator('html')).toHaveClass(/saturn-intro-live/);
	expect(await lineStyle(page)).toEqual({
		image: RAINBOW,
		clip: 'text',
		size: '112px',
		name: 'saturn-beat, saturn-rainbow',
		time: '3s, 8s',
	});
});

test('under forced colors the interstitial line keeps a solid fill', async ({ page }) => {
	await page.emulateMedia({ forcedColors: 'active' });
	await page.goto('/deck'); // armed by hand, as below, so the shot does not race the 3 s lift
	await page.evaluate(() => document.documentElement.classList.add('saturn-intro', 'saturn-intro-live'));
	const fill = await page
		.getByTestId('saturn-interstitial')
		.locator('span')
		.evaluate((el) => getComputedStyle(el).webkitTextFillColor);
	expect(fill).not.toBe('rgba(0, 0, 0, 0)');
});

test('the interstitial shows only on the home page, and never with reduced motion', async ({ page }) => {
	await page.goto('/deck');
	await expect(page.getByTestId('saturn-interstitial')).toBeHidden();
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/');
	await expect(page.getByTestId('saturn-interstitial')).toBeHidden();
	// Armed by hand, the rainbow stays a still gradient.
	await page.evaluate(() => document.documentElement.classList.add('saturn-intro', 'saturn-intro-live'));
	expect(await lineStyle(page)).toMatchObject({ image: RAINBOW, clip: 'text', name: 'saturn-beat' });
});
