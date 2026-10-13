<script lang="ts">
	import { base } from '$app/paths';
	import RevealDeck from '$lib/deck/RevealDeck.svelte';
	import { DECK_HTML, DECK_ID } from '$lib/generated/deck-public';
	import { SITE_TITLE } from '$lib/site';

	// /presenter ships the same note-free slide HTML as /deck. The notes come at
	// runtime from /presenter/notes.json, which overlay/server.py serves from
	// outside the static root under the owner-only Access path, so no static file
	// a guest can fetch carries them. Any failure (signed out, offline, a response for
	// another deck build) shows the deck without notes.
	async function loadNotes(): Promise<Record<string, string>> {
		const res = await fetch(`${base}/presenter/notes.json`, {
			cache: 'no-store',
			credentials: 'same-origin',
			redirect: 'error',
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = (await res.json()) as { deck?: unknown; notes?: unknown };
		if (body.deck !== DECK_ID) throw new Error('notes are for another deck build');
		if (!body.notes || typeof body.notes !== 'object') throw new Error('no notes in the response');
		return body.notes as Record<string, string>;
	}
</script>

<svelte:head>
	<title>Presenter · {SITE_TITLE}</title>
</svelte:head>

<!-- Press S for the speaker view (notes, next slide, timer). -->
<RevealDeck html={DECK_HTML} presenter notes={loadNotes} />
