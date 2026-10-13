<script lang="ts">
	import { mount, onMount, unmount } from 'svelte';
	import YouTubeLite from '$lib/components/YouTubeLite.svelte';
	import { YOUTUBE_ID } from '$lib/site';
	import 'reveal.js/reveal.css';
	import 'katex/dist/katex.min.css';
	import './deck.css';

	// One reveal.js deck for /deck and /presenter. Both get the same note-free
	// slide HTML, rendered at build time by scripts/deck-build.ts, so KaTeX,
	// shiki and markdown never reach the client. /presenter adds the notes
	// plugin's speaker view and passes `notes`, which loads the speaker notes
	// at runtime ("h.v" -> notes HTML); each one becomes an aside.notes on its
	// slide before reveal initialises. If `notes` fails, the deck has no notes.
	interface Props {
		html: string;
		presenter?: boolean;
		notes?: () => Promise<Record<string, string>>;
	}
	let { html, presenter = false, notes }: Props = $props();

	let root: HTMLDivElement;
	// "n / total" over the headline slides; a subslide below slide n reads "n.v / total".
	let badge = $state('');

	const attachNotes = async () => {
		if (!notes) return;
		try {
			const bySlide = await notes();
			for (const [key, notesHtml] of Object.entries(bySlide)) {
				const m = /^(\d+)\.(\d+)$/.exec(key);
				const slide = m && root.querySelector(`section[data-h="${m[1]}"][data-v="${m[2]}"]`);
				if (!slide || typeof notesHtml !== 'string') continue;
				const aside = document.createElement('aside');
				aside.className = 'notes';
				aside.innerHTML = notesHtml;
				slide.appendChild(aside);
			}
		} catch (err) {
			console.warn('presenter: speaker notes unavailable, showing the deck without them', err);
		}
	};

	onMount(() => {
		let deck: { destroy: () => void } | undefined;
		let cancelled = false;
		// ::video slots get the walkthrough video once src/lib/site.ts sets YOUTUBE_ID; until then they stay hidden.
		const slots = YOUTUBE_ID ? root.querySelectorAll<HTMLElement>('[data-video]') : [];
		const videos = Array.from(slots, (target) => {
			target.hidden = false;
			return mount(YouTubeLite, { target, props: { id: YOUTUBE_ID, title: target.dataset.video ?? '' } });
		});
		(async () => {
			const { default: Reveal } = await import('reveal.js');
			const plugins = [];
			if (presenter) {
				const { default: Notes } = await import('reveal.js/plugin/notes');
				plugins.push(Notes);
				await attachNotes();
			}
			if (cancelled) return;
			const r = new Reveal(root, {
				hash: true,
				respondToHashChanges: true,
				history: false,
				controls: true,
				controlsTutorial: false,
				progress: true,
				// Numbering is the .deck-number badge below (n / total, n.v on a subslide), not reveal's.
				slideNumber: false,
				overview: true,
				keyboard: true,
				// Keys inside the PDF viewer and the video are theirs: arrows and space there do not change slides.
				keyboardCondition: (e: KeyboardEvent) =>
					!(e.target as Element | null)?.closest?.('[data-pdf-viewer], .deck-video'),
				touch: true,
				fragments: true,
				center: false,
				width: 1280,
				height: 720,
				margin: 0.03,
				minScale: 0.2,
				maxScale: 2.0,
				transition: 'fade',
				transitionSpeed: 'fast',
				backgroundTransition: 'none',
				navigationMode: 'default',
				showNotes: false,
				// reveal turns a viewport narrower than 435px into its scroll view,
				// which scrolls <body>; the deck lives in the fixed full-screen
				// .deck-shell, so on a phone it stuck on the first slide. Phones get
				// the same paged deck as desktop (swipe to move, landscape to read).
				scrollActivationWidth: 0,
				plugins,
			});
			// Fit guard, measured once a slide is displayed. Step 1 sizes code
			// boxes: every <pre> starts at its natural height, and while the slide
			// overflows the 1280x720 canvas the tallest box is capped to the space
			// left (never below MIN_PRE; it scrolls past that). A cap that does
			// not reduce the overflow is undone, since another column caused it.
			// Step 2 caps diagrams the same way (never below MIN_SVG): an SVG is
			// sized in px, so shrinking the prose cannot make room for it, and
			// before this step a tall diagram shrank the slide's heading instead.
			// Step 3 scales the prose (font-size) in 4% steps to at most 64%.
			// Code is fixed px in deck.css, so step 3 never shrinks it.
			const MIN_PRE = 180;
			const MIN_SVG = 260;
			const overflowOf = (slide: HTMLElement) => slide.scrollHeight - slide.clientHeight;
			const sizeCode = (slide: HTMLElement) => {
				const pres = Array.from(slide.querySelectorAll<HTMLElement>('pre'));
				pres.forEach((p) => (p.style.maxHeight = 'none'));
				// A scratch set local to one measuring pass, never reactive state.
				const skip = new Set<HTMLElement>();
				for (let pass = 0; pass < pres.length * 2; pass++) {
					const over = overflowOf(slide);
					if (over <= 2) break;
					const p = pres
						.filter((x) => !skip.has(x) && x.offsetHeight > MIN_PRE)
						.sort((x, y) => y.offsetHeight - x.offsetHeight)[0];
					if (!p) break;
					const prev = p.style.maxHeight;
					p.style.maxHeight = `${Math.max(MIN_PRE, p.offsetHeight - over - 2)}px`;
					if (overflowOf(slide) >= over - 1) {
						p.style.maxHeight = prev;
						skip.add(p);
					}
				}
				const capped = pres.filter((p) => p.scrollHeight > p.clientHeight + 2).length;
				if (capped) slide.dataset.codeCapped = String(capped);
			};
			const sizeDiagrams = (slide: HTMLElement) => {
				const figs = Array.from(slide.querySelectorAll<HTMLElement>('.diagram-wrap'));
				figs.sort((x, y) => y.offsetHeight - x.offsetHeight);
				for (const fig of figs) {
					const over = overflowOf(slide);
					if (over <= 2) break;
					const svg = fig.querySelector<SVGSVGElement>('svg.diagram');
					if (!svg || fig.offsetHeight <= MIN_SVG) continue;
					svg.style.maxHeight = `${Math.max(MIN_SVG, fig.offsetHeight - over - 2)}px`;
				}
			};
			const fit = (slide: HTMLElement | undefined) => {
				if (!slide || slide.dataset.fitted) return;
				let scale = 1;
				slide.style.fontSize = '';
				sizeCode(slide);
				sizeDiagrams(slide);
				const base = parseFloat(getComputedStyle(slide).fontSize) || 25;
				while (slide.scrollHeight > slide.clientHeight + 2 && scale > 0.64) {
					scale -= 0.04;
					slide.style.fontSize = `${(base * scale).toFixed(2)}px`;
				}
				slide.dataset.fitted = String(Math.round(scale * 100));
			};
			const number = () => {
				const { h, v } = r.getIndices();
				badge = `${h + 1}${v ? `.${v}` : ''} / ${r.getHorizontalSlides().length}`;
			};
			const onSlide = (e: Event) => {
				fit((e as Event & { currentSlide?: HTMLElement }).currentSlide);
				number();
			};
			r.on('ready', onSlide);
			r.on('slidechanged', onSlide);
			await r.initialize();
			deck = r;
		})();
		return () => {
			cancelled = true;
			deck?.destroy();
			for (const v of videos) void unmount(v);
		};
	});
</script>

<div class="deck-shell" data-presenter={presenter ? '' : undefined}>
	<div class="reveal" bind:this={root}>
		<div class="slides">{@html html}</div>
	</div>
	<a class="deck-home" href="/" aria-label="Back to the overview">overview</a>
	{#if badge}<div class="deck-number" aria-live="polite" aria-label={`Slide ${badge}`}>{badge}</div>{/if}
</div>
