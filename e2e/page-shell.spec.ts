import { expect, test } from '@playwright/test';

// At each width the document has no horizontal overflow, and the header inner and the route's
// <main class="page-shell"> both measure --page-shell, min(100% - 2rem, 72rem), within 1 px.

const widths = [375, 768, 1024, 1440];

for (const width of widths) {
	test(`the shell and the header inner share one width at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 1200 });
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		const measured = await page.evaluate(() => {
			const widthOf = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().width ?? null;
			const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
			// The first running-text paragraph: one outside a card and outside a
			// grid marked data-prose-measure="none", where the exception applies.
			const paragraph = Array.from(document.querySelectorAll('main.page-shell p')).find(
				(candidate) => !candidate.closest('.card, [data-prose-measure="none"]'),
			) as HTMLElement | undefined;
			return {
				innerWidth: window.innerWidth,
				scrollWidth: document.documentElement.scrollWidth,
				rootPx,
				shell: widthOf('main.page-shell'),
				header: widthOf('.site-header__inner'),
				measure: paragraph ? getComputedStyle(paragraph).maxWidth : null,
				token: getComputedStyle(document.documentElement).getPropertyValue('--page-shell').trim(),
			};
		});
		expect(measured.scrollWidth, 'document overflow').toBeLessThanOrEqual(measured.innerWidth + 1);
		expect(measured.token).toBe('min(100% - 2rem, 72rem)');
		const expected = Math.min(measured.innerWidth - 2 * measured.rootPx, 72 * measured.rootPx);
		for (const [name, value] of Object.entries({
			shell: measured.shell,
			header: measured.header,
		})) {
			expect(value, `${name} is rendered`).not.toBeNull();
			expect(Math.abs((value as number) - expected), `${name} width ${value} vs ${expected}`).toBeLessThanOrEqual(1);
		}
		expect(measured.measure, 'a paragraph inside the shell wraps at the prose measure').toMatch(/^\d+(\.\d+)?px$/);
	});
}
