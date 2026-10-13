// Site-wide constants for the adi interview site (ADI SMS Simulation Exercise).
export const SITE_TITLE = 'Jess Sullivan: SMS Simulation Exercise (adi-sms)';
export const THESIS =
	'I love esolangs, practicing guitar and reverse engineering. I love very large build systems and birdwatching. I love learning new programming languages and exploring new codebases. I love declarative and stateful infrastructure, and time-series and topology problems. I love cycling and all things related to printers and email, among many other things. I am always hacking, learning, building, reading and tinkering. Day in, day out, this is what I do.';
export const GITHUB_URL = 'https://github.com/Jesssullivan';
export const ADI_SMS_URL = 'https://github.com/Jesssullivan/adi-sms';
export const RESUME_PDF = '/resume/jess_sullivan_resume.pdf';
// The walkthrough video's YouTube id (unlisted), the one place it is set. Empty: no video renders on any page and
// the site makes no request to YouTube.
export const YOUTUBE_ID: string = 'oCGKfrHWBwk';

export const NAV_LINKS: { href: string; label: string }[] = [
	{ href: '/', label: 'Overview' },
	{ href: '/docs', label: 'Docs' },
	{ href: '/deck', label: 'Deck' },
	{ href: '/demo', label: 'Demo' },
	{ href: '/resume', label: 'Resume' },
];
