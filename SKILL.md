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
    { "name": "sign-in card", "expect": "Welcome back", "shot": { "id": "01-signin", "clip": "main.card" } },
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
`npx playwright install ffmpeg` once. Figures are byte-identical with and without
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

### 4. Read the evidence, not the error

A first run over an unseen page is wrong about a selector. When it fails, the
run writes `failures/<stamp>--<step>.{png,html,txt}`; the `.txt` ends with
`on screen:` — every button and input label the plan could have used. Fix the
plan from that, not from a description of the page.

Other useful flags: `--trace` (open with `npx playwright show-trace`),
`--profile <dir>` (see step 6), `--video-fps`, `--video-size <WxH>`,
`--poster <shot-id>`.

### 5. Sign off, then ingest

Open `captures/<run>/review.html`: every figure with its id, its real pixel size,
the size the app drew on screen, and **the text the plan asserted on that
screen**. If a figure is stale you can see it by reading.

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
- **Every figure carries `expect`.** A screenshot that asserts nothing will
  happily ship a login page over the one you meant.
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
captures/<run>/             figures + review.html + .shots.json + .vars.json
                            (+ .timeline.json and video/ when recorded)
scripts/path-shots.mjs      the runner
lib/human.mjs               how a recorded run is driven: pointer, travel, typing
lib/recorder.mjs            how a recording is made: frames, resampling, ffmpeg
lib/timeline.mjs            where each step started/ended, and the video chapters
lib/ingest.mjs              figures → WebP + manifest
```

Commit plans; ignore runs. When a document needs a figure, reference the run's
file, and record the plan (or the shot id) nearby so the next person knows how to
regenerate it.

## Before you say it is done

- `review.html` opened, every figure checked against its `expect` text.
- If it was recorded, **the video was watched** — at least the chapters, at a
  speed you can tolerate. A recording is the one artefact whose defects are
  invisible in a still: a pointer that rests on the wrong control, a step whose
  scrolling took the point off screen, a `pause` that reads as a freeze.
- The run directory is *outside* the document tree until someone approves it.
- `node lib/ingest.mjs` ran, and the document renders the figure at its CSS size
  (a 4x capture shown at 1x is a waste; shown at 4x it is blurry).
- Any stale prose the new figures contradict was fixed too — a figure that
  disagrees with its caption is worse than an old figure.
