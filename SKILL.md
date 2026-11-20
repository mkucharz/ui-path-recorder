---
name: path-recorder
description: Record a reproducible path through a live UI and turn it into documentation-quality figures — a tutorial walkthrough, a runbook, a release-note screenshot set — or a walkthrough video a person can actually watch. Use when asked to capture screenshots of a web app, re-shoot stale docs figures, build a screenshot pipeline for a tutorial, record a demo/walkthrough video of a flow, or write a scripted UI walkthrough that a human signs into once and then runs unattended. Handles login walls, cookie banners, theme/locale pinning, clipping to the subject, reviewable run directories, failure evidence, and humanized recording (visible pointer, curved travel, typing cadence, seeded and replayable).
---

# path-recorder

A walkthrough is one path through a UI. This skill scripts that path once, so
the figures in a document are reproducible instead of depending on who held the
screenshot tool: their language, their theme, their password manager, their
already-signed-in account in the corner.

Two artefacts per walkthrough:

| | |
|---|---|
| `plans/<name>.plan.json` | the path, as data — committed, reviewed, diffed |
| `captures/<run>/` | one run's figures, `review.html`, failure evidence — never committed |

With `--video` there is a third: the run directory also holds the walkthrough as
a recording a person can watch, driven at human pace with a visible pointer.

## Setup

Once per checkout, from the directory that holds this file:

```bash
npm install && npx playwright-core install chromium   # ffmpeg only for --video
```

`node scripts/path-shots.mjs` resolves `playwright-core` from that
`node_modules`, so a skill unpacked from a release tarball needs this before its
first run. If a browser is already on the machine, `CHROME=/path/to/chrome`
skips the download.

`playwright-core`, not `playwright`: a bare `npx playwright` would fetch a
different Playwright from the registry whose browser build need not be the one
this tree pins, and it fails at launch with `Executable doesn't exist …`. The core
package's CLI installs the revision `package.json` pins.

## When to use

- A tutorial, guide or runbook needs figures of a real product.
- Figures exist but are stale, and "re-shoot them" should not mean a human
  clicking around.
- A UI flow must be proven to still work (the guards fail the run when it does
  not) — a poor man's end-to-end test that leaves pictures behind.
- A flow needs authentication: a person signs in **once**, then every re-capture
  is scripted.

Not for: pixel-diffing a design system, load testing, or anything that needs to
assert on behaviour rather than on what a reader will see — use Playwright tests
for that, and this tool for the pictures.

## The loop

### 1. Find out what the flow actually is

Do not write a plan against a remembered UI. Read the source if you have it
(the portal's `#deploy`, `#success-card` come from its templ/handlebars files —
selectors from source are not guesses), or open the page and read it. Only then
write steps.

### 2. Write the plan

Start from `plans/examples/railway-installer.plan.json` — a 62-step plan over a
deploy portal, an OAuth consent screen, an installer and a third-party identity
provider. For a short plan whose subject is a live value, see
`plans/examples/apple-mac-studio-max.plan.json` — nine steps through a store
configurator, with the price in one `vars` literal so a price change fails the
run. Keep plans small: one screen, one step, one figure.

Minimum viable plan:

```json
{
  "tutorial": "signin",
  "baseUrl": "${INSTANCE_URL}",
  "locale": "en-US",
  "viewport": { "width": 1600, "height": 900 },
  "colorScheme": "dark",
  "deviceScaleFactor": 4,
  "vars": { "email": { "literal": "admin@example.com" } },
  "steps": [
    { "name": "open", "goto": "/login" },
    { "name": "sign-in card", "expect": { "selector": ["#email", "#password"] }, "shot": { "id": "01-signin", "clip": "main.card" } },
    { "fill": { "selector": "#email", "value": "${email}" } }
  ]
}
```

Every step kind is in [`references/plan-format.md`](references/plan-format.md).
A mistyped key is refused before a browser opens, so guessing a key name is
safe: it fails loudly.

### 3. Run it

```bash
node scripts/path-shots.mjs plans/<name>.plan.json --review
```

Default output is a **fresh run directory** `captures/<tutorial>-<timestamp>/`,
so a capture never overwrites a document's figures before someone has looked at
them. Add `--only <shot-id>` to replay the plan up to one figure.

`--video` records the walkthrough **and drives the page like a person**: a
visible pointer travelling along a curved path, a dwell before each press, typing
a character at a time, and a beat of stillness on each figure. It needs
`npx playwright-core install ffmpeg` once. Figures are byte-identical with and without
it — the pointer is hidden for every capture — so the only thing it changes is
pacing, which is why it is on by default for a recording.

