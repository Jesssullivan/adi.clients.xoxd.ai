
Hi there! This repository contains the live demo and slide deck for the SMS Simulation as well as the demo's gitops overlay.

<https://adi.clients.xoxd.ai> lives behind Cloudflare Access. The simulation code [Jesssullivan/adi-sms](https://github.com/Jesssullivan/adi-sms).

The deck is a static SvelteKit site. `scripts/deck-build.ts` compiles the slides in `content/`, with code excerpts
copied from adi-sms, into `src/lib/generated/`.


`overlay/server.py` serves build and notes at `/presenter/notes.json` and the `/demo` page. A live run there is three
Kubernetes Jobs from the core's `deploy/` templates, which span a valkey queue pod, a producer and `M` senders. 


It serves the running run's numbers at `/metrics` and relays `/grafana` to the Grafana in `overlay/grafana/`, whose dashboard `sms` graphs what Prometheus
scrapes from `/metrics` every 1 s.

```sh
nix develop        # or: direnv allow
just setup         # pnpm install --frozen-lockfile
just dev           # Vite dev server
just ci            # what CI runs: the gates, the build, the notes gate, the leak scan and Playwright
just overlay-test  # the server's tests against the pinned adi-sms (needs gh auth)
```


`/docs` renders the core's docs, the `docs/NN-slug.svx` shards of Jesssullivan/adi-sms, as tabs, and
`/docs/<slug>` gives each shard a page. `just docs <ref>` copies them at one commit into `content/docs/`, so the
build stays offline.

--- 

`main` is production. Each push to `main` that passes CI runs `just deploy`, which builds the image (the deck, the
server and the pinned adi-sms), pushes it to GHCR and rolls `overlay/k8s/hosted` out at that digest. The job signs in
to the tailnet with GitHub's OIDC token, so the repository stores no cluster or tailnet credential. 

All runners and execution compute is local, running in local arc runners.

> The demo repository, slides etc etc etc has been broadly ripped off from the stack I built for a Machine Learning demo and talk I am delivering at XORuby Montreal; while I am unsure if that repo and its slides are public at the time of your reading this, I want to make it clear at least the scaffold for this demo stack, reveal.js work and routingcode was already pretty much in place.


The [skeleton UI]([https://www.skeleton.dev/](https://github.com/skeletonlabs)) color palette / theming is ripped off from my blog. 
