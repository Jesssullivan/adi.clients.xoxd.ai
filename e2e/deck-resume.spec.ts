import { expect, test, type Page } from '@playwright/test';

// The floating PDF viewer (src/lib/components/PdfViewer.svelte): every same-origin .pdf link opens it on the plain
// routes and inside the deck, Esc closes it from any stage and hands focus back, it refits when the viewport crosses
// the phone width, and a browser without an inline PDF viewer follows the link. /resume does not overflow
// at the two QA viewports.

const PDF = '/resume/jess_sullivan_resume.pdf';
const viewer = (page: Page) => page.locator('[data-pdf-viewer]');
const view = async (page: Page) => {
	await page.goto('/resume');
	await page.getByRole('link', { name: 'View the resume' }).click();
	await expect(viewer(page)).toBeVisible();
};

test('/resume opens the viewer on the PDF, with links inside for a browser without a viewer', async ({ page }) => {
	await view(page);
	const pdf = viewer(page).locator('object[type="application/pdf"]');
	await expect(pdf).toHaveAttribute('data', PDF);
	expect((await pdf.boundingBox())?.height ?? 0, 'the object fills most of the viewport').toBeGreaterThan(500);
	await expect(pdf.locator(`a[href="${PDF}"]`)).toHaveCount(2);
	await expect(page.locator('[data-pdf-viewer] [data-part=title] span')).toBeFocused();
});

test('Esc closes the viewer and focus returns to the link that opened it', async ({ page }) => {
	await page.goto('/');
	const link = page.locator(`main a[href="${PDF}"]`).first();
	await link.click();
	await expect(viewer(page)).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(viewer(page)).toHaveCount(0);
	await expect(link).toBeFocused();
	await expect(page).toHaveURL('/');
});

test('Esc still closes the viewer after Maximize and Restore', async ({ page }) => {
	await view(page);
	await page.getByRole('button', { name: 'Maximize' }).click();
	await page.keyboard.press('Escape');
	await expect(viewer(page)).toHaveCount(0);
	await page.getByRole('link', { name: 'View the resume' }).click();
	await page.getByRole('button', { name: 'Minimize' }).click();
	await page.getByRole('button', { name: 'Restore' }).click();
	await page.keyboard.press('Escape');
	await expect(viewer(page)).toHaveCount(0);
});

test('the close slide opens the resume in the viewer, and Esc does not open the overview', async ({ page }) => {
	await page.goto('/deck');
	await expect(page.locator('.reveal.ready')).toBeAttached({ timeout: 30_000 });
	await page.keyboard.press('End');
	const link = page.locator(`.reveal section.present a[href="${PDF}"]`);
	for (const stage of [undefined, 'Minimize', 'Maximize']) {
		await link.click();
		await expect(viewer(page)).toBeVisible();
		if (stage) await page.getByRole('button', { name: stage }).click();
		await page.keyboard.press('Escape');
		await expect(viewer(page)).toHaveCount(0);
		await expect(page.locator('.reveal.overview')).toHaveCount(0);
		await expect(link).toBeFocused();
	}
});

test('the viewer refits when the viewport narrows to a phone while it is open', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await view(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.getByRole('button', { name: 'Close' })).toBeInViewport({ ratio: 1 });
	const box = (await viewer(page).boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width, 'the viewer fits the viewport').toBeLessThanOrEqual(390);
});

test('a browser without an inline PDF viewer follows the link to the PDF', async ({ page }) => {
	await page.addInitScript(() => Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => false }));
	await page.goto('/resume');
	const [res] = await Promise.all([
		page.waitForResponse((r) => r.url().endsWith(PDF)),
		page.getByRole('link', { name: 'View the resume' }).click(),
	]);
	expect(res.status()).toBe(200);
	await expect(viewer(page)).toHaveCount(0);
});

test('/resume offers a download that is a real PDF', async ({ page, request }) => {
	await page.goto('/resume');
	const link = page.locator('main a[download][href$=".pdf"]');
	const res = await request.get((await link.getAttribute('href'))!);
	expect(res.status()).toBe(200);
	expect((await res.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
	const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
	expect(download.suggestedFilename()).toMatch(/\.pdf$/);
});

for (const vp of [
	{ width: 1280, height: 720 },
	{ width: 390, height: 844 },
]) {
	test(`/resume has no horizontal page overflow at ${vp.width}x${vp.height}`, async ({ page }) => {
		await page.setViewportSize(vp);
		await view(page);
		const box = await viewer(page).boundingBox();
		expect(box!.x + box!.width, 'the viewer fits the viewport').toBeLessThanOrEqual(vp.width);
		const { sw, iw } = await page.evaluate(() => ({
			sw: document.documentElement.scrollWidth,
			iw: window.innerWidth,
		}));
		expect(sw).toBeLessThanOrEqual(iw + 1);
		if (vp.width < 640)
			await expect(page.locator('body > div:has(#content)'), 'a phone viewer is modal').toHaveJSProperty('inert', true);
	});
}
