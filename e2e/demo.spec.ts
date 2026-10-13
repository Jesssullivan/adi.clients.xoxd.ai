import { expect, test, type Page } from '@playwright/test';

// /demo against canned /demo/api answers (overlay/server.py serves them in production): the form comes from the
// spec, the newest run's queue, consumers and check line render without a layout shift, the Grafana tab loads
// dashboard sms on its first switch, Run posts the form as numbers, Recent runs names who started and halted each
// run, and a running run takes the rate slider, the scale-down button and Halt.
const params = {
	n: { default: 1000, min: 0, max: 10 ** 7, doc: 'N: messages' },
	seed: { default: 1, min: 0, max: 9 },
	rate: { default: 0, min: 0, max: 10 ** 6, doc: 'lambda: arrivals per second, 0 = all at once' },
	workers: { default: 1, min: 1, max: 64, doc: 'P: processes or pods, each with M senders' },
};
const caps = { N_MAX: 10 ** 6, P_MAX: 10, M_MAX: 100, RATE_MAX: 2000, MAKESPAN_S: 600 };
const final = { sent: 893, failed: 107, attempts: 1000, time_us: 99301920 };
const consumers = [
	{ pod: 'sms-a-senders-x1abc', phase: 'Succeeded', sent: 450, failed: 50 },
	{ pod: 'sms-a-senders-x2def', phase: 'Succeeded', sent: 443, failed: 57 },
];
const run = {
	run: 'sms-a',
	created: '2026-10-10T18:00:00Z',
	phase: 'Complete',
	P: 2,
	params: { n: 1000, senders: 10 },
	started_by: 'j***@example.org',
	halted_by: null,
};
const state = {
	...run,
	...{ rate: 0, depth: 0, pending: 0, lambda_in: 0, lambda_out: 12, busy: 1.2, tau_ms: 99.302, consumers },
	totals: { ...final, done: 1000 },
	final,
	check: true,
};
const next = {
	...run,
	run: 'sms-b',
	phase: 'Running',
	params: { n: 1000, interval_ms: 1000, senders: 10, capacity: 10 },
};
const live = {
	...state,
	...next,
	...{
		rate: 100,
		depth: 4,
		pending: 7,
		lambda_offered: 100,
		lambda_in: 99,
		lambda_out: 97,
		final: null,
		check: undefined,
	},
	totals: { sent: 412, failed: 46, attempts: 458, time_us: 45480000, done: 458 },
	consumers: [
		{ pod: 'sms-b-senders-x1abc', phase: 'Succeeded', sent: 230, failed: 26 },
		{ pod: 'sms-b-senders-x2def', phase: 'Running', sent: 182, failed: 20 },
	],
};

// The canned answers; with running set, the newest run is sms-b and still running, so the page polls its state.
async function mock(page: Page, posted: [string, unknown][], loads: string[], polls: string[], running = false) {
	await page.route('**/demo/api/**', (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname.slice('/demo/api/'.length);
		if (route.request().method() === 'POST') posted.push([path, route.request().postDataJSON()]);
		if (path === 'state') polls.push(url.search);
		const halted = { ...live, phase: 'Halted', P: 0, halted_by: 'g***@example.com' };
		const body = {
			spec: { params, caps },
			runs: posted.length || running ? [next, run] : [run],
			state: url.searchParams.get('run') !== 'sms-b' ? state : posted.some(([p]) => p === 'halt') ? halted : live,
			run: next,
			rate: { ...live, rate: 300 },
			scale: { ...live, P: 1 },
			halt: halted,
		}[path];
		return route.fulfill({ json: body, status: path === 'run' ? 201 : 200 });
	});
	await page.route('**/grafana/**', (route) => {
		loads.push(route.request().url());
		return route.fulfill({ contentType: 'text/html', body: '<p>dashboard</p>' });
	});
	await page.addInitScript(() => {
		const w = window as unknown as { cls: number };
		w.cls = 0; // layout shifts not caused by input: the run view arrives without moving anything
		new PerformanceObserver((l) => {
			for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
				if (!e.hadRecentInput) w.cls += e.value;
		}).observe({ type: 'layout-shift', buffered: true });
	});
}
const cls = (page: Page) => page.evaluate(() => (window as unknown as { cls: number }).cls);

