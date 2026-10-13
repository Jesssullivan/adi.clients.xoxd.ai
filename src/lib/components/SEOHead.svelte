<script lang="ts">
	// The page's <svelte:head>. The site is prerendered (adapter-static), so it reads only
	// page.url.pathname for the canonical path, and only the explicit `noindex` prop sets noindex.
	import { page } from '$app/state';

	interface Props {
		title: string;
		description: string;
		noindex?: boolean;
		siteName?: string;
		/** Production origin of the canonical URL. */
		origin?: string;
	}

	let {
		title,
		description,
		noindex = false,
		siteName = 'adi.clients.xoxd.ai',
		origin = 'https://adi.clients.xoxd.ai',
	}: Props = $props();

	// The canonical URL drops a trailing slash (and the bare "/" of the root path).
	const canonical = $derived(`${origin}${page.url.pathname.replace(/\/$/, '')}`);
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />

	<link rel="canonical" href={canonical} />

	<meta property="og:type" content="website" />
	<meta property="og:url" content={canonical} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:site_name" content={siteName} />

	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />

	<meta name="robots" content={noindex ? 'noindex, nofollow' : 'index, follow'} />
</svelte:head>
