import { mount, unmount } from 'svelte';
import VideoWindow, { video } from '../../src/lib/components/VideoWindow.svelte';
import YouTubeLite from '../../src/lib/components/YouTubeLite.svelte';

// ?id= sets the video. With &window=1 the poster opens VideoWindow, as on the home page, and the "Leave the page"
// button unmounts the poster, as a navigation from the home page to /docs does, while the window stays.
const params = new URLSearchParams(location.search);
const id = params.get('id') ?? '';
const title = 'Fixture video';
const target = document.getElementById('video')!;
if (params.has('window')) {
	const card = mount(YouTubeLite, {
		target,
		props: { id, title, onplay: (trigger) => Object.assign(video, { id, title, trigger }) },
	});
	mount(VideoWindow, { target: document.body });
	const leave = Object.assign(document.createElement('button'), { id: 'leave', textContent: 'Leave the page' });
	leave.onclick = () => void unmount(card);
	document.querySelector('main')!.append(leave);
} else mount(YouTubeLite, { target, props: { id, title } });
