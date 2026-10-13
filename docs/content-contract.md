# Content contract for the adi deck

The engine is `src/`, `scripts/`, `Justfile` and `package.json`; the content is `content/`; `overlay/` serves the built
deck. Every word in `content/` follows [`docs/style-rubric.md`](./style-rubric.md).

## Layout

```
content/
  sections/NN-slug.md        one headline slide per file, in NN order; the right arrow walks them
  diagrams/NN-name.svg       hand-written inline SVG
  media/                     the ports' bench chart and its NN-name.provenance.json sidecar
```

## Slide markdown

- **Subslides:** a `--` line outside a code fence ends the headline slide and starts a subslide below it, one level
  deep: reveal's down arrow enters it at `/deck#/h/v` and the right arrow skips it. Subslides are optional drill-downs.
  Their notes carry no Clock cue, so the 30-minute route and the slide badge count headline slides only.
- **Attributes:** an optional first line `<!-- .slide: data-state="dense" -->` passes through to reveal. `dense` sets a
  smaller type size; `title` centres the title slide.
- **Notes:** the speaker notes live in a private directory outside this repo and never enter git or the image. Its
  `NN.md` holds slide NN's notes in the shape of the rubric's section 4; `--` lines split it like the slide file, and
  part v is the note of subslide v (key `h.v` in `overlay/notes.json`). Only `--notes-dir` reads it, so `just deck` and
  `just build` build the deck without notes. A `--notes-dir` inside this repo, a `content/notes/` directory or a `Note:`
  line in a slide fails the build. `just notes <context> <dir>`, run from a clean checkout at origin/main, builds them into `overlay/notes.json`
  (ignored) against that deck's DECK_ID, runs the notes gate and writes the notes Secret; `--dry-run=server` after
  `<dir>` stops short of the apply. The server answers `/presenter/notes.json` from outside the static root under the
  owner-only Access path, and `just notes-gate` (run by `just build`) fails if note text reaches `build/`.
- **Markdown:** GFM. Math is `$…$` inline and `$$…$$` display, rendered by KaTeX at build time. A code excerpt is a
  plain fence (shiki at build time) under a `::src` chip that names its file and lines at the pinned commit.
- **Directives**, each on its own line:
  - `::svg{src="NN-name"}`: inlines `content/diagrams/NN-name.svg`.
  - `::src{ref="OWNER/REPO@sha:path#Lx-Ly" label="…"}` or `::src{ref="https://…"}`: a citation chip.
  - `::media{src="NN-name.svg" alt="…"}`: a `content/media` image. `just deck` fails if its sha256 differs from
    the one its sidecar records.
  - `::live{src="/path" title="…" height="600" caption="…"}`: a lazy iframe of a same-site path or an `https://`
    URL (any other scheme fails the build), loaded while its slide is within reveal's viewDistance so it is warm when
    the slide shows. Print and PDF show one line instead: the title and an absolute link. Any other attribute fails
    the build.
  - `::video{title="…"}`: the walkthrough video, a 560 px wide 16:9 YouTube embed that loads its player on a click.
    The id is `YOUTUBE_ID` in `src/lib/site.ts`, never the slide. While it is empty the slot stays hidden.

## Re-pinning

The deck pins one `Jesssullivan/adi-sms` commit for the `::src` chips:

```sh
just repin "$(gh api repos/Jesssullivan/adi-sms/commits/main -q .sha)"
```

`scripts/repin.py` maps each pinned line range from the old commit to the new one through the unchanged lines, rewrites
the sha in `content/`, then runs `just deck` and `just check`. It never edits a code fence: a chip listed under CHECK
marks a fence to copy again by hand. Flags: `--no-check`, `--dry-run`, and `--notes-dir <dir>` (an absolute path) to
re-pin the notes' citations too.

`just docs <ref> <ports-ref>` copies the core's docs at one commit and the ports' `bench/chart.svg` at another. It
records the ports commit and the chart's sha256 in `content/media/10-bench.provenance.json` and moves every
`adi-sms-ports/tree/<sha>` and `blob/<sha>` link in `content/sections/` to that commit.

## Visual rules

- Colours come from Skeleton's pine theme tokens (`src/app.css`): surface for text and panels, primary for the
  deck's own chrome, secondary for links, success for diagram emphasis. Code keywords take
  tertiary, so no red appears in code.
- Diagrams set `viewBox`, no fixed width, and colour with `currentColor`, `var(--deck-hl)` and `var(--deck-muted)`.
- The title is **Jess Sullivan: SMS Simulation Exercise (adi-sms)**.
