<script lang="ts">
	import PdfViewer from '$lib/components/PdfViewer.svelte';
	import SEOHead from '$lib/components/SEOHead.svelte';
	import '../app.css';

	let { children } = $props();

	// The live site is Access-gated: one head for every route, noindex
	// everywhere. The (site) group carries the header; the (deck) group is
	// full-screen reveal.
	const SITE_NAME = 'adi.clients.xoxd.ai';
	const SITE_URL = 'https://adi.clients.xoxd.ai';
	const SITE_TITLE = 'Jess Sullivan: SMS Simulation Exercise (adi-sms)';
	const SITE_DESCRIPTION = 'Slides and a live demo for the Analog Devices SMS Simulation Exercise by Jess Sullivan.';
</script>

<SEOHead title={SITE_TITLE} description={SITE_DESCRIPTION} siteName={SITE_NAME} origin={SITE_URL} noindex />

<div class="saturn-interstitial" aria-hidden="true" data-testid="saturn-interstitial">
	<span>Hello Analog!</span>
</div>

{@render children?.()}
<PdfViewer />
