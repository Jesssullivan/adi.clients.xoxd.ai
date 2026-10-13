# Recipes for the static SvelteKit deck and for the overlay server that serves it with /presenter and /demo.
# Run them in `nix develop` (or direnv). docs/content-contract.md defines the slide format and docs/style-rubric.md
# the prose rules.

set shell := ["bash", "-euo", "pipefail", "-c"]

root := justfile_directory()

_default:
    @just --list --unsorted

# Install the frozen dependency graph.
setup:
    cd {{ root }} && pnpm install --frozen-lockfile

# Vite dev server over the regenerated deck.
dev: deck
    cd {{ root }} && pnpm exec vite dev

# ─── Deck pipeline (docs/content-contract.md) ───

# Copy the core's docs/ at <ref> (its NN-slug.svx shards and the images they link) into content/docs/ through gh api,
# pinned by commit in content/docs/source.json, and the ports' bench/chart.svg at <ports> into content/media/, pinned
# by its provenance sidecar. The site renders them at build time.
docs ref="main" ports="main":
    cd {{ root }} && node scripts/docs-sync.ts {{ ref }} {{ ports }}

# Compile content/ into the deck, offline: render KaTeX and shiki, write the note-free slide HTML to src/lib/generated/
# and the speaker notes in <notes>, a directory outside this repo, to overlay/notes.json. Without it there are no notes.
deck notes="":
    cd {{ root }} && node scripts/deck-build.ts {{ if notes == "" { "" } else { "--notes-dir " + quote(notes) } }}

# Fail if the generated deck output has drifted from content/.
deck-check:
    cd {{ root }} && node scripts/deck-build.ts --check

# The mechanical half of docs/style-rubric.md over content/. `just style --route` prints the route with its clock.
style *args:
    cd {{ root }} && node scripts/style-check.ts {{ args }}

# Re-pin every ::src chip and sha mention to one Jesssullivan/adi-sms commit, then deck and check.
# Flags: --no-check, --dry-run, --notes-dir <dir>. docs/content-contract.md, "Re-pinning".
repin sha *flags:
    cd {{ root }} && python3 scripts/repin.py pin {{ sha }} {{ flags }}

# ─── Build and gates ───

# Build the static site to build/, then fail if speaker-note text reached any file in it.
build notes="": (deck notes)
    cd {{ root }} && pnpm exec vite build
    cd {{ root }} && node scripts/notes-gate.ts build

# Fail if speaker-note text reached any static file under <dir> (.gz and .br decompressed).
notes-gate dir="build":
    cd {{ root }} && node scripts/notes-gate.ts {{ dir }}

# Serve the built site (Playwright's web server).
preview port="4173": build
    cd {{ root }} && pnpm exec vite preview --port {{ port }} --strictPort

# Leak-scan build/: secrets, private hosts and addresses, unreviewed hosts and mailboxes.
leak-scan:
    cd {{ root }} && node scripts/check-build-output.ts build

# Svelte and TypeScript diagnostics.
typecheck:
    cd {{ root }} && pnpm exec svelte-kit sync && pnpm exec svelte-check --tsconfig ./tsconfig.json --fail-on-warnings

# The unit tests: the deck builder, style checker, notes gate and leak scan against their fixtures (no network).
test-unit:
    cd {{ root }} && pnpm exec vitest run

# Playwright against `just preview`; CI points it at the Nix Chromium.
test-e2e:
    cd {{ root }} && pnpm exec svelte-kit sync && pnpm exec playwright test

format:
    cd {{ root }} && pnpm exec prettier --write .

format-check:
    cd {{ root }} && pnpm exec prettier --check .

# Gitleaks over the working tree.
secrets-scan-dir:
    cd {{ root }} && gitleaks dir --config .gitleaks.toml --redact --verbose .

# Gitleaks over every commit; CI runs it on a full clone.
secrets-scan-git:
    cd {{ root }} && gitleaks git --config .gitleaks.toml --redact --verbose .

# Every offline gate.
# The style rubric is advisory: it prints its findings and never fails the gate (operator ruling, 2026-10-12).
style-advice:
    -cd {{ root }} && node scripts/style-check.ts

check: deck-check style-advice typecheck test-unit format-check secrets-scan-dir

# What CI runs, except the overlay recipes.
ci: check build leak-scan test-e2e

# ─── Overlay: one server in the cluster for the deck, /presenter and /demo (overlay/) ───
# These recipes add the gh token, when there is one, to NIX_CONFIG for the pinned core, never a flag or file, and keep
# the settings NIX_CONFIG already holds; CI fetches the same pinned commit over SSH with a read-only deploy key
# (ADI_SMS_INPUT).

# Run overlay/server.py's tests in the overlay shell: CPython 3.15.0 with the pinned adi_sms, its deploy/ templates,
# redis-py and valkey-server.
overlay-test:
    t="$(gh auth token 2>/dev/null)" && export NIX_CONFIG="${NIX_CONFIG:+$NIX_CONFIG$'\n'}access-tokens = github.com=$t"; cd {{ root }}/overlay && nix develop . --command python -m unittest -q test_server

