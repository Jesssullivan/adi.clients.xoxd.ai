import { error } from '@sveltejs/kit';
import { docPage, docs } from '$lib/server/docs';

export const entries = () => docs().map(({ slug }) => ({ slug }));

export const load = ({ params }) => docPage(params.slug) ?? error(404, 'No such doc');
