<script lang="ts">
	import { page } from '$app/state';
	import ModeToggle from './ModeToggle.svelte';
	import { ADI_SMS_URL, NAV_LINKS } from '$lib/site';

	// One static header at every width: the name, the links and the mode toggle; the links wrap on a narrow screen.
	// /deck and /demo load in full.
	const links = [...NAV_LINKS, { href: ADI_SMS_URL, label: 'GitHub' }];
	const path = $derived(page.url.pathname.replace(/\/$/, '') || '/');
	const current = (href: string) =>
		path === href || (href !== '/' && path.startsWith(`${href}/`)) ? 'page' : undefined;
	const rel = (href: string) => (href.startsWith('http') ? 'noopener noreferrer' : undefined);
	const reload = (href: string) => (href === '/deck' || href === '/demo' ? '' : undefined);
</script>

<header data-testid="public-navigation" data-chrome>
	<div class="site-header__inner flex min-h-14 flex-wrap items-center gap-x-5 gap-y-2 py-2">
		<a href="/" class="hover:text-primary-500 inline-flex items-center gap-2 font-mono text-lg font-bold">
			<span class="nav-avatar" data-tip="Hi there, my name is Jess!">
				<img
					src="/media/jess-sullivan-96.webp"
					alt=""
					width="28"
					height="28"
					decoding="async"
					class="size-7 rounded-full object-cover"
				/>
			</span>
			<span>Jess Sullivan</span>
		</a>
		<nav class="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" aria-label="Primary navigation">
			{#each links as l (l.href)}
				<a
					href={l.href}
					class="hover:text-primary-500 rounded-sm whitespace-nowrap transition-colors"
					aria-current={current(l.href)}
					rel={rel(l.href)}
					data-sveltekit-reload={reload(l.href)}>{l.label}</a
				>
			{/each}
			<ModeToggle />
		</nav>
	</div>
</header>

<style>
	nav :global([aria-current='page']) {
		color: var(--color-primary-500);
		text-decoration: underline;
		text-underline-offset: 0.35em;
	}
	:global([data-mode='dark']) nav :global([aria-current='page']) {
		color: var(--color-primary-400);
	}
	/* The headshot's greeting: shown on hover and on keyboard focus of the home link. */
	.nav-avatar {
		position: relative;
		display: inline-flex;
	}
	.nav-avatar::after {
		content: attr(data-tip);
		position: absolute;
		top: calc(100% + 0.5rem);
		left: 0;
		padding: 0.25rem 0.5rem;
		border-radius: 0.375rem;
		font:
			600 0.8rem/1.2 system-ui,
			sans-serif;
		white-space: nowrap;
		color: var(--color-surface-50);
		background: var(--color-surface-900);
		opacity: 0;
		transform: translateY(-2px);
		transition:
			opacity 120ms ease,
			transform 120ms ease;
		pointer-events: none;
	}
	a:hover .nav-avatar::after,
	a:focus-visible .nav-avatar::after {
		opacity: 1;
		transform: none;
	}
	@media (prefers-reduced-motion: reduce) {
		.nav-avatar::after {
			transition: none;
		}
	}
</style>
