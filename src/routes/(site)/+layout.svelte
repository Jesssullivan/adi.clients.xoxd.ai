<script lang="ts">
	import SiteHeader from '$lib/components/SiteHeader.svelte';
	import VideoWindow from '$lib/components/VideoWindow.svelte';

	let { children } = $props();
</script>

<div class="relative flex min-h-screen flex-col">
	<a
		href="#content"
		class="focus:bg-primary-500 sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-(--z-tooltip) focus:rounded-sm focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
		>Skip to content</a
	>
	<SiteHeader />

	<div id="content" class="flex-1">
		{@render children?.()}
	</div>
</div>
<!-- Here, not on the home page, so the video keeps playing on every page of this layout. -->
<VideoWindow />
