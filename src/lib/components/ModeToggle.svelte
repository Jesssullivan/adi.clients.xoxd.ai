<script lang="ts">
	import { onMount } from 'svelte';
	import { Moon, Sun } from '@lucide/svelte';

	// Light/dark toggle for the single pine theme. The pre-paint script in
	// src/app.html applies the stored mode (default dark) before hydration.
	let mode = $state<'light' | 'dark'>('dark');

	onMount(() => {
		mode = document.documentElement.getAttribute('data-mode') === 'light' ? 'light' : 'dark';
	});

	function toggle() {
		mode = mode === 'dark' ? 'light' : 'dark';
		document.documentElement.setAttribute('data-mode', mode);
		document.documentElement.style.colorScheme = mode;
		try {
			localStorage.setItem('color-mode', mode);
		} catch {
			// storage unavailable: the toggle still applies for this page view
		}
	}
</script>

<button
	type="button"
	class="hover:bg-surface-200-800 inline-flex items-center rounded-sm p-1.5"
	onclick={toggle}
	aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
	title={mode === 'dark' ? 'Light mode' : 'Dark mode'}
>
	{#if mode === 'dark'}<Sun class="h-4 w-4" />{:else}<Moon class="h-4 w-4" />{/if}
</button>