# The overlay gate: its tests (with a local valkey-server as the run's queue), the pinned fold, the 320-line server,
# both kustomizations, and the three Jobs of a run rendered from the core's templates, against the Kubernetes 1.33
# schemas (kubeconform -strict).
overlay-check:
    #!/usr/bin/env bash
    set -euo pipefail
    t="$(gh auth token 2>/dev/null)" && export NIX_CONFIG="${NIX_CONFIG:+$NIX_CONFIG$'\n'}access-tokens = github.com=$t"
    o=(${ADI_SMS_INPUT:+--override-input adi-sms "$ADI_SMS_INPUT"}) # CI: the same pinned commit over SSH
    cd {{ root }}/overlay
    nix flake check . "${o[@]}"
    lines="$(wc -l < server.py)"; [ "$lines" -le 320 ] || { echo "overlay/server.py: $lines lines, over 320"; exit 1; }
    nix develop . "${o[@]}" --command bash -euo pipefail -c '
      python -m unittest -q test_server
      for o in hosted kind; do kubectl kustomize "k8s/$o" | kubeconform -strict -summary -kubernetes-version 1.33.0 -; done
      python -c "import server as s, adi_sms.fate as f; print(\"---\n\".join(s.render(p, \"sms-check\", P=4, QUEUE=\"10.0.0.1:6379\",
        IMAGE=\"ghcr.io/jesssullivan/adi-sms:site\", FLAGS=s.flags(f.DEFAULTS)) for p in (\"queue\", \"producer\", \"senders\")))" |
        kubeconform -strict -summary -kubernetes-version 1.33.0 -'

# Build the one image: the deck (`just build`, notes gate included), the server, the pinned core's deploy/ templates,
# the pinned adi-sms with redis-py on CPython 3.15.0, and valkey-server for each run's queue pod. The speaker notes stay out of it. Writes overlay/.image (a docker archive).
overlay-image: build
    #!/usr/bin/env bash
    set -euo pipefail
    t="$(gh auth token 2>/dev/null)" && export NIX_CONFIG="${NIX_CONFIG:+$NIX_CONFIG$'\n'}access-tokens = github.com=$t"
    o=(${ADI_SMS_INPUT:+--override-input adi-sms "$ADI_SMS_INPUT"}) # CI: the same pinned commit over SSH
    cd {{ root }}
    rm -rf overlay/.site && cp -r build overlay/.site && node scripts/notes-gate.ts overlay/.site
    ADI_SITE="$PWD/overlay/.site" nix build --impure --out-link overlay/.image "./overlay#image" "${o[@]}"
    ls -lL overlay/.image

# Rehearse on kind on another machine over ssh (rootless Podman): `up` creates the cluster, loads overlay/.image
# and applies overlay/k8s/kind; `down` removes everything it made; `kubectl` passes arguments through.
overlay-kind cmd host *args:
    {{ root }}/overlay/kind.sh {{ cmd }} {{ host }} {{ args }}

# Build the image, push it to GHCR and roll overlay/k8s/hosted out at its digest on kube context <context>. CI's deploy
# job runs this on every push to main that passes the gates; from an operator shell it also applies overlay/k8s/rbac.
# GHCR takes REGISTRY_TOKEN (CI: the workflow token) or the gh token.
deploy context: overlay-image
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{ root }}/overlay
    o=(${ADI_SMS_INPUT:+--override-input adi-sms "$ADI_SMS_INPUT"}) # CI: the same pinned commit over SSH
    t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT; export REGISTRY_AUTH_FILE="$t/auth.json"
    printf '%s' "${REGISTRY_TOKEN:-$(env -u GH_TOKEN -u GITHUB_TOKEN gh auth token)}" |
      nix develop . "${o[@]}" --command skopeo login ghcr.io -u "${GITHUB_ACTOR:-Jesssullivan}" --password-stdin
    printf '{"default":[{"type":"reject"}],"transports":{"docker-archive":{"":[{"type":"insecureAcceptAnything"}]}}}' \
      >"$t/policy.json" # runners carry no containers policy.json; accept only the archive this recipe built
    nix develop . "${o[@]}" --command skopeo copy --policy "$t/policy.json" --digestfile "$t/digest" docker-archive:.image \
      "docker://ghcr.io/jesssullivan/adi-sms:site-$(git rev-parse --short=12 HEAD)"
    cp -r k8s grafana "$t/"
    nix develop . "${o[@]}" --command bash -euo pipefail -c 'cd "$0" && kustomize edit set image "web=ghcr.io/jesssullivan/adi-sms@$1"' \
      "$t/k8s/hosted" "$(cat "$t/digest")"
    k() { nix develop . "${o[@]}" --command kubectl --context '{{ context }}' "$@"; }
    [ -n "${CI:-}" ] || k apply -k k8s/rbac
    k apply -k "$t/k8s/hosted"
    for d in web grafana; do k -n adi-sms rollout status "deployment/$d" --timeout=300s; done

# Build the speaker notes in <dir>, a directory outside this repo, against this checkout's deck, run the notes gate and
# write them to the notes Secret on kube context <context>; the web pod sees the new file within a minute. /presenter
# drops notes for another DECK_ID, so run it from a clean checkout at origin/main. `just notes <context> <dir>
# --dry-run=server` does everything but the apply.
notes context dir *flags:
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{ root }} && git fetch -q origin main
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && [ -z "$(git status --porcelain)" ] || {
      echo "notes: not a clean checkout at origin/main, so the DECK_ID may not match the deployed deck" >&2
      [[ "{{ flags }}" =~ --dry-run=(server|client) ]]; }
    {{ quote(just_executable()) }} --justfile {{ quote(justfile()) }} build {{ quote(join(invocation_directory(), dir)) }}
    kubectl --context {{ quote(context) }} -n adi-sms create secret generic notes \
      --from-file=notes.json=overlay/notes.json --dry-run=client -o yaml | kubectl --context {{ quote(context) }} apply {{ flags }} -f -
