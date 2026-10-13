<script lang="ts" module>
	// The one floating video window, after PdfViewer: a Skeleton FloatingPanel around the youtube-nocookie player.
	// The home page's poster sets `video`; the (site) layout mounts this window, so it stays open and keeps playing
	// while the reader moves between the home page and /docs. The player loads only when the window opens. It autoplays
	// unless the reader prefers reduced motion. Its Close button takes the focus, so Esc closes it (a key pressed inside
	// the cross-origin player never reaches this page); the player is one Tab away.
	export const video = $state({ id: '', title: '', trigger: null as HTMLElement | null });
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { FloatingPanel, Portal } from '@skeletonlabs/skeleton-svelte';
	import { Maximize2, Minimize2, Minus, X } from '@lucide/svelte';

	const HEADER = 44; // px: the window's title bar
	let vw = $state(1280);
	let vh = $state(720);
	// A 16:9 player under the title bar at the bottom right, 480 px wide or the whole width of a phone.
	const width = $derived(Math.min(480, vw - 16));
	const size = $derived({ width, height: Math.round((width * 9) / 16) + HEADER });

	// Read once per video, so a changed preference does not reload the player.
	const embed = (id: string) =>
		`https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=${matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1}`;

	function close() {
		const trigger = video.trigger;
		Object.assign(video, { id: '', title: '', trigger: null });
		void tick().then(() => trigger?.isConnected && trigger.focus({ preventScroll: true }));
	}

	$effect(() => {
		if (!video.id) return;
		void tick().then(() =>
			document.querySelector<HTMLElement>('[data-video-window] [aria-label="Close"]')?.focus({ preventScroll: true }),
		);
	});
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

{#if video.id}
	<Portal>
		<FloatingPanel
			defaultOpen
			defaultPosition={{ x: vw - size.width - 8, y: vh - size.height - 8 }}
			defaultSize={size}
			minSize={{ width: 240, height: 135 + HEADER }}
			closeOnEscape
			restoreFocus={false}
			onOpenChange={(d: { open: boolean }) => d.open || close()}
		>
			<FloatingPanel.Positioner class="z-(--z-modal)">
				<FloatingPanel.Content class="text-surface-950-50" data-video-window>
					<FloatingPanel.Header>
						<FloatingPanel.DragTrigger class="min-w-0 cursor-move touch-none" title="Drag to move">
							<FloatingPanel.Title
								><span class="truncate text-sm font-semibold">{video.title}</span></FloatingPanel.Title
							>
						</FloatingPanel.DragTrigger>
						<FloatingPanel.Control>
							<FloatingPanel.StageTrigger stage="minimized" aria-label="Minimize" title="Minimize"
								><Minus /></FloatingPanel.StageTrigger
							>
							<FloatingPanel.StageTrigger stage="maximized" aria-label="Maximize" title="Maximize"
								><Maximize2 /></FloatingPanel.StageTrigger
							>
							<FloatingPanel.StageTrigger stage="default" aria-label="Restore" title="Restore"
								><Minimize2 /></FloatingPanel.StageTrigger
							>
							<FloatingPanel.CloseTrigger aria-label="Close" title="Close (Esc)"><X /></FloatingPanel.CloseTrigger>
						</FloatingPanel.Control>
					</FloatingPanel.Header>
					<FloatingPanel.Body class="p-0">
						<!-- YouTube refuses an embed that sends no Referer, so the frame keeps the browser's default policy. -->
						<iframe
							class="block h-full w-full border-0"
							src={embed(video.id)}
							title={video.title}
							allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
							allowfullscreen
							referrerpolicy="strict-origin-when-cross-origin"
						></iframe>
					</FloatingPanel.Body>
					<FloatingPanel.ResizeTrigger axis="se" aria-label="Resize" />
				</FloatingPanel.Content>
			</FloatingPanel.Positioner>
		</FloatingPanel>
	</Portal>
{/if}