Everything it does comes from a **seed**, logged on the run as `seed=…`. Pin it
in the plan (`"humanize": { "seed": "install-v3" }`) so a re-shoot reproduces the
same path, and use `--speed 20` while iterating on selectors (a natural pace
turns a 30-second flow into four minutes). `--no-humanize` records the raw
machine-speed cut.

A recording is **16:9 by default** — YouTube, a deck, a README embed — because the
frame comes from the plan and a plan that pins no viewport gets 1600×900. For a
1080p upload pin the plan's viewport at `{ "width": 1920, "height": 1080 }` and
keep `"deviceScaleFactor": 2`: the canvas is then a downscale of a 2× raster.
`--video-size` only shrinks (a 1440p plan shipped at 1080p); a larger canvas, or
one of another shape, is refused before the browser opens, because Playwright
never scales a recording up — it fills the rest of the canvas with a band.

The recording is made of pictures the page actually painted. Taking a figure
changes what Chromium is capturing for one frame, and Playwright's own recorder
pads that frame with grey, which reads as a blink of a half-drawn page. The runner
captures the frames itself and drops the ones that are not the page's shape,
holding the frame before them across the gap; `frames dropped: N` in the log says
how many, and it is normally a small number.

A recorded plan can also **narrate itself**: `"caption": "…"` on a step is drawn
into the picture for that step (a bottom-centre pill, hidden for every figure) and
written beside the recording as `video/01-main.vtt`, so the video reads in any
player and the subtitles stay switchable, searchable and translatable. The
sentence belongs in the plan next to the step it describes — afterwards, in a
video editor, it is a claim nobody checks. `--no-humanize` has no overlay to draw
with, so it writes the track only and warns; see `references/plan-format.md` →
`caption`, and `plans/examples/signin-captions.plan.json`.

And it can **speak**: `--narration` (or `"video.narration"` in the plan) reads
each step aloud and muxes the voice into the recording. Two engines speak it:
macOS `say` by default (no install, no key, no network), or ElevenLabs over HTTPS
with `--narration-engine elevenlabs` and `ELEVENLABS_API_KEY` in the environment or
a gitignored `.env` — never in the plan. A step's `say` defaults to its `caption`,
so the pill, the `.vtt` and the voice agree; write a `say` when the heard sentence
and the read line should differ, and the `.vtt` then transcribes the speech while
the pill keeps the short caption. Write it as speech: a caption read aloud is a
label, and the run warns about the shortest ones. Narration is a two-pass run —
lines are synthesized before the browser opens, and the step that starts a cue
waits `max(hold, line + tailMs)`, or only the rest of its own sentence with
`"fit": "line"` — which is why `--narration` needs `--video`, the humanizer and
`--speed 1`. It also needs a system ffmpeg with libopus (Playwright's bundled one
is video-only), and it refuses to run without one before opening a browser.
ElevenLabs lines are requested with their neighbours attached, so consecutive
steps read as one telling, and the delivery is the plan's
(`stability`, `style`, `similarityBoost`, `speakerBoost`). To pick a voice instead
of accepting the default, `node scripts/voice-audition.mjs` renders variants into
one page meant to be listened to.
`--no-narration` records a silent copy of a narrated plan (its `.vtt` falls back
to the captions, since no voice was spoken); `--narration-engine`,
`--narration-model`, `--voice`, `--rate` and `--narration-tail` override the
block. See `references/plan-format.md` → `say` and `video.narration`.

A recording can also **tick a checklist off beside it**: `"check": "…"` on a step
adds that row to a small panel, ticked the moment the step starts. The rows are
the steps — there is no list in the plan to drift — and the panel is hidden with
the pointer for every figure, so the figures stay byte-identical.

It has two layouts. `"layout": "overlay"` (default) floats a translucent card over
the app and changes nothing about the page. `"layout": "dock"` reserves a column
of its own and lays the page out beside it, so nothing is covered and a 1920×1080
frame is a real 16:9 composition — that is the one to use when the recording is
going to a video player. `side` is `right` or `left` in either layout, and a dock
takes that edge from the page. `"containFixed": true` on a dock makes the page
column the containing block for fixed descendants of `body` (dialogs, sheets,
portals), so a centred overlay follows the app column instead of the whole frame;
it is opt-in because the body transform changes fixed-position behaviour. `video.checklist` sets its heading, the short
second line under it (`subtitle`), side, width, layout and tick colour; a viewport
under 1280 px warns about the share the panel takes, and a dock that leaves the
app under 1280 px warns again. See `references/plan-format.md` → `check`, and
`plans/examples/signin-checklist.plan.json` (overlay) or
`plans/examples/signin-sidebar.plan.json` (docked, 1920×1080).

