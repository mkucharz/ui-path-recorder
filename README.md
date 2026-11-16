# ui-path-recorder

Record a path through a live UI once, then re-run it whenever the docs go stale.

A walkthrough is one path through an application: open this, type that, click
here, take a picture at the points a reader needs to see. `ui-path-recorder`
keeps that path as a committed JSON file and executes it in a pinned browser, so
the figures in your documentation stop depending on who held the screenshot
tool.

The same path records as a **walkthrough video a person can follow** — pointer,
curved travel, typing cadence, chapters — because a recording of a script, left
alone, is a cut of teleporting stills:

```bash
node scripts/path-shots.mjs plans/railway-installer.plan.json --review
node scripts/path-shots.mjs plans/railway-installer.plan.json --video --review

  01-choose-target           6016x3548   captures/railway-installer-…/01-choose-target.png
  02-authorize-railway       1676x2504   captures/railway-installer-…/02-authorize-railway.png
  …
  video: video/01-main.webm (2418K)
  seed:  railway-v4   (re-run with --seed railway-v4 to replay the same path)
  13 shot(s) written to captures/railway-installer-2026-01-01T10-00-00
  review: captures/railway-installer-2026-01-01T10-00-00/review.html
```

## Why this exists

Every hand-taken documentation screenshot eventually goes wrong in the same few
ways, and all of them are invisible until a reader notices:

- **The operator's language leaks in.** An app with no stored preference resolves
  its UI language from `Accept-Language`. One real page shipped Polish Zitadel
  screenshots on an English tutorial.
- **The operator's theme leaks in.** An app that applies a stored theme after
  first paint gives a shot taken a fraction too early the wrong one.
- **The operator's extensions leak in.** A password manager's autofill menu,
  injected into the page's DOM, lands *inside* the picture.
- **The operator's account leaks in.** Their email, their avatar, their org.
- **Nobody knows how the picture was taken**, so "just re-shoot it" means
  clicking through the flow again from memory — and the prose silently drifts
  away from what the UI now does.

A plan fixes the first four by construction, and the fifth is the whole point of
committing one.

## Install

```bash
npm install                    # playwright-core, plus optional sharp
npx playwright install chromium
npx playwright install ffmpeg  # only for --video
# or point at a browser you already have:
export CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

## Try it in 30 seconds — no account, no network

The repo ships a fixture app that is hostile in the three ways real apps are: a
cookie banner, a control painted before its script hides it, and a second screen
that replaces the first without changing the URL.

```bash
node test/serve.mjs --port 8099 &
FIXTURE_URL=http://127.0.0.1:8099 FIXTURE_PASSWORD=correct-horse \
  node scripts/path-shots.mjs test/plans/fixture.plan.json --review
open captures/fixture-*/review.html
```

Those two environment variables belong to the *fixture plan*, not to the tool:
the plan declares `"baseUrl": "${FIXTURE_URL}"` and `"password": {"env": "FIXTURE_PASSWORD"}`,
so it runs against whatever port the server bound and keeps a credential out of
the committed plan. `${...}` resolves from the plan's `vars`, then the
environment — a real plan names its own, usually `"${INSTANCE_URL}"` and
`{"env": "SHOT_PASSWORD"}`. The password value here is arbitrary; the fixture
accepts anything.

The same flow is recorded as a walkthrough by `test/plans/fixture-video.plan.json`:

```bash
FIXTURE_URL=http://127.0.0.1:8099 FIXTURE_PASSWORD=correct-horse \
  node scripts/path-shots.mjs test/plans/fixture-video.plan.json --video --review --speed 3
open captures/fixture-video-*/review.html   # player + chapters, then the figures
```

`--speed 3` because a natural pace turns this 8-second flow into a 25-second one;
drop it for the real thing.

## A plan

```json
{
  "tutorial": "signin",
  "baseUrl": "${INSTANCE_URL}",
  "locale": "en-US",
  "viewport": { "width": 1600, "height": 900 },
  "colorScheme": "dark",
  "deviceScaleFactor": 4,
  "humanize": { "seed": "signin-v2" },
  "vars": { "email": { "literal": "admin@example.com" } },
  "steps": [
    { "name": "open", "goto": "/login" },
    { "name": "dismiss the cookie banner", "clickIfPresent": { "selector": "#cookie-deny" } },
    { "name": "sign-in card", "expect": "Welcome back", "shot": { "id": "01-signin", "clip": "main.card" } },
    { "fill": { "selector": "#email", "value": "${email}" } },
    { "type": { "selector": "#password", "value": "${password}" } },
    { "click": "#submit" },
    { "waitFor": { "text": "Welcome, admin" } },
    { "expect": "Welcome, admin", "shot": { "id": "02-app" } }
  ]
}
```

Full reference: [`references/plan-format.md`](references/plan-format.md) ·
machine-readable: [`plans/schema.json`](plans/schema.json) ·
a real 62-step flow over a deploy portal, an OAuth consent screen, an installer
and a third-party identity provider:
[`plans/examples/railway-installer.plan.json`](plans/examples/railway-installer.plan.json);
a short store-configurator plan that records the most expensive Mac Studio's
price and fails when Apple changes it:
[`plans/examples/apple-mac-studio-max.plan.json`](plans/examples/apple-mac-studio-max.plan.json).

## What a run writes

```
captures/signin-2026-01-01T10-00-00/
  review.html          ← open this: every figure, its size, the text it asserted
                          (plus the video with chapter links, when there is one)
  01-signin.png        ← the figure, at the capture ratio
  02-app.png
  .shots.json          ← capture ratio per figure (real px → CSS px)
  .timeline.json       ← where each step started/ended, and the video chapters
  .vars.json           ← values scraped off the page, mode 600 (only if setVar ran)
  failures/            ← only on failure: the page, its DOM, and its controls
  trace.zip, video/    ← only with --trace / --video (video/01-main.webm, one per tab)
