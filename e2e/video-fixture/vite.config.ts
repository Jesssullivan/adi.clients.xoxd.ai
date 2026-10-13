import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// e2e/video.spec.ts's own page: YouTubeLite (and with ?window=1 VideoWindow) alone, with the id from ?id=, so the test can
// set an id while src/lib/site.ts keeps YOUTUBE_ID empty.
export default defineConfig({
	root: import.meta.dirname,
	plugins: [svelte({ compilerOptions: { runes: true } })],
	server: { fs: { allow: ['../..'] } },
});
