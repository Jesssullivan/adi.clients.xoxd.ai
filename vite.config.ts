import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			preprocess: vitePreprocess(),
			compilerOptions: { runes: true },
			// Precompressed .br and .gz siblings: overlay/server.py serves them when the client accepts them.
			adapter: adapter({ fallback: '404.html', precompress: true, strict: false }),
			prerender: { handleHttpError: 'warn', handleMissingId: 'warn' },
			// svelte-check covers the build scripts too.
			typescript: { config: (c) => void c.include.push('../scripts/**/*.ts') },
		}),
	],
	test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
