import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { YOUTUBE_ID } from '../src/lib/site';

// The walkthrough video (src/lib/components/YouTubeLite.svelte, and on the home page VideoWindow.svelte). The site's
// own pages follow YOUTUBE_ID in src/lib/site.ts. The rest runs on e2e/video-fixture, which mounts the components
// alone with a test id, and answers the poster and the player locally, so no test reaches YouTube.
const FIXTURE = `http://localhost:${Number(process.env.PLAYWRIGHT_PORT ?? 4173) + 1}/?id=fixture-id1`;
const POSTER = fileURLToPath(new URL('../tests/fixtures/deck/media/live.png', import.meta.url));
const youtube = (url: string) => /(^|\.)(youtube\.com|youtube-nocookie\.com|ytimg\.com)$/.test(new URL(url).hostname);

for (const path of ['/', '/deck'])
	test(`${path} shows the video only when YOUTUBE_ID is set, and never loads the player unasked`, async ({ page }) => {
		const requests: string[] = [];
		page.on('request', (r) => void (youtube(r.url()) && requests.push(r.url())));
		await page.route('https://i.ytimg.com/**', (route) => route.fulfill({ path: POSTER, contentType: 'image/png' }));
		await page.goto(path);
		if (path === '/deck') await expect(page.locator('.reveal.ready')).toBeAttached({ timeout: 30_000 });
		await page.waitForLoadState('networkidle');
		await expect(page.locator('.yt-lite')).toHaveCount(YOUTUBE_ID ? 1 : 0);
		if (path === '/') await expect(page.locator('.video-soon')).toHaveText(YOUTUBE_ID ? [] : ['Video coming soon']);
		await expect(page.locator('[data-video-window]')).toHaveCount(0);
		if (path === '/deck')
			expect(await page.locator('[data-video]').evaluate((slot) => (slot as HTMLElement).hidden)).toBe(!YOUTUBE_ID);
		expect(requests.filter((u) => !YOUTUBE_ID || !u.startsWith('https://i.ytimg.com/'))).toEqual([]);
	});

test('with a test id the poster shows, the player loads only on the click, and nothing shifts', async ({ page }) => {
	const player: string[] = [];
	let release = () => {};
	const held = new Promise<void>((r) => (release = r));
	await page.route('https://i.ytimg.com/**', async (route) => {
		await held; // the poster arrives after the CLS observer starts
		await route.fulfill({ path: POSTER, contentType: 'image/png' });
	});
	await page.route('https://www.youtube-nocookie.com/**', (route) => {
		player.push(route.request().url());
		return route.fulfill({ contentType: 'text/html', body: '<title>player</title>' });
	});
	await page.goto(FIXTURE);
	const play = page.getByRole('button', { name: 'Play video: Fixture video' });
	await expect(play).toBeVisible();
	await page.evaluate(() => {
		const w = window as unknown as { cls: number };
		w.cls = 0;
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) w.cls += (e as PerformanceEntry & { value: number }).value;
		}).observe({ type: 'layout-shift' });
	});
	const box = page.locator('.yt-lite');
	const before = (await box.boundingBox())!;
	expect(before.height / before.width, 'a 16:9 box before the poster loads').toBeCloseTo(9 / 16, 2);

	release();
	const poster = play.locator('img');
	await expect(poster).toHaveAttribute('src', 'https://i.ytimg.com/vi/fixture-id1/hqdefault.jpg');
	await expect(poster).toHaveAttribute('loading', 'lazy');
	await expect.poll(() => poster.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
	await expect(page.locator('iframe')).toHaveCount(0);
	expect(player, 'no request to the player before the click').toEqual([]);

	await play.click();
	const frame = page.locator('iframe');
	await expect(frame).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/fixture-id1?autoplay=1');
	await expect(frame).toHaveAttribute('title', 'Fixture video');
	await expect.poll(() => player.length, { timeout: 15_000 }).toBe(1);
	expect(await box.boundingBox(), 'the player fills the same box').toEqual(before);
	const cls = await page.evaluate(
		() =>
			new Promise<number>((r) =>
				requestAnimationFrame(() => requestAnimationFrame(() => r((window as unknown as { cls: number }).cls))),
			),
	);
	expect(cls, 'cumulative layout shift').toBeLessThan(0.01);
});