```

A run directory is *reviewable before it touches a document*. That is the point
of the default: nothing overwrites a published figure until a human has looked at
`review.html`.

## A video a reader can follow

`--video` records the run — which on its own is not worth watching. Playwright's
screencast draws no pointer and dispatches a click the instant the script asks,
so what you get is a cut of teleporting stills. `--video` therefore also drives
the page like a person:

- **A pointer you can see.** An in-page overlay, placed at the coordinates the
  runner actually dispatches. It is a *depiction*, not a capture: it cannot point
  somewhere the plan did not. It is hidden before every screenshot and every
  piece of failure evidence, so a figure is never "evidence with a mouse in it".
- **Travel, not teleport.** A click moves along a curved path with eased velocity
  — a hand does not travel down a ruler line — then dwells on the target before
  pressing, and ripples where it landed.
- **Typing with a cadence.** `fill` becomes click → select-all → one real key
  event per character, with a longer pause after a delimiter and the occasional
  stop to think. A long value (a token, a URL) is typed at the start and pasted,
  which is also what a person does with it.
- **Beats you can read.** A scroll animates, a navigation fades instead of
  flashing white, and the frame a figure was taken from is held long enough to
  read before the next action.

All of it comes from a seeded generator, so a run is replayable: `--seed` (logged
as `seed=…`, default `run-<stamp>`) reproduces the same path and the same typing
rhythm. A video is documentation, so it has to be re-shootable rather than
re-performed. `--speed N` scales every delay (1 natural, 20 a fast test run).

A video is **16:9 by default** — that is the shape of YouTube, of a deck, of a
README embed — and the frame comes from the plan: a plan that pins no viewport
gets 1600×900. **1080p comes from the viewport, not from a flag**: pin the plan at
`{ "width": 1920, "height": 1080 }` and keep `"deviceScaleFactor": 2`, and the
recording is a downscale of a 2× raster — sharp text, no upscaling:

```bash
node scripts/path-shots.mjs plans/example.plan.json --video
  canvas: 1920x1080 @ 25fps   (viewport 1920x1080)
```

`--video-size` *shrinks* the canvas, for a lighter file (a 1440p plan shipped at
1080p, or a 720p teaser), and refuses two canvases that cannot be honoured:
another aspect, or a larger one. Playwright fits the recorded frame inside the
canvas without stretching it and **never scales it up** — anything the frame does
not cover is filled with a solid band — so a bigger canvas does not mean a bigger
picture, it means the page in the corner of a grey field. Both numbers are in
`.timeline.json` as `viewport` and `videoSize`, so a later reader can tell how the
file was made.

Figures do not change: a humanized figure is byte-identical to a plain one, which
the test suite asserts. `--no-humanize` records the raw machine-speed cut when
that is what you want.

Chapters come from `.timeline.json`, so a reviewer opens `review.html` and clicks
"the password is typed in" instead of scrubbing a minute of video — the player
seeks in place, and the figure list stays on screen to compare against:

```
  5. the operator's email is typed in  01-welcome  1.6s · fill
  6. the password is typed in                      3.1s · fill
  7. sign in                                       4.6s · click
```

## The guards

The runner refuses to write a figure when the screen does not prove it is the
right screen. Each of these is a failed run, not a wrong picture:

| Guard | Catches |
|---|---|
| `expect` per figure | the figure is not the screen the document describes |
| language check | the page resolved another locale (`lang="pl"` under an `en-US` plan) |
| theme check | the page painted light under a dark plan — the theme had not settled |
| `waitHidden` | a control the server rendered visible and the script later hides (Alpine/`x-show` first paint) |
| clip validation | the subject selector matched nothing |
| plan validation | a mistyped step key, a duplicate figure id — refused before a browser opens |

On failure the run leaves `failures/<stamp>--<step>.{png,html,txt}`. The `.txt`
ends with `on screen:` — every button and input on the page, so the plan can be
fixed from evidence instead of someone's description of it.

## Flows that need a login — once per machine

```bash
node scripts/path-shots.mjs --login --login-url https://example.com/login --profile .profile
# a visible window opens on a throwaway profile (no extensions, no saved passwords).
# Sign in, clear any human check, press Enter.

