import type { Handle } from '@sveltejs/kit';

// Preload the first-paint body face. Inter 400 rides
// @fontsource through Vite, so its hashed path is known only at build time;
// SvelteKit's preload filter emits the <link rel="preload" as="font"> for it
// into every prerendered page. The Bold mono is a static file, preloaded
// from src/app.html. Every other face waits for its first use, and so does
// the woff twin @fontsource ships beside the woff2 (the woff2 face is the
// one every current browser takes). js and css keep SvelteKit's default
// preload.
export const handle: Handle = ({ event, resolve }) =>
	resolve(event, {
		preload: ({ type, path }) =>
			type === 'js' || type === 'css' || (type === 'font' && /inter-latin-400-normal[^/]*\.woff2$/u.test(path)),
	});