test('the play button works from the keyboard and hands focus to the player', async ({ page }) => {
	await page.route('https://i.ytimg.com/**', (route) => route.fulfill({ path: POSTER, contentType: 'image/png' }));
	await page.route('https://www.youtube-nocookie.com/**', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<title>player</title>' }),
	);
	await page.goto(FIXTURE);
	await page.keyboard.press('Tab');
	await expect(page.getByRole('button', { name: 'Play video: Fixture video' })).toBeFocused();
	await page.keyboard.press('Space');
	await expect(page.locator('iframe')).toBeFocused();
});

test('on the home page the poster opens a floating window that moves, resizes, minimizes and outlives the page', async ({
	page,
}) => {
	const player: string[] = [];
	await page.route('https://i.ytimg.com/**', (route) => route.fulfill({ path: POSTER, contentType: 'image/png' }));
	await page.route('https://www.youtube-nocookie.com/**', (route) => {
		player.push(route.request().url());
		return route.fulfill({ contentType: 'text/html', body: '<title>player</title>' });
	});
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto(`${FIXTURE}&window=1`);
	await page.waitForLoadState('networkidle');
	expect(player, 'no request to the player before the click').toEqual([]);
	await page.getByRole('button', { name: 'Play video: Fixture video' }).click();

	const win = page.locator('[data-video-window]');
	const frame = win.locator('iframe');
	await expect(frame).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/fixture-id1?autoplay=1');
	await expect.poll(() => player.length, { timeout: 15_000 }).toBe(1);
	await frame.evaluate((f) => ((f as HTMLIFrameElement & { mark: number }).mark = 1));
	await expect(page.locator('.yt-lite iframe'), 'the poster stays a poster').toHaveCount(0);

	const at = (await win.boundingBox())!;
	const bar = (await win.getByTitle('Drag to move').boundingBox())!;
	await page.mouse.move(bar.x + 20, bar.y + bar.height / 2);
	await page.mouse.down();
	await page.mouse.move(bar.x - 280, bar.y - 300, { steps: 8 });
	await page.mouse.up();
	await expect.poll(async () => (await win.boundingBox())!.x, 'dragged').toBeLessThan(at.x - 200);

	const moved = (await win.boundingBox())!;
	await page.mouse.move(moved.x + moved.width - 3, moved.y + moved.height - 3);
	await page.mouse.down();
	await page.mouse.move(moved.x + moved.width + 120, moved.y + moved.height + 80, { steps: 8 });
	await page.mouse.up();
	await expect.poll(async () => (await win.boundingBox())!.width, 'resized').toBeGreaterThan(moved.width + 60);

	await win.getByRole('button', { name: 'Minimize' }).click();
	await expect(frame).toBeHidden();
	await win.getByRole('button', { name: 'Restore' }).click();
	await expect(frame).toBeVisible();

	await page.locator('#leave').click(); // the home page goes away, as on a navigation to /docs
	await expect(page.locator('.yt-lite')).toHaveCount(0);
	expect(await frame.evaluate((f) => (f as HTMLIFrameElement & { mark?: number }).mark), 'the same player').toBe(1);
	expect(player, 'the player did not reload').toHaveLength(1);

	await win.getByRole('button', { name: 'Close' }).click();
	await expect(win).toHaveCount(0);
});

test('the window opens and closes from the keyboard, and does not autoplay under reduced motion', async ({ page }) => {
	await page.route('https://i.ytimg.com/**', (route) => route.fulfill({ path: POSTER, contentType: 'image/png' }));
	await page.route('https://www.youtube-nocookie.com/**', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<title>player</title>' }),
	);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto(`${FIXTURE}&window=1`);
	await page.keyboard.press('Tab');
	const play = page.getByRole('button', { name: 'Play video: Fixture video' });
	await expect(play).toBeFocused();
	await page.keyboard.press('Enter');
	const win = page.locator('[data-video-window]');
	await expect(win.locator('iframe')).toHaveAttribute('src', /autoplay=0$/);
	await expect(win.getByRole('button', { name: 'Close' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(win).toHaveCount(0);
	await expect(play).toBeFocused();
});
