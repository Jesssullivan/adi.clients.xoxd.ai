<script lang="ts">
	import { video } from '$lib/components/VideoWindow.svelte';
	import YouTubeLite from '$lib/components/YouTubeLite.svelte';
	import { ADI_SMS_URL, GITHUB_URL, RESUME_PDF, SITE_TITLE, THESIS, YOUTUBE_ID } from '$lib/site';

	const VIDEO_TITLE = 'Walkthrough video: SMS Simulation Exercise';
</script>

<svelte:head>
	<title>{SITE_TITLE}</title>
</svelte:head>

<!-- The greeting, the three buttons, the "I love ..." text, the video. The docs live on /docs only. -->
<main class="page-shell">
	<section aria-labelledby="hi-title" class="reading-column">
		<h1 id="hi-title">Hi there!</h1>
		<p>
			Hi there! My name is Jess! I am very excited to meet you, reader, and look forward to talking about this codebase.
			In the meantime, the <a class="anchor" href="/docs/faq">FAQ</a> has some premeditated answers to questions I know I'd
			ask myself if I was handed this repo blind.
		</p>
	</section>

	<div class="landing-cta reading-column">
		<div class="flex flex-wrap gap-3">
			<a href="/deck" data-sveltekit-reload class="btn preset-filled-primary-500">Open the deck</a>
			<a href="/demo" data-sveltekit-reload class="btn preset-tonal-primary">Live demo</a>
			<a href={RESUME_PDF} class="btn preset-tonal">Resume</a>
		</div>
	</div>

	<section aria-label="About me" class="landing-hero reading-column" data-prose-measure="none">
		<a
			class="landing-hero__portrait"
			href="/deck#/0"
			data-sveltekit-reload
			data-tip="I am /jesssullivan on github!"
			aria-label="Open the first slide"
		>
			<img
				src="/media/jesssullivan-github-460.webp"
				alt="Jess Sullivan's GitHub avatar, a yellowthroat"
				width="460"
				height="460"
				decoding="async"
				fetchpriority="high"
			/>
		</a>
		<p class="landing-hero__thesis">{THESIS}</p>
	</section>

	<section aria-labelledby="video-title" class="reading-column text-center">
		<h2 id="video-title">Whiteboard Session</h2>
		<div class="landing-video">
			{#if YOUTUBE_ID}
				<YouTubeLite
					id={YOUTUBE_ID}
					title={VIDEO_TITLE}
					onplay={(trigger) => Object.assign(video, { id: YOUTUBE_ID, title: VIDEO_TITLE, trigger })}
				/>
			{:else}
				<p class="video-soon">Video coming soon</p>
			{/if}
		</div>
	</section>

	<section aria-labelledby="links-title" class="reading-column">
		<h2 id="links-title">Links</h2>
		<ul class="landing-links">
			<li><a href={ADI_SMS_URL} rel="noopener noreferrer">github.com/Jesssullivan/adi-sms</a></li>
			<li><a href="/docs/ai">AI, recycling and resources</a></li>
			<li><a href={RESUME_PDF}>Resume (PDF)</a></li>
			<li><a href={GITHUB_URL} rel="noopener noreferrer">github.com/Jesssullivan</a></li>
		</ul>
	</section>
</main>
