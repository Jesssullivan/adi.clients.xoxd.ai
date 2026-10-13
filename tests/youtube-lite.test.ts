// src/lib/components/YouTubeLite.svelte rendered on the server, as the prerender does, and the one id it gets.
import assert from 'node:assert/strict';
import { render } from 'svelte/server';
import { test } from 'vitest';
import YouTubeLite from '../src/lib/components/YouTubeLite.svelte';
import { YOUTUBE_ID } from '../src/lib/site.ts';

test('YOUTUBE_ID is empty or an 11-character YouTube id', () => {
	assert.match(YOUTUBE_ID, /^(|[\w-]{11})$/, 'paste the id after v= in the watch URL, not the URL');
});

test('an empty id renders nothing', () => {
	const { body } = render(YouTubeLite, { props: { id: '', title: 'Walkthrough video' } });
	assert.doesNotMatch(body, /<(div|img|iframe|button)\b|ytimg|youtube/);
});

test('an id renders the lazy poster and the play button, never the player', () => {
	const { body } = render(YouTubeLite, { props: { id: 'fixture-id1', title: 'Walkthrough video' } });
	assert.match(body, /<button type="button" aria-label="Play video: Walkthrough video"/);
	assert.match(body, /src="https:\/\/i\.ytimg\.com\/vi\/fixture-id1\/hqdefault\.jpg"/);
	assert.match(body, /width="480" height="360" loading="lazy"/);
	assert.doesNotMatch(body, /<iframe|youtube-nocookie/);
});
