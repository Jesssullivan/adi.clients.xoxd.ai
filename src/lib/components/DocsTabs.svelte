<script lang="ts">
	// The docs as Skeleton tabs, one per doc in order. Each tab is a link to /docs/<slug>: without JS it is a plain
	// link, with JS a change of tab (click, arrow keys, Home or End) moves the URL with a history entry, so back and
	// forward change the tab. The server renders the selected doc into its panel.
	import { goto } from '$app/navigation';
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';
	import { Tabs } from '@skeletonlabs/skeleton-svelte';
	import type { HTMLAnchorAttributes } from 'svelte/elements';
	import type { Doc } from '$lib/server/docs';
	import { SITE_TITLE } from '$lib/site';

	type Link = { slug: string; title: string };
	let { data }: { data: { tabs: Link[]; doc: Doc; prev?: Link; next?: Link; source: string } } = $props();

	let bar: HTMLElement | undefined = $state();
	const open = (slug: string) => slug !== data.doc.slug && goto(`/docs/${slug}`, { keepFocus: true, noScroll: true });
	// A plain click on a tab: this handler runs before the tabs' own, so it navigates here and stops the router and
	// the tabs from navigating a second time. Keys go through onValueChange.
	const click = (slug: string) => (e: MouseEvent) => {
		if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		open(slug);
	};
	// At 390 px the bar scrolls: keep the selected tab in view.
	$effect(() => {
		bar?.querySelector(`[data-value="${data.doc.slug}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});
</script>

<svelte:head>
	<title>{data.doc.title} · {SITE_TITLE}</title>
</svelte:head>

{#snippet caret(to: Link | undefined, label: string, Icon: typeof ChevronLeft)}
	{#if to}
		<a
			class="btn-icon preset-tonal shrink-0"
			href="/docs/{to.slug}"
			aria-label="{label}: {to.title}"
			title="{label}: {to.title}"
			data-sveltekit-keepfocus
			data-sveltekit-noscroll><Icon size={18} /></a
		>
	{:else}
		<span class="btn-icon shrink-0 opacity-30" aria-hidden="true"><Icon size={18} /></span>
	{/if}
{/snippet}

<main class="page-shell reading-column">
	<Tabs value={data.doc.slug} onValueChange={(d) => d.value && open(d.value)} navigate={null}>
		<div class="mb-4 flex items-center gap-2" bind:this={bar}>
			{@render caret(data.prev, 'Previous doc', ChevronLeft)}
			<Tabs.List class="mb-0 min-w-0 flex-1 overflow-x-auto border-b-0 py-2 [scrollbar-width:thin]" aria-label="Docs">
				{#each data.tabs as t (t.slug)}
					<Tabs.Trigger value={t.slug} class="shrink-0 whitespace-nowrap" onclick={click(t.slug)}>
						{#snippet element(attributes)}
							<a {...attributes as HTMLAnchorAttributes} href="/docs/{t.slug}">{t.title}</a>
						{/snippet}
					</Tabs.Trigger>
				{/each}
				<Tabs.Indicator />
			</Tabs.List>
			{@render caret(data.next, 'Next doc', ChevronRight)}
		</div>
		{#each data.tabs as t (t.slug)}
			<Tabs.Content value={t.slug}>
				{#if t.slug === data.doc.slug}
					<h1 class="mt-4">{data.doc.title}</h1>
					{#if data.doc.summary}<p class="mt-2 text-lg">{data.doc.summary}</p>{/if}
					<article class="doc-body mt-8">{@html data.doc.html}</article>
				{/if}
			</Tabs.Content>
		{/each}
	</Tabs>
	<nav class="mt-12 flex flex-wrap justify-between gap-3" aria-label="Previous and next doc">
		{#if data.prev}<a class="btn preset-tonal" href="/docs/{data.prev.slug}">← {data.prev.title}</a>{/if}
		{#if data.next}<a class="btn preset-tonal ms-auto" href="/docs/{data.next.slug}">{data.next.title} →</a>{/if}
	</nav>
	<p class="mt-8 text-sm">From the core repository's <a class="anchor" href={data.source}>docs/</a>.</p>
</main>
