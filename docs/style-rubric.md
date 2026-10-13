# Style rubric for the adi deck

This rubric covers every word on the deck: slides, speaker notes (`NN.md` in the notes directory), `::live`
captions and diagram labels. `just style` (part of `just check`) enforces the rules marked "checked"; a reviewer
applies the rest with the checklist in section 5.

## 1. Accuracy

Every sentence states something that adi-sms at the pinned commit, a test, a measurement or a cited public source
supports. A number carries its unit and its source: a `::src` chip, a media sidecar or a `Source:`
line in the note. A fact the deck does not have is cut, never invented. Prose is plain and technical, and the notes are
in the first person ("I set attempts to 3"). Jess's own words (the landing page text) are not rewritten.

Three lenses judge each sentence:

| lens | judges | against |
|---|---|---|
| math and queueing | formulas, bounds, probabilities, units, worked numbers | docs/*.svx at the pin; Little 1961, Graham 1966 |
| code and systems | identifiers, line numbers, flags, HTTP status codes, manifest values | adi-sms at the pin (`git show <sha>:<path>`), this repository |
| provenance and public safety | a source for each number; nothing private named | `::src` chips, media sidecars, the leak scan |

Slides and notes name no internal host, tracker id or ruling id, and link no private repository other than adi-sms.

## 2. Banned words and patterns

| rule | what | checked |
|---|---|---|
| 2.1 | abstract nouns: understanding, granularity, specificity, breadth, depth | yes |
| 2.2 | a bold label followed by a verdict (`**Is:** ...`), aphorisms ("the whole idea") | yes |
| 2.3 | three rhythmic clauses that say one thing (a list of three real things is fine) | no |
| 2.4 | stacked hedges and status caveats (prototype, experimental, unrun, not deployed) | yes |
| 2.5 | leverage, robust, journey, landscape, meaningful, seamless, delve, crucial, tenet, siloed, invites | yes |
| 2.5 | praise and minimizers: honest, powerful, vital, elegant, simply, obviously, "just" outside code | yes |
| 2.6 | transitions that announce the next part ("let's", "moving on", "next up", "now,") | yes |
| 2.7 | telling the reader how to feel ("amazing", "exciting", "I love") | yes |
| 2.8 | a first spoken sentence that restates the title | yes |
| 2.11 | short parts strung with commas in place of a sentence ("One server, one hostname.") | yes |

`just style` matches words as whole words outside code spans and math, so `just check` in backticks passes. Rule 2.11
flags a sentence, title or caption whose comma-separated parts are each three words or fewer. Table
cells are labels and are exempt.

## 3. Slides

| rule | detail | checked |
|---|---|---|
| title | names the thing in 10 words or fewer; no question, imperative, "X is Y", "X, not Y", semicolon, first person or period | yes |
| prose | at most 12 words of title and paragraphs, 25 with lists and captions; the title slide may use 25 | yes |
| lists | at most 4 items of at most 6 words | yes |
| tables | a cell holds at most 12 words | yes |
| captions | at most 25 words | yes |
| equations | at most one display equation | yes |
| sources | a slide with a number has a `::src`, sidecar or `Source:` line | yes |
| diagrams | labels name parts in 10 words or fewer and never end in a period | yes |
| one claim | a slide that needs "and" to state its point is two slides | no |

## 4. Notes and the route

Every slide has a note in `NN.md` of the notes directory, and a subslide its `--` part of that file:

```text
Clock 1:30 to 2:30.                 the cue: m:ss to m:ss on the 30-minute clock
Walk the picture left to right.     an instruction to the presenter, never spoken
- A spoken sentence.                every "- " item is spoken
- If asked why: the answer.         spoken only when asked
Source: DESIGN.md section 1.        provenance, never spoken
```

- A sentence has at most 18 words, and the first spoken one adds something the slide does not show (checked).
- Spoken words fit the slide's dwell at 150 words a minute (checked).
- Only headline slides carry a Clock cue; a subslide is an optional drill-down off the route (checked).
- The deck has 10 to 14 slides with a Clock cue; the clock runs from 0:00 without gaps and ends by 30:00; a slide holds
  at most 240 s, or 360 s for a `::live` slide (checked).
- `just style --notes-dir <dir>` checks the notes; without it, the note and route rules are skipped and it says so.
- `node scripts/style-check.ts --route` prints the route with its clock and spoken word counts.

## 5. Checklist

- [ ] The title names the thing.
- [ ] The slide makes one claim, and every number has a unit and a source.
- [ ] Identifiers are real at the pinned sha.
- [ ] No banned word or pattern from section 2, including the ones `just style` cannot see.
- [ ] Each note sentence passes the three lenses of section 1.