And it can **open and close on a card**: `video.intro` says what the walkthrough
is for before the app appears, `video.outro` closes on the same checklist filled
in. A card is plain HTML shown in the page — not an overlay — so it survives
`--no-humanize`, and it needs `--video` to be recorded at all. Both carry the
checklist the panel ticks (`0 / N` in, `N / N` out) and take the theme from
`colorScheme`; `cardMs` sets the hold (2200 ms, divided by `--speed`). See
`references/plan-format.md` → `video.intro`, and
`plans/examples/signin-walkthrough.plan.json` for the whole package in one plan.

Both the panel and the cards take a **palette**: `"theme": "memory"` names a preset
shipped in `themes/` (the Memory web UI's dark colours), and `"tokens"` overrides
any of the sixteen `--pc-*` properties it sets. Two more presets ship alongside
it — `"dracula"` and `"catppuccin-mocha"` (Catppuccin's mocha flavour; the light
`latte` is deliberately not offered, because the panel is dark by design) — and
each carries only what its upstream palette documents: colours, not a radius or a
font. Tokens are CSS custom properties
rather than utility classes because the chrome is drawn over an app whose
stylesheet this repo does not own — a class only exists on a page that happens to
define it, a value always does. A token may read the app's own palette
(`{ "--pc-accent": "var(--color-primary)" }`) when recording a themed app, while a
preset holds literal values so it renders on a page with no CSS of its own. A plan
that names neither draws exactly the chrome it always drew. See
`references/plan-format.md` → `video.theme`.

### 4. Read the evidence, not the error

A first run over an unseen page is wrong about a selector. When it fails, the
run writes `failures/<stamp>--<step>.{png,html,txt}`; the `.txt` ends with
`on screen:` — every button and input label the plan could have used. Fix the
plan from that, not from a description of the page.

Other useful flags: `--trace` (open with `npx playwright-core show-trace`),
`--profile <dir>` (see step 6), `--video-fps`, `--video-size <WxH>`,
`--poster <shot-id>`, `--narration` / `--no-narration`, `--narration-engine`,
`--narration-model`, `--voice`, `--rate`, `--narration-tail`.

### 5. Sign off, then ingest

Open `captures/<run>/review.html`: every figure with its id, its real pixel size,
the size the app drew on screen, and **the text the plan asserted on that
screen**. If a figure is stale you can see it by reading.

The figures are also a **slideshow**, in the run's order: `←`/`→` walk them, a
click on a thumbnail jumps to one, `#fig-2` in the URL points at a single slide,
and `Present` goes full screen (there a click on the figure is the next button).
What a slide says is the tile's own record — id, both sizes, the step, the
asserted text — so stepping through the run in order is how you notice that step
4's figure shows step 5's screen. The stage is a fixed 16:9 frame, the shape of
the recording itself: a portrait crop and a wide app shot cannot resize it, so
the page does not jump as you step.

When the run recorded a video, the same page carries the player and a chapter
list built from `.timeline.json` — clicking a chapter seeks the player in place
(`01-main.webm#t=4.6`, and a second tab's chapters seek that tab's recording), so
checking that the pointer follows the flow is a click, not a scrub. Also in the
run: `.timeline.json` with every step's start/end, its action and its scheduled
delay.

Then:

```bash
node lib/ingest.mjs --src captures/<run> --out public/figures
```

writes a WebP per figure plus `manifest.json` with `width`/`height` (real
pixels, bounds the zoom) and `cssWidth`/`cssHeight` (what the document should
size the figure to).

### 6. A flow that needs a login — once per host

```bash
node scripts/path-shots.mjs --login --login-url https://example.com/login --profile .profile
#   a visible browser window opens; sign in; press Enter in the terminal
node scripts/path-shots.mjs plans/<name>.plan.json --profile .profile --review
```

The session stays in `.profile` on that host and is never committed or
transferred. When it expires the run fails at the page that needed it — it never
quietly captures a login form. An agent on another host can drive this: pass
`--login-done-file /tmp/signed-in` and the script waits for that file instead of
a keypress, so the human signs in and an agent on the machine doing the work
touches the file.

## Rules that make a figure trustworthy

These are not style preferences; each one prevents a wrong picture reaching a
document. The runner enforces them, so a breach is a failed run.

- **Pin `locale`, `colorScheme`, `deviceScaleFactor`.** A page that renders
  another language fails the run. A dark plan whose page paints light fails the
  run. The classic disaster: an `Accept-Language` leaking the author's language
  into a published figure.
- **Every figure carries a guard.** `expect` names the element ids the figure
  depends on; a text guard is for words the document makes a claim about. A
  screenshot that asserts nothing will happily ship a login page over the one you
  meant, and a label-based guard fails on a translation you did not make.
- **`waitHidden` before the shot** for chrome the server renders visible and the
  page's script hides on boot — otherwise the figure shows a control readers
  never see. (And when the flash is a product bug, fix the product; the guard is
  a seatbelt, not the fix.)
- **Clip to the subject** (`"clip": "<selector>"`) rather than shipping a
  viewport-wide frame with a small card in it. A selector clip is exact and
  repeatable: same width every run, so a drifting crop is visible as a diff.
- **Leave breathing room around the subject.** A clip that lands on a card's
  border looks cropped: the border is the edge of the figure, the heading loses
  its leading, a shadow is sliced. Selector clips are padded (`"pad"`, default
  32 CSS px) so every figure has margin; go up to 48–64 for dense cards and
  shadows, and keep one `pad` across a figure set so the margins line up. A
  measured-rect clip carries its own padding — include it in the numbers.
- **Never commit a capture or a profile.** `captures/` and `.profile/` hold
  session cookies in the worst case and megabytes in the best.
- **Neutral data beats a mask.** `admin@example.com` reads better in a figure
  than two black rectangles — put the alias in the plan's `vars` as a `literal`.
  Mask (`"mask": ["#email"]`) only for something that must be real and must not
  be published.
- **A value the page reveals goes through `setVar`**, not into the plan and not
  into an env var you hand-copy: an installer's one-time password is read from
  the screen it was printed on. It lands in `captures/<run>/.vars.json` (mode
  600) so a run that fails *after* an expensive setup step can be retried
  without repeating it.

More of these, with the incident behind each: [`references/gotchas.md`](references/gotchas.md).

## Where things live

```
plans/<name>.plan.json      the committed path
plans/schema.json           machine-readable plan contract
themes/<name>.json          a chrome palette a plan names with video.theme
examples/signin/            a demo app the example plans run against
captures/<run>/             figures + review.html + .shots.json + .vars.json
                            (+ .timeline.json and video/ when recorded)
scripts/path-shots.mjs      the runner
scripts/voice-audition.mjs  the same six lines several ways, to pick voice, copy and delivery by ear
scripts/check-panel-theme.mjs  presets: shape, and drift against a product's app.css
.env.example                the shape of the gitignored `.env` (the ElevenLabs key lives there)
lib/human.mjs               how a recorded run is driven: pointer, travel, typing
lib/recorder.mjs            how a recording is made: frames, resampling, ffmpeg
lib/captions.mjs            a step's subtitle → the pill in the picture and its .vtt
lib/narration.mjs           a step's line → speech (say or ElevenLabs), its place on the track, and the mux
lib/checklist.mjs           the rows a recording ticks: derived from steps, drawn by human.mjs
lib/cards.mjs               the intro and end cards: a whole screen of HTML, checklist included
lib/theme.mjs               the chrome palette: the --pc-* vocabulary, defaults, presets
lib/timeline.mjs            where each step started/ended, and the video chapters
lib/ingest.mjs              figures → WebP + manifest
```

Commit plans; ignore runs. When a document needs a figure, reference the run's
file, and record the plan (or the shot id) nearby so the next person knows how to
regenerate it.

## Before you say it is done

- `review.html` opened, every figure checked against its guard — the ids it
  required, and the text if the plan asserted any.
- If it was recorded, **the video was watched** — at least the chapters, at a
  speed you can tolerate. A recording is the one artefact whose defects are
  invisible in a still: a pointer that rests on the wrong control, a step whose
  scrolling took the point off screen, a `pause` that reads as a freeze.
- If it was narrated, **the sound was listened to**: every line is audible and
  finishes before its screen changes. A line that is cut off, or that starts
  before the screen it describes, is reported by the run as a warning — read the
  log, then fix the plan (a shorter `say`, a bigger `hold`, a neighbour to fold
  the guard into) rather than re-recording and hoping.
- The run directory is *outside* the document tree until someone approves it.
- `node lib/ingest.mjs` ran, and the document renders the figure at its CSS size
  (a 4x capture shown at 1x is a waste; shown at 4x it is blurry).
- Any stale prose the new figures contradict was fixed too — a figure that
  disagrees with its caption is worse than an old figure.
