<script lang="ts">
	// A lite YouTube embed. Until a click it is a button over the video's poster, which the browser fetches from
	// i.ytimg.com only as it nears the viewport (loading="lazy"). The click swaps in the youtube-nocookie.com player,
	// so the page makes no request to YouTube before then. The box holds 16:9 from the first paint, so neither the
	// poster nor the player moves anything. An empty id renders nothing. With onplay (the home page) the click calls it
	// instead, and VideoWindow plays the video in its own floating window.
	interface Props {
		id: string;
		title: string;
		onplay?: (trigger: HTMLButtonElement) => void;
	}
	let { id, title, onplay }: Props = $props();
	let playing = $state(false);
</script>

{#if id}
	<div class="yt-lite">
		{#if playing}
			<!-- YouTube refuses an embed that sends no Referer, so the frame keeps the browser's default policy. -->
			<iframe
				src="https://www.youtube-nocookie.com/embed/{encodeURIComponent(id)}?autoplay=1"
				{title}
				allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
				allowfullscreen
				referrerpolicy="strict-origin-when-cross-origin"
				{@attach (frame) => frame.focus()}
			></iframe>
		{:else}
			<button
				type="button"
				aria-label="Play video: {title}"
				onclick={(e) => (onplay ? onplay(e.currentTarget) : (playing = true))}
			>
				<img
					src="https://i.ytimg.com/vi/{encodeURIComponent(id)}/hqdefault.jpg"
					alt=""
					width="480"
					height="360"
					loading="lazy"
					decoding="async"
				/>
				<svg viewBox="0 0 68 48" width="68" height="48" aria-hidden="true">
					<rect width="68" height="48" rx="12" />
					<path d="M27 15v18l16-9z" />
				</svg>
			</button>
		{/if}
	</div>
{/if}

<style>
	.yt-lite {
		position: relative;
		width: 100%;
		aspect-ratio: 16 / 9;
		overflow: hidden;
		border-radius: 0.5rem;
		background: #000;
	}
	iframe,
	button {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		border: 0;
		padding: 0;
	}
	button {
		display: grid;
		place-items: center;
		background: none;
		cursor: pointer;
	}
	button:focus-visible {
		outline: 3px solid var(--color-primary-500, currentColor);
		outline-offset: -3px;
	}
	img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover; /* hqdefault is 4:3 with black bars; cover crops the bars */
	}
	svg {
		position: relative;
		fill: rgb(0 0 0 / 0.7);
		transition: fill 0.15s;
	}
	svg path {
		fill: #fff;
	}
	button:hover svg,
	button:focus-visible svg {
		fill: var(--color-primary-500, #000);
	}
</style>
