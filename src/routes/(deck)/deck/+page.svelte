<script lang="ts">
	import RevealDeck from '$lib/deck/RevealDeck.svelte';
	import { DECK_HTML } from '$lib/generated/deck-public';
	import { SITE_TITLE } from '$lib/site';
</script>

<svelte:head>
	<title>Deck · {SITE_TITLE}</title>
</svelte:head>

<RevealDeck html={DECK_HTML} />
