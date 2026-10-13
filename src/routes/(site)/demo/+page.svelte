<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { SegmentedControl } from '@skeletonlabs/skeleton-svelte';
	import { SITE_TITLE } from '$lib/site';

	// The form comes from /demo/api/spec: the pinned core's spec.json params (default, bounds, and the unit that ends
	// each doc string) and the hosted caps. A run is one POST /demo/api/run; while it runs, the rate slider posts
	// /demo/api/rate, the scale button /demo/api/scale and Halt /demo/api/halt?run=<run>, and the view polls
	// /demo/api/state every T (at least 1 s) until the run ends. overlay/server.py answers all of them, and names who
	// started and halted each run from their Cloudflare Access login.
	type Param = { default: number; min: number; max: number; doc?: string };
	type Totals = { sent: number; failed: number; attempts: number; time_us: number; done: number };
	type Consumer = { pod: string; phase: string; sent: number; failed: number };
	type Run = {
		run: string;
		created: string;
		phase: string;
		P: number;
		params: Record<string, number>;
		started_by?: string | null;
		halted_by?: string | null;
	};
	type State = Run & {
		rate?: number;
		depth?: number;
		pending?: number;
		lambda_offered?: number;
		lambda_in?: number;
		lambda_out?: number;
		busy?: number;
		tau_ms?: number;
		totals?: Totals;
		consumers?: Consumer[];
		final: Omit<Totals, 'done'> | null;
		check?: boolean;
		error?: string | null;
	};

	const fmt = (x: unknown) => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x ?? ''));
	const BORDER: Record<string, string> = {
		Running: 'border-secondary-500',
		Succeeded: 'border-success-500',
		Failed: 'border-error-500',
	};
	let fields = $state<[string, Param][]>([]);
	let values = $state<Record<string, number>>({});
	let caps = $state<Record<string, number>>({});
	let runs = $state<Run[]>([]);
	let s = $state<State>();
	let msg = $state('');
	let view = $state('queue');
	let lambda = $state(0); // the slider; it follows the run's rate until the viewer moves it
	// The run view renders once, with its first state, below the intro: nothing above or beside it moves (no CLS).
	let ready = $state(false);
	let open = $state(true); // the parameters start open everywhere and stay as the viewer leaves them
	let framed = $state(false); // the Grafana frame loads on the first switch to it, then stays mounted
	const theme = () => (browser && document.documentElement.dataset.mode) || 'dark'; // ModeToggle sets data-mode
	let mode = $state(theme()); // the Grafana view follows it
	let timer: ReturnType<typeof setTimeout>;

	async function api<T>(path: string, init?: RequestInit): Promise<T> {
		const r = await fetch(`/demo/api/${path}`, { cache: 'no-store', ...init });
		const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
		if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
		return body;
	}
	const post = <T,>(path: string, body: object) =>
		api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	const show = (v: string) => ((view = v), (framed ||= v === 'grafana'));
	const listRuns = async () => (runs = await api<Run[]>('runs').catch(() => []));
	const live = $derived(s?.phase === 'Running');

	function hint({ doc = '', min, max, default: d }: Param) {
		const unit = /, (us|ms|ppm)$/.exec(doc)?.[1];
		return `${unit ? doc.slice(0, -unit.length - 2) : doc}; ${fmt(min)} to ${fmt(max)}${unit ? ' ' + unit : ''}, default ${fmt(d)}`;
	}

	// Dashboard sms (overlay/grafana/sms.json). By default it graphs the newest run over the last 5 min and refreshes
	// every 1 s, so a new run shows in the same frame without a reload. An older run picked in Recent runs gets its own
	// URL: 10 min from its start and a 1 min refresh. The frame loads on the first switch to it and stays mounted.
	const dash = $derived.by(() => {
		const q: Record<string, string> = { orgId: '1', theme: mode };
		if (s && !live && s.run !== runs[0]?.run) {
			const from = Date.parse(s.created) - 5000;
			Object.assign(q, { 'var-run': s.run, from: `${from}`, to: `${from + 600_000}`, refresh: '1m' });
		}
		return `/grafana/d/sms/sms-runs?${new URLSearchParams(q)}&kiosk`;
	});

	function watch(run: string) {
		clearTimeout(timer);
		let first = true;
		const tick = async () => {
			try {
				s = await api<State>(`state?run=${encodeURIComponent(run)}`);
				if (first && s.rate !== undefined) lambda = s.rate;
				first = false;
				if (['Starting', 'Running'].includes(s.phase))
					timer = setTimeout(tick, Math.max(s.params.interval_ms ?? 1000, 1000));
				else listRuns();
			} catch (e) {
				msg = (e as Error).message;
				timer = setTimeout(tick, 2000);
			}
			ready = true;
		};
		tick();
	}

	async function act(f: () => Promise<unknown>) {
		msg = '';
		try {
			await f();
		} catch (err) {
			msg = (err as Error).message;
		}
	}
	const start = (e: SubmitEvent) => (
		e.preventDefault(),
		act(async () => {
			lambda = values.rate ?? 0;
			watch((await post<Run>('run', values)).run);
			listRuns();
		})
	);
	const steer = (path: string, body: object) => act(async () => (s = await post<State>(path, body)));

	onMount(() => {
		const follow = new MutationObserver(() => (mode = theme()));
		follow.observe(document.documentElement, { attributeFilter: ['data-mode'] });
		api<{ params: Record<string, Param>; caps: Record<string, number> }>('spec')
			.then(async ({ params, caps: c }) => {
				caps = c;
				for (const [k, cap] of [
					['n', c.N_MAX],
					['senders', c.M_MAX],
					['workers', c.P_MAX],
					['rate', c.RATE_MAX],
				] as const)
					if (params[k] && cap !== undefined) params[k].max = Math.min(params[k].max, cap); // the server's caps
				fields = Object.entries(params);
				values = Object.fromEntries(fields.map(([k, p]) => [k, p.default]));
				const [newest] = await listRuns();
				if (newest) watch(newest.run);
				else ready = true;
			})
			.catch((e) => ((msg = e.message), (ready = true)));
		return () => {
			clearTimeout(timer);
			follow.disconnect();
		};
	});

	const t = $derived(s?.totals);
	const M = $derived(s?.params.senders ?? 1);
	const running = $derived(s?.consumers?.filter((c) => c.phase === 'Running').length ?? 0);
	const tiles = $derived([
		['sent', t?.sent],
		['failed', t?.failed],
		['done of n', `${fmt(t?.done ?? 0)} / ${fmt(s?.params.n)}`],
		['λ offered, msg/s', s?.lambda_offered],
		['λ in, msg/s', s?.lambda_in],
		['λ out, msg/s', s?.lambda_out],
		['busy senders', s?.busy],
		['E[τ], ms', s?.tau_ms],
	]);
	const bars = $derived([
		['queued', s?.depth ?? 0, s?.params.capacity ?? 1, 'C'],
		['in flight', s?.pending ?? 0, (s?.P ?? 1) * M, 'P·M'],
	] as const);
	const flags = $derived(Object.entries(s?.params ?? {}).map(([k, v]) => `--${k.replaceAll('_', '-')}=${v}`));
	const check = $derived(
		s?.final
			? `${JSON.stringify(s.final)}\n${s.check ? '==' : '!='} sms fold ${flags.join(' ')}: check ${s.check}`
			: s?.error
				? `${s.phase}: ${s.error}`
				: ({
						Starting: 'The queue pod is starting.',
						Running: 'The run is running.',
						Halted: `Halted${s?.halted_by ? ' by ' + s.halted_by : ''}: these totals are partial, so there is no check against the fold.`,
					}[s?.phase ?? ''] ?? 'This run started before the server did, so it has no total here.'),
	);
