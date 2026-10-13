<script lang="ts">
	import { RESUME_PDF, SITE_TITLE } from '$lib/site';
</script>

<svelte:head>
	<title>Resume · {SITE_TITLE}</title>
</svelte:head>

<main class="page-shell space-y-4">
	<h1>Resume</h1>
	<div class="flex flex-wrap gap-3">
		<a class="btn preset-filled-primary-500" href={RESUME_PDF}>View the resume</a>
		<a class="btn preset-tonal" href={RESUME_PDF} download="jess_sullivan_resume.pdf">Download PDF</a>
		<a class="btn preset-tonal" href={RESUME_PDF} target="_blank" rel="noopener">Open in a new tab</a>
	</div>
</main>
