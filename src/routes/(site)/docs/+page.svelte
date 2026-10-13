<script lang="ts">
	import DocsTabs from '$lib/components/DocsTabs.svelte';

	let { data } = $props();
</script>

<DocsTabs {data} />