</script>

<svelte:head>
	<title>Demo · {SITE_TITLE}</title>
</svelte:head>

<main class="page-shell space-y-3" data-prose-measure="none">
	<h1 class="h3">adi-sms demo</h1>
	<p class="text-surface-600-400">
		Each run is three Kubernetes Jobs: a Valkey queue pod, a producer that adds N messages at the rate λ, and P sender
		pods of M senders each that take, send and commit them. Every T the server reads the queue and sets P to ⌈λ·E[τ]/M⌉
		for the offered λ (Little's law), and adds a pod while the queue holds C. The gap between λ offered and λ in is the
		backpressure. At N done it compares the committed total with the pure fold. Halt stops the run on the cluster. The
		Grafana tab graphs the same run.
	</p>
	{#if ready}
		<!-- The deck slide frames this same page; inside its frame the page scrolls. -->
		<details bind:open>
			<summary class="cursor-pointer font-bold">Parameters</summary>
			<form id="params" class="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2 pt-2" onsubmit={start}>
				{#each fields as [name, p] (name)}
					<label class="label" title={hint(p)}>
						<span class="label-text font-mono text-xs font-bold">{name}</span>
						<input
							class="input font-mono"
							type="number"
							step="1"
							required
							{name}
							min={p.min}
							max={p.max}
							bind:value={values[name]}
						/>
						<small class="text-surface-600-400 text-xs leading-snug">{hint(p)}</small>
					</label>
				{/each}
			</form>
		</details>
		<div class="flex flex-wrap items-center gap-3">
			<button class="btn preset-filled-primary-500" form="params" disabled={live || s?.phase === 'Starting'}>Run</button
			>
			{#if s}
				<h2 class="h5">{s.run}: {s.phase}, P = {s.P} × M = {M}</h2>
			{/if}
			<p class="text-error-600-400 grow" role="status">{msg}</p>
			{#if s}
				<SegmentedControl value={view} onValueChange={(d) => show(d.value ?? 'queue')}>
					<SegmentedControl.Control>
						<SegmentedControl.Indicator />
						{#each ['queue', 'grafana'] as v (v)}
							<SegmentedControl.Item value={v}>
								<SegmentedControl.ItemText class="capitalize">{v}</SegmentedControl.ItemText>
								<SegmentedControl.ItemHiddenInput />
							</SegmentedControl.Item>
						{/each}
					</SegmentedControl.Control>
				</SegmentedControl>
			{/if}
		</div>
		{#if s}
			<div class="relative">
				<div class="space-y-3" hidden={view !== 'queue'}>
					<div class="flex flex-wrap items-center gap-x-6 gap-y-2">
						<label class="flex grow items-center gap-2 text-sm">
							<span class="font-mono">λ</span>
							<input
								class="grow"
								type="range"
								min="0"
								max={caps.RATE_MAX ?? 2000}
								step="10"
								disabled={!live}
								bind:value={lambda}
								onchange={() => steer('rate', { rate: Number(lambda) })}
								aria-label="arrival rate, msg/s"
							/>
							<span class="w-28 font-mono tabular-nums" data-testid="rate"
								>{lambda ? `${fmt(Number(lambda))} msg/s` : '0: batch'}</span
							>
						</label>
						<button
							class="btn btn-sm preset-tonal"
							disabled={!live || s.P <= 1}
							onclick={() => steer('scale', { delta: -1 })}>Scale down one pod</button
						>
						<button
							class="btn btn-sm preset-tonal-error"
							disabled={!live}
							onclick={() => steer(`halt?run=${encodeURIComponent(s!.run)}`, {})}>Halt</button
						>
					</div>
					<div class="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-x-6 gap-y-1">
						{#each bars as [k, v, max, of] (k)}
							<div class="flex items-center gap-2 text-sm" data-testid={k}>
								<span class="w-16 whitespace-nowrap">{k}</span>
								<progress class="progress grow" value={v} {max}></progress>
								<span class="w-28 font-mono whitespace-nowrap tabular-nums">{fmt(v)} / {of} {fmt(max)}</span>
							</div>
						{/each}
					</div>
					<div class="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
						{#each tiles as [k, v] (k)}
							<div class="card preset-tonal px-2 py-1" data-testid={k}>
								<span class="text-surface-600-400 block text-xs">{k}</span>
								<strong class="font-mono text-lg tabular-nums">{fmt(v)}</strong>
							</div>
						{/each}
					</div>
					<h2 class="h6" data-testid="consumers">Consumers: {running} running of {s.consumers?.length ?? 0}</h2>
					<div class="flex flex-wrap gap-1">
						{#each s.consumers ?? [] as c (c.pod)}
							<div
								class="border-2 px-1.5 py-0.5 font-mono text-xs {BORDER[c.phase] ?? 'border-surface-500 border-dashed'}"
								title="{c.pod} {c.phase}"
								data-phase={c.phase}
							>
								{c.pod.slice(-5)}: {fmt(c.sent + c.failed)}
							</div>
						{/each}
					</div>
					<pre class="pre text-xs whitespace-pre-wrap" data-testid="check">{check}</pre>
				</div>
				<iframe
					src={framed ? dash : undefined}
					loading="lazy"
					title="Grafana dashboard for {s.run}"
					class={['h-96 w-full border-0', view !== 'grafana' && 'invisible absolute inset-x-0 top-0']}
				></iframe>
			</div>
		{/if}
		{#if runs.length}
			<h2 class="h5">Recent runs</h2>
			<div class="table-wrap">
				<table class="table text-sm">
					<thead
						><tr
							><th>run</th><th>created</th><th>phase</th><th>P</th><th>n</th><th>senders</th><th>rate</th><th
								>started by</th
							><th>halted by</th></tr
						></thead
					>
					<tbody>
						{#each runs as r (r.run)}
							<tr>
								<td><button type="button" class="anchor" onclick={() => watch(r.run)}>{r.run}</button></td>
								{#each [r.created, r.phase, r.P, r.params.n, r.params.senders, r.params.rate, r.started_by, r.halted_by] as v, i (i)}<td
										>{fmt(v)}</td
									>{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}
</main>