test('/demo builds its form from the spec and shows the newest run', async ({ page }) => {
	const posted: [string, unknown][] = [];
	const loads: string[] = [];
	await mock(page, posted, loads, []);
	await page.goto('/demo');
	await expect(page.locator('form input[type=number]')).toHaveCount(4);
	await expect(page.locator('input[name=n]')).toHaveAttribute('max', '1000000');
	await expect(page.locator('input[name=workers]')).toHaveAttribute('max', '10');
	await expect(page.locator('input[name=rate]')).toHaveAttribute('max', '2000');
	await expect(page.locator('[data-phase=Succeeded]')).toHaveCount(2);
	await expect(page.getByTestId('check')).toContainText('{"sent":893,"failed":107,"attempts":1000,"time_us":99301920}');
	await expect(page.getByTestId('check')).toContainText('== sms fold --n=1000 --senders=10: check true');
	await expect(page.locator('tbody tr').first()).toContainText('j***@example.org'); // who started it, masked
	expect(await cls(page)).toBeLessThan(0.01); // a font's sub-pixel settle on CI is about 0.001
	await expect(page.getByRole('slider')).toBeDisabled(); // a finished run takes no rate
	const grafana = page.locator('iframe');
	await expect(grafana).toBeHidden(); // mounted with no src: it loads on the first switch
	await expect(grafana).not.toHaveAttribute('src');
	expect(loads).toHaveLength(0);
	await page.getByText('grafana', { exact: true }).click();
	await expect(grafana).toBeVisible();
	await expect(grafana).toHaveAttribute('src', '/grafana/d/sms/sms-runs?orgId=1&theme=dark&kiosk');
	await expect(page.getByTestId('check')).toBeHidden();
	await page.getByRole('button', { name: 'Run' }).click();
	await expect.poll(() => posted).toEqual([['run', { n: 1000, seed: 1, rate: 0, workers: 1 }]]);
	await expect(page.getByText('sms-b: Running')).toBeVisible();
	expect(loads).toHaveLength(1); // the dashboard follows the newest run without a reload
	await page.getByRole('button', { name: 'sms-a' }).click(); // an older run gets its own time range
	await expect(grafana).toHaveAttribute('src', /var-run=sms-a&from=\d+&to=\d+&refresh=1m&kiosk$/);
	await page.getByRole('button', { name: 'Switch to light mode' }).click(); // the frame follows the site's mode
	await expect(grafana).toHaveAttribute('src', /theme=light/);
});

test('in the slide frame a running run scrolls and takes the rate, a scale-down and a halt', async ({ page }) => {
	const posted: [string, unknown][] = [];
	const polls: string[] = [];
	await page.setViewportSize({ width: 1280, height: 570 }); // the slide's frame height
	await mock(page, posted, [], polls, true);
	await page.goto('/demo');
	const details = page.locator('details');
	await expect(details).toHaveAttribute('open');
	await expect(page.getByText('sms-b: Running, P = 2 × M = 10')).toBeVisible();
	expect(await cls(page)).toBeLessThan(0.01);
	await expect(page.getByTestId('queued')).toContainText('4 / C 10');
	await expect(page.getByTestId('in flight')).toContainText('7 / P·M 20');
	await expect(page.getByTestId('consumers')).toHaveText('Consumers: 1 running of 2');
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
	await expect(page.getByTestId('rate')).toHaveText('100 msg/s');
	await expect(page.getByTestId('λ offered, msg/s')).toContainText('100');
	await page.getByRole('slider').fill('300');
	await expect.poll(() => posted).toContainEqual(['rate', { rate: 300 }]);
	await page.getByRole('button', { name: 'Scale down one pod' }).click();
	await expect.poll(() => posted).toContainEqual(['scale', { delta: -1 }]);
	await page.locator('summary').click();
	await expect(details).not.toHaveAttribute('open');
	const seen = polls.length;
	await expect.poll(() => polls.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(seen + 2); // two poll cycles
	await expect(details).not.toHaveAttribute('open');
	await page.getByText('grafana', { exact: true }).click();
	await expect(page.locator('iframe')).toBeInViewport();
	await page.reload();
	await expect(page.getByText('sms-b: Running')).toBeVisible();
	await expect(details).toHaveAttribute('open');
	await page.getByRole('button', { name: 'Halt' }).click();
	await expect.poll(() => posted).toContainEqual(['halt', {}]);
	await expect(page.getByText('sms-b: Halted')).toBeVisible();
	await expect(page.getByTestId('check')).toHaveText(
		'Halted by g***@example.com: these totals are partial, so there is no check against the fold.',
	);
	await expect(page.getByRole('button', { name: 'Halt' })).toBeDisabled();
	await page.setViewportSize({ width: 390, height: 844 }); // a phone: the page scrolls only down
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
