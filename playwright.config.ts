import { defineConfig, devices } from '@playwright/test';

// PLAYWRIGHT_PORT lets two checkouts on one host each serve their own build.
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
	testDir: './e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI ? 'github' : 'list',
	use: { baseURL: `http://localhost:${port}`, trace: 'on-first-retry' },
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'], launchOptions: executablePath ? { executablePath } : undefined },
		},
	],
	webServer: [
		{
			command: `pnpm exec vite preview --port ${port} --strictPort`,
			port,
			reuseExistingServer: !process.env.CI,
		},
		// e2e/video-fixture, one port up: the video component alone with a test id (e2e/video.spec.ts).
		{
			command: `pnpm exec vite --config e2e/video-fixture/vite.config.ts --port ${port + 1} --strictPort`,
			port: port + 1,
			reuseExistingServer: !process.env.CI,
		},
	],
});