node scripts/path-shots.mjs plans/walkthrough.plan.json --profile .profile --review
```

The session stays in `.profile` on that host. It is never exported, committed or
transferred; `.gitignore` covers it. When it expires the run fails at the page
that needed it instead of silently capturing a login form.

Driving this from another host (a Mac you can `ssh` to, while you click in the
window over Screen Sharing) works: pass `--login-done-file /tmp/signed-in`, and
the script waits for that file instead of a keypress.

## Flags

| Flag | |
|---|---|
| `--out <dir>` | run directory (default `captures/<tutorial>-<timestamp>`) |
| `--only <id>` | replay the plan up to that figure and stop |
| `--review` | write `review.html` |
| `--profile <dir>` | keep the session in a profile on this host (implies a visible window) |
| `--login` | open that profile for a human, then exit |
| `--login-done-file <f>` | an agent on another host signals "signed in" with `touch <f>` |
| `--video` | record the walkthrough to `<out>/video/01-main.webm` **and drive it like a person** (needs `npx playwright install ffmpeg`) |
| `--no-humanize` | with `--video`, record the raw machine-speed cut instead |
| `--seed <s>` | seed the humanizer (default `run-<stamp>`, logged as `seed=`) |
| `--speed <n>` | scale every human delay: 1 natural, 20 a fast test run |
| `--video-fps <n>` | video frame rate (default 25) |
| `--video-size <WxH>` | shrink the video canvas (default: the viewport). Must have the viewport's shape and be no larger than it — Playwright never scales a recording up, it pads the canvas with a band, so the run is refused instead. 1080p comes from the plan's viewport (`1920x1080`), not from this flag |
| `--poster <id>` | figure to show in the player before play (default: the first frame) |
| `--trace` | write `<out>/trace.zip`; open with `npx playwright show-trace` |
| `--vars-out <f>` | where `setVar` values go (default `<out>/.vars.json`, mode 600) |
| `--no-trim` | do not crop dead space (needs no `sharp`) |
| `--channel <name>` | launch a specific channel (`chrome`, `msedge`, `chromium`) |
| `CHROME=<path>` | launch a specific binary instead of the bundled browser |

## Figures → web assets

```bash
node lib/ingest.mjs --src captures/signin-2026-01-01T10-00-00 --out public/figures
```

Writes a WebP beside each figure (and to `--out`), plus `manifest.json`:

```json
{ "01-signin.webp": { "width": 2400, "height": 1695, "cssWidth": 600, "cssHeight": 424 } }
```

`width`/`height` are real pixels — they bound how far a figure may be zoomed
before it stops being sharp. `cssWidth`/`cssHeight` are the size the app drew on
screen, which is what a document should size the figure to.

## Use it as an agent skill

`SKILL.md` is written for a coding agent: the workflow, the rules that make a
figure trustworthy, and the failure loop. Install it as a skill in OpenCode,
Claude Code or anything that reads a `SKILL.md` directory:

```bash
git clone https://github.com/mkucharz/ui-path-recorder ~/.config/opencode/skills/path-recorder
```

## Tests

```bash
npm test     # runs the real CLI against the bundled fixture app
```

Thirty-one checks, no network, none that need a real application. The nine
end-to-end ones drive the real CLI against the bundled fixture app: the happy
path (three figures, exact clip widths, a scraped variable reaching a later step,
a mode-600 vars file, the review sheet), `--no-trim`, and the refusals that must
happen — a stale assertion, the wrong language, an unsettled theme, a mistyped
plan key, a mistyped `humanize` knob, an `--only`/`--poster` that names nothing —
plus the "missing env var" message. Four cover the video path: the recording and
its `.timeline.json` (named files, chapters that only move forward, the pointer
hidden for every figure), a *recorded* run's figures being byte-identical to a
plain run's, `--no-humanize`, and the same seed reproducing the same scheduled
delays. Eighteen are unit tests with no browser: twelve for the humanizer
(seeded replay, travel ending on the target, click order, long-value paste,
hide/show) and six for the timeline (chapter order and tab, a chapter timed from
its own tab's recording, times relative to the start of the recording, the file
matching what it reported).

## Docs

- [`references/plan-format.md`](references/plan-format.md) — every step kind
- [`references/authoring.md`](references/authoring.md) — writing a plan for an
  app you have never captured
- [`references/gotchas.md`](references/gotchas.md) — the incidents behind the
  guards, and what still needs a human

MIT.
