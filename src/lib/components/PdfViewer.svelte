<script lang="ts">
	// The one floating PDF viewer, after xoxd.ai's plan document reader: a Skeleton FloatingPanel that the browser's
	// own PDF viewer fills. A plain click on any same-origin .pdf link opens it, in the deck as on the plain routes.
	// A link with `download` or a `target` is the fallback and keeps the browser's default, as does a modified click
	// and a browser that cannot show a PDF inline (Android Chrome reports navigator.pdfViewerEnabled false).
	import { tick } from 'svelte';
	import { FloatingPanel, Portal } from '@skeletonlabs/skeleton-svelte';
	import { Download, ExternalLink, Maximize2, Minimize2, Minus, X } from '@lucide/svelte';

	const viewer = $state({ href: '', trigger: null as HTMLElement | null });
	let vw = $state(1280);
	let vh = $state(720);
	let title: HTMLSpanElement | undefined = $state();
	const name = $derived(decodeURIComponent(viewer.href.split('/').pop() ?? ''));
	// A phone gets the whole screen and a modal panel; a wider screen gets a centred panel over a page it can still use.
	const phone = $derived(vw < 640);
	const icon = 'btn-icon btn-icon-sm hover:preset-tonal';
	const size = $derived(
		phone ? { width: vw - 16, height: vh - 16 } : { width: Math.min(900, vw - 32), height: vh - 32 },
	);

	function intercept(e: MouseEvent) {
		const a = (e.target as Element | null)?.closest?.('a[href$=".pdf"]');
		if (!(a instanceof HTMLAnchorElement) || a.hasAttribute('download') || a.target || a.origin !== location.origin)
			return;
		if (navigator.pdfViewerEnabled === false) return;
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		Object.assign(viewer, { href: a.pathname, trigger: a });
	}

	function close() {
		const trigger = viewer.trigger;
		Object.assign(viewer, { href: '', trigger: null });
		void tick().then(() => trigger?.focus({ preventScroll: true }));
	}

	// Esc closes the viewer wherever focus is, even on <body> after a stage button hides itself. The capture phase
	// on window runs first, so reveal never sees the key and does not leave the deck.
	function escape(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !viewer.href) return;
		e.stopPropagation();
		close();
	}

	$effect(() => title?.focus({ preventScroll: true }));

	// The phone modal: everything outside the panel is inert until it closes.
	$effect(() => {
		if (!title || !phone) return;
		const others = [...document.body.children].filter(
			(el): el is HTMLElement => el instanceof HTMLElement && !el.contains(title!) && !el.inert,
		);
		for (const el of others) el.inert = true;
		return () => others.forEach((el) => (el.inert = false));
	});
</script>

<!-- Capture runs before SvelteKit's own link handler, which would otherwise try to navigate to the PDF. -->
<svelte:document onclickcapture={intercept} />
<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} onkeydowncapture={escape} />

{#if viewer.href}
	<Portal>
		<!-- The size and position are defaults read at mount, so crossing the phone width mounts a fresh panel. -->
		{#key phone}
			<FloatingPanel
				defaultOpen
				defaultPosition={{ x: Math.round((vw - size.width) / 2), y: phone ? 8 : 16 }}
				defaultSize={size}
				minSize={{ width: 280, height: 320 }}
				onOpenChange={(d: { open: boolean }) => d.open || close()}
			>
				<FloatingPanel.Positioner class="z-(--z-modal)">
					<FloatingPanel.Content class="text-surface-950-50" aria-modal={phone ? 'true' : undefined} data-pdf-viewer>
						<FloatingPanel.Header>
							<FloatingPanel.DragTrigger class="min-w-0 cursor-move touch-none" title="Drag to move">
								<FloatingPanel.Title>
									<span bind:this={title} tabindex="-1" class="truncate text-sm font-semibold outline-none">{name}</span
									>
								</FloatingPanel.Title>
							</FloatingPanel.DragTrigger>
							<FloatingPanel.Control>
								{#if !phone}
									<FloatingPanel.StageTrigger stage="minimized" aria-label="Minimize" title="Minimize"
										><Minus /></FloatingPanel.StageTrigger
									>
									<FloatingPanel.StageTrigger stage="maximized" aria-label="Maximize" title="Maximize"
										><Maximize2 /></FloatingPanel.StageTrigger
									>
									<FloatingPanel.StageTrigger stage="default" aria-label="Restore" title="Restore"
										><Minimize2 /></FloatingPanel.StageTrigger
									>
								{/if}
								<a class={icon} href={viewer.href} download={name} aria-label={`Download ${name}`} title="Download"
									><Download class="size-4" /></a
								>
								<a
									class={icon}
									href={viewer.href}
									target="_blank"
									rel="noopener"
									aria-label="Open in a new tab"
									title="Open in a new tab"><ExternalLink class="size-4" /></a
								>
								<FloatingPanel.CloseTrigger aria-label="Close" title="Close (Esc)"><X /></FloatingPanel.CloseTrigger>
							</FloatingPanel.Control>
						</FloatingPanel.Header>
						<FloatingPanel.Body class="p-0">
							<!-- A browser without a PDF viewer (most phones) shows the links inside the object. -->
							<object class="block h-full w-full" data={viewer.href} type="application/pdf" title={name}>
								<p class="space-x-3 p-6">
									<a class="anchor" href={viewer.href} target="_blank" rel="noopener">Open {name}</a>
									<a class="anchor" href={viewer.href} download={name}>Download it</a>
								</p>
							</object>
						</FloatingPanel.Body>
						{#if !phone}<FloatingPanel.ResizeTrigger axis="se" aria-label="Resize" />{/if}
					</FloatingPanel.Content>
				</FloatingPanel.Positioner>
			</FloatingPanel>
		{/key}
	</Portal>
{/if}
