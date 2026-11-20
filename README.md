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

As an agent skill — the way this is meant to be used, because the part that needs
judgement (find the flow, decide which moments a reader needs, read the failure,
publish the figures) is the agent's half:

```bash
npx skills add mkucharz/ui-path-recorder --skill path-recorder -g
```

Pin a release instead of a branch when the plan matters more than the novelty —
`…ui-path-recorder@v0.5.0`. The tarball attached to
[the releases](https://github.com/mkucharz/ui-path-recorder/releases) unpacks to
`path-recorder/SKILL.md`, for an agent that installs by folder.

The CLI on its own:

```bash
npm install                         # playwright-core, plus optional sharp
npx playwright-core install chromium
npx playwright-core install ffmpeg  # only for --video
# or point at a browser you already have:
export CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

`playwright-core`, not `playwright`: this tree depends on the core package, and a
bare `npx playwright` fetches a *different* Playwright from the registry whose
browser build need not be the one `package.json` pins — which fails at launch with
`Executable doesn't exist … chromium-<n>`. The core package's own CLI installs the
exact revision, so the number always matches.

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

## Try it against a sign-in screen

`examples/signin` is a small app in the shape of yours: a sign-in card, a
workspace behind it, and the copy in English and Norwegian. It exists so a plan
can be read and re-run without an account or a network call.

```bash
node scripts/serve-example.mjs            # http://127.0.0.1:8100
```

In a second terminal:

```bash
SIGNIN_URL=http://127.0.0.1:8100 \
  node scripts/path-shots.mjs plans/examples/signin.plan.json --review

SIGNIN_URL=http://127.0.0.1:8100 \
  node scripts/path-shots.mjs plans/examples/signin-nb.plan.json --review
```

The two plans are the same path. Only `tutorial`, `locale` and the `lang` var
differ, and no assertion is translated: the guards name element ids.

The server also serves the app *after* it changed. `--variant refreshed` is a
copy-only change — the same plan passes and the figures are new. `--variant
broken` replaces the password field with an emailed link — the same plan fails,
naming the id it lost. The plan is pointed at a different build; it never learns
which one it is looking at.

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
    { "name": "sign-in card", "expect": { "selector": ["#email", "#password"] }, "shot": { "id": "01-signin", "clip": "main.card" } },
    { "fill": { "selector": "#email", "value": "${email}" } },
    { "type": { "selector": "#password", "value": "${password}" } },
    { "click": "#submit" },
    { "waitFor": { "selector": "#dashboard" } },
    { "expect": { "selector": "#dashboard" }, "shot": { "id": "02-app" } }
  ]
}
```

Full reference: [`references/plan-format.md`](references/plan-format.md) ·
machine-readable: [`plans/schema.json`](plans/schema.json) ·
a sign-in card in two languages:
[`signin.plan.json`](plans/examples/signin.plan.json) and
[`signin-nb.plan.json`](plans/examples/signin-nb.plan.json);
a real 62-step flow over a deploy portal, an OAuth consent screen, an installer
and a third-party identity provider:
[`plans/examples/railway-installer.plan.json`](plans/examples/railway-installer.plan.json);
a short store-configurator plan that records the most expensive Mac Studio's
price and fails when Apple changes it:
[`plans/examples/apple-mac-studio-max.plan.json`](plans/examples/apple-mac-studio-max.plan.json).

## What a run writes

```
captures/signin-2026-01-01T10-00-00/
  review.html          ← open this: every figure, its size, the text it asserted,
                          and a slideshow that walks them in the run's order
                          (plus the video with chapter links, when there is one)
  01-signin.png        ← the figure, at the capture ratio
  02-app.png
  .shots.json          ← capture ratio per figure (real px → CSS px)
  .timeline.json       ← where each step started/ended, and the video chapters
  .vars.json           ← values scraped off the page, mode 600 (only if setVar ran)
  failures/            ← only on failure: the page, its DOM, and its controls
  trace.zip, video/    ← only with --trace / --video (video/01-main.webm, one per tab,
                         and 01-main.vtt beside it when the plan has captions)
```

A run directory is *reviewable before it touches a document*. That is the point
of the default: nothing overwrites a published figure until a human has looked at
`review.html`.

That sheet holds the same figures twice, because two different questions are
asked of them. The contact sheet answers *is this the right picture* — id, real
pixels, the size the app drew on screen, and the text the plan asserted. The
slideshow answers *does the path read in order*, which is the reviewer's actual
job: `←`/`→` walk the figures one at a time, a thumbnail jumps to one, `#fig-2`
in the URL points at a single slide, and `Present` goes full screen with a click
on the figure as the next button. A slide's caption is the tile's own record, so
the two views cannot disagree.

The player is a **fixed 16:9 frame** — the shape a video player uses, and the
shape the recording already is. A portrait crop followed by a wide app shot would
otherwise resize the stage on every step, which reads as the page jumping rather
than the figure changing; inside the frame a figure is letterboxed at its own
proportions and never enlarged past its pixels. `Present` keeps the same frame on
whatever it is shown on.

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

**A frame the page never painted is dropped, not padded.** Taking a figure changes
the surface Chromium is capturing for a moment, and the screencast is shared, so
one frame in a few hundred can arrive with the page laid out for a different
viewport — a phone-width column, or the whole page shrunk into the corner.
Playwright's own recorder fills the difference with grey, which a viewer sees as a
single-frame flash of grey field with the page in it. This runner therefore
records the frames itself (`page.screencast` plus its own ffmpeg invocation, see
`lib/recorder.mjs`), drops any frame whose size or reported viewport differs from
the recording's, and holds the frame before it across the gap. The count is in the
log, so a video is not silently missing time:

```
  frames dropped: 3   (the page rendered at another size mid-step; the frame before covers the gap)
```

**Chrome the page paints and then hides is part of the page, not of the video.** A
bulk-action bar, a locale switcher, an `x-show` panel that is visible until its
script boots: a recording that starts any earlier opens on something a reader of
the app never sees. In a plan the answer is `waitHidden`; when the page is your
own demo, do not paint it — the bundled fixture keeps its "Delete selected" bar
behind `?flash=1` for that reason. A site that keeps a dismissal in storage
(apple.com's country bar) is pinned with `themeStorage` before the first frame.

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

### Subtitles come from the plan

A walkthrough watched without sound still has to say what it is doing, and that
sentence belongs next to the step it describes — not typed into a video editor
afterwards, where it drifts off the screen it was written for:

```json
{ "name": "fill the email", "caption": "Type the email address on your account.", "fill": { "selector": "#email", "value": "${email}" } }
```

One `caption` produces two artefacts that cannot disagree, because both are timed
by the step's own clock:

- the recording **draws it in the page** — a bottom-centre pill, sized from the
  viewport — for the whole step, so the video explains itself anywhere it plays,
  including a player that ignores sidecar tracks;
- `video/01-main.vtt` beside the recording, which is what a `<video><track>`, a
  docs site or a video host reads: switchable off, searchable, translatable
  later. The review sheet's player carries it as a captions track — off by
  default, because the recording already draws its subtitles in and a default
  track would paint a second one over the same corner. Switching it on is how you
  check the file's timing against what is on screen. A narrated run transcribes
  the `say` here instead (see [Spoken narration](#spoken-narration)): a track that
  disagrees with the voice is unusable with the sound off.

A step with no caption clears the last one, so a subtitle never outlives the
screen it described; consecutive steps sharing a caption are one cue, so it does
not blink between them. The pill is hidden with the pointer for every figure and
every piece of evidence — a picture is evidence, a subtitle is a depiction — which
is why a captioned run's figures stay byte-identical to a plain run's.

`--no-humanize` records the raw cut, and the raw cut has no overlay to draw with:
the `.vtt` is still written, and the run says so rather than leaving you to find
out from the recording:

```
  warning: 5 step(s) carry a caption; --no-humanize leaves it to the .vtt track
```

`plans/examples/signin-captions.plan.json` is the shipped example.

### Spoken narration

A walkthrough a person watches on a phone, in a taxi, on a train: the screen
explains the *steps*, and nothing says why. `--narration` speaks each step and
muxes the voice into the recording.

```json
{
  "video": { "narration": { "voice": "Ava", "rate": 180 } },
  "steps": [
    { "caption": "Sign in.", "say": "Sign in with the account you already use — this walkthrough installs into your own workspace.", "goto": "/signin" }
  ]
}
```

`video.narration` is the plan asking for narration, and its presence is enough:
`--narration` forces it on for a plan that omits the block, and `--no-narration`
records a silent copy of a narrated plan without editing the file — silence, so
its `.vtt` falls back to the `caption`s rather than transcribing a voice nobody
hears.

**One text does both jobs unless you split it.** A step's `say` defaults to its
`caption`, so the pill, the `.vtt` and the voice say the same thing and cannot
disagree. Write a `say` when the spoken sentence and the on-screen line should
differ — a sentence is *heard* over three seconds, a subtitle is *read* at a
glance — and then the `.vtt` transcribes the **speech**, because a captions track
that says something other than the voice is a track nobody can use with the sound
off. The pill keeps the short `caption`.

**A caption read aloud is not a sentence.** The default makes the split optional,
not free: `"Choose Sign in."` is a good pill and an abrupt thing to hear, and six
of them in a row sound like a form reading itself out. The line to write is the
one you would say while pointing at the same screen — the verb the viewer is
doing, something they already know ("the account you already use"), and what
happens next ("… and you're in"). The run names the two shapes worth a second
look and still speaks what it was given:

```
  warning: step #4 (fill the password) is spoken as "Then the password." — a label, not a sentence. …
  warning: step #5 (sign in) is written as an instruction to a control: "Click the Sign in button". …
```

**The picture waits for the sentence.** A spoken line runs two to five seconds
and a step is often shorter, so narration is a *two-pass* run: every line is
synthesized before the browser opens, and each step's beat becomes
`max(hold, line + tail)` — the step owes only the part of its sentence it has
not already spent, and `tailMs` (400 ms) is the silence after it so the next
screen never arrives on the last word:

```
  narration: 6 lines, voice Ava @ 180 wpm, 400ms tail, fit hold
    spoke   1/6  2.2s  "Open the sign-in page for your workspace."
    spoke   2/6  2.8s  "Sign in with the address and password you already use."
  captions: video/01-main.vtt (6 cues)
  narration: video/01-main.webm (13.4s of track)
```

That `max` is the one thing that keeps a good plan sounding slow. A `hold` is
written for a silent recording — it is how long a viewer needs to read a change —
and once the line explains the change the same 1.6 s is dead air on top of a
sentence that already made the point. `"fit": "line"` hands the step's length to
its own copy: the step waits only for the rest of its own sentence
(`max(0, line + tailMs − elapsed)`), so the walkthrough is as long as it has
something to say.

Measured on the sign-in example with a 6 s `hold` on every step — the shape a plan
tuned to a silent recording has — the same plan, voice and six sentences:

| `fit` | recording | speech | padding |
|---|---|---|---|
| `hold` (default) | 49.8 s | 20.1 s | 29.7 s |
| `line` | 28.6 s | 20.1 s | 8.5 s — 21 s gone |

```json
"video": { "narration": { "engine": "elevenlabs", "fit": "line" } }
```

`fit` is `hold` by default, because a plan that has been tuned to a silent
recording should not change length when narration is switched on; set `line` in a
plan written to be narrated, and keep `hold` where a step's stillness is doing
work of its own.

Two warnings cover the plan shapes that still drift, and both name the step:

```
  warning: video/01-main.webm: the line at 4.2s runs 1.1s past its step, so the next screen arrives mid-sentence
  warning: video/01-main.webm: the line at 9.7s starts 0.6s before the one before it ends, in video/01-main.webm — they will talk over each other
```

The audio is placed **by cue, not by step** — the same cues the `.vtt` is built
from — so consecutive steps sharing a caption are spoken once, at their first
frame, and the later steps do not wait a second time for a sentence that has
already been said. That is per **recording**, not per plan: a `clickNewPage` step
opens a second tab with its own `.vtt`, so a line repeated there is a new cue and
waits for its own audio. Lines are cached by content (`sha256` of the engine,
model, voice, rate and text, in `~/.cache/ui-path-recorder/narration`, or
`UI_PATH_RECORDER_CACHE_DIR`), so re-recording after editing one caption re-speaks
one line — and the same words in two engines are two entries, not one. For
ElevenLabs the delivery and the surrounding sentences are in that hash too, so
editing a line re-speaks it and its two neighbours and nothing else.

**Two engines, one pipeline.** The default is macOS `say`, because it is part of
the OS: no install, no key, no network. `--narration-engine elevenlabs` speaks
each line over HTTPS instead, which is what a Linux host or CI uses, and what
gives you a choice of voice on a Mac too. Only the synthesis differs — pacing,
the `.vtt`, the cache and the mux are shared, so a line is timed the same way
whichever engine said it.

ElevenLabs needs `ELEVENLABS_API_KEY` — from the environment, or from a
gitignored `.env` in the directory the run starts in (copied from
`.env.example`). The file is the safer of the two: a key exported in a shell is a
key in a shell history, and an environment variable in a CI log is a key in a CI
log. Nothing here prints the value, and `.gitignore` keeps the file out of git.
It takes `--narration-model` (default `eleven_multilingual_v2`) and a voice that
is a name or an id. A name is resolved against the voices the key can see, which
needs the `voices_read` permission; an id is used as given, so a key scoped to
text-to-speech alone works. `ELEVENLABS_VOICE_ID` sets the default voice, and a
premade one is used when neither is given. `--rate` becomes the API's
`voice_settings.speed` (`180` → `1.0`) and is clamped to the `0.7`–`1.2` it
accepts, with a warning when that happens.

**Lines are read as one telling, not six recordings.** Each request carries the
sentence before and after it as `previous_text` / `next_text`, which is what keeps
the cadence and the emphasis moving across the step boundaries instead of every
line starting cold on a full stop; `apply_text_normalization` is `on`, so "7
days" is spoken as words. The **`eleven_v3` family** (`eleven_v3`,
`eleven_v3_conversational`, `eleven_v3_directorial`) rejects both with
`unsupported_model`, so stitching is per model and the run says so when it has to
fall back; `eleven_v4` accepts them and keeps the cadence. The delivery is the
plan's, spelled out in full rather than left to the account's defaults:

```json
"video": {
  "narration": {
    "engine": "elevenlabs",
    "stability": 0.35,
    "style": 0.1,
    "similarityBoost": 0.75,
    "speakerBoost": true
  }
}
```

`stability` is the knob worth reaching for first. High values hold one flat
reading; lower values let the sentence carry emphasis, which is most of the
difference between a walkthrough that sounds told and one that sounds recited.
Below about 0.3 the reading starts to drift between takes, so the useful range is
narrow. They are ignored by `say`, and a plan that sets them without
`"engine": "elevenlabs"` is warned about rather than silently doing nothing.

Each line is requested as raw 48 kHz PCM, so nothing has to decode it, and cached
like a `say` line — by engine, model, voice, rate, wording, *delivery* and
neighbours, because a different stability or a different sentence before it is a
different reading, and a cache hit on the old one would hand back audio the plan
no longer describes.

A free workspace cannot use **library** voices through the API — it answers
`402 paid_plan_required`. The default is deliberately a premade voice, and the
error names it, so the fix is one flag rather than an upgrade.

**Choosing a voice is done by ear.** `scripts/voice-audition.mjs` speaks the six
sign-in steps eight ways — the shipped copy and four rewrites of it, two models,
two stabilities, two voices — and writes the WAVs beside one page with a player
per variant, so a plan's voice, copy and delivery are chosen by listening instead
of by reading a description of them. Audio only, because that is what is being
chosen; the winner is recorded once, afterwards:

```bash
node scripts/voice-audition.mjs --out captures/audition
```

It is an ElevenLabs tool, and needs the key like the engine does — `say` has one
voice per host, which is the opposite of an audition. The variants are a table at
the top of the script: change the copy, the voice id or the stability and run it
again.

**What it needs, and what it refuses.** The mux is a **second ffmpeg pass** that
copies the video stream and adds Opus — which must be a *system* ffmpeg, because
the build Playwright downloads is video-only (`ffmpeg-1011`/`ffmpeg-1013` expose
`png`, `libvpx` and `libvpx-vp9` and no audio codec at all). A run that asks for
narration without the pieces fails before the browser opens, naming the fix:

```
  narration needs a system ffmpeg with libopus: the bundled one Playwright
downloads is video-only (it encodes png and vp9 and has no audio codec at all).

  macOS: brew install ffmpeg      Linux: apt-get install ffmpeg
```

It also refuses the three runs in which the voice could not stay in step: without
`--video` (nothing to narrate), with `--no-humanize` (the voice is paced by each
step's beat, and the raw cut has none), and with `--speed` other than 1 (the beat
is scaled and the recording is not, so anything else drifts the two apart). The
first of those is a refusal only for an explicit `--narration`: a plan that
carries `video.narration` in a figure run warns and records the figures, the way
`video.intro` is ignored there.

The mux copies rather than re-encodes, so a failure leaves the original file
untouched and only costs the sound:

```
  warning: video/01-main.webm: narration was not muxed (…) — the video is silent
```

`say`'s audio is **not byte-reproducible across macOS releases**, so a narrated
recording is re-shootable but not byte-identical: pin `voice` and `rate`, and
expect the cache to return the same audio rather than to promise a fresh line
would match it. The video-only path is untouched by any of this — a run without
narration produces the file it always did.

`--narration-engine <say|elevenlabs>`, `--narration-model <id>`, `--voice <name>`
and `--rate <wpm>` override the block, and `--narration-tail <ms>` overrides the
tail. `fit` and the four delivery keys have **no flags**: they are plan settings,
because a one-off override of the thing that decides how a voice sounds is a run
you cannot reproduce. Any captioned plan narrates as it stands:
`plans/examples/signin-captions.plan.json` is the one to try.

### The checklist ticks itself off beside the video

A subtitle says what the step is doing; nothing yet says what is left. A small
panel on the side does, and — like the subtitle — the rows come from the plan
rather than from an editor:

```json
{ "name": "fill the email", "check": "Sign in with your email", "caption": "Type the email address on your account.", "fill": { "selector": "#email", "value": "${email}" } }
```

The panel's rows *are* the steps that carry a `check`, in first-appearance order,
so there is no second list to drift: re-order the plan and the panel re-orders,
drop a step and its row goes with it. Each row ticks with a small draw-on check
and a strike-through the moment its step starts — the same beat as that step's
subtitle, so the row and the voice change together.

```
  WHAT YOU'LL DO
  Four steps, one workspace
  ✓ Open your workspace
  ✓ Sign in with your email
  ○ Enter your password         1 / 4
```

The heading and the short line under it are `title` and `subtitle` on
`video.checklist`: the line says what the list is for, in one glance, so the panel
answers "what is this list" before it answers "what is left":

```json
"video": { "checklist": { "title": "Sign-in checklist", "subtitle": "Four steps, one workspace" } }
```

It comes in **two layouts**, and the difference is what happens to the page:

- `"layout": "overlay"` (the default) floats a translucent card over the app at
  the edge `side` names (300 px by default, capped at 30% of the viewport).
  Nothing about the page changes, which is right for an app that fills its
  window — the tick still reads behind the panel because the card blurs what is
  under it.
- `"layout": "dock"` reserves a column instead of covering one: the page is laid
  out beside the panel, so no control is ever hidden and the whole frame is one
  composition — app on one side, list on the other. That is what a 1920×1080
  recording needs to be a real 16:9 frame rather than an app with a card on top.
  `"containFixed": true` makes the page column the containing block for fixed
  descendants of `body`, so a centred dialog follows the app column; it is
  opt-in because the transform changes fixed-position behaviour.

```json
"video": { "checklist": { "title": "Sign-in checklist", "layout": "dock", "width": 360 } }
"video": { "checklist": { "title": "Sign-in checklist", "layout": "dock", "side": "left", "width": 360 } }
```
Each line is the whole block: the same panel on the right (the default) and on the
left.

`side` is `right` (the default) or `left`, and it means the same thing in both
layouts: which edge the panel takes. In `dock` that is also which edge the page
gives up, so a flow whose app leaves its left margin empty docks `left` and the
frame reads list-then-app. The subtitle follows: it is centred on the page column,
not on the frame, in either direction.

Either way the panel is *not* built into the page: it can be removed for every
figure exactly like the pointer, so a captioned, checklist-ticked run's figures are
still byte-identical to a plain run's. A docked run keeps the reserved column
while the panel is off screen — the picture must show the page the video showed,
and a page that reflowed for the capture would not be that page.

`video.checklist` changes its heading, its second line, side, width, layout and
tick colour. A viewport under 1280 px gets a warning naming the share the panel
takes, and a dock that would leave the app itself narrower than 1280 px gets its
own:

```
  checklist: 4 item(s)  side=right  width=300px
  warning: viewport is 900px wide; a right checklist takes 270px of it
  checklist: 4 item(s)  side=right  width=360px  docked (the page is laid out beside it)
  warning: the docked panel leaves the app 1240px of the 1600px viewport
```

`--no-humanize` draws neither the subtitles nor the panel, and says so. The
review sheet lists the checklist the video ticks, each row a link that seeks the
player to the moment it ticked — the one part of a checklist a still cannot prove.

`plans/examples/signin-checklist.plan.json` is the shipped overlay example;
`plans/examples/signin-sidebar.plan.json` is the docked one, at 1920×1080 with a
360 px column (1560 px for the app), and `plans/examples/signin-sidebar-left.plan.json`
is the same panel on the left edge.

### The chrome has a palette, because the app's CSS is not ours

The panel and the cards are drawn over a page this repo does not own, so they
cannot be styled with utility classes: a Tailwind class only exists if the
*recorded page's* stylesheet contains it. They are CSS custom properties instead —
a value the browser resolves at paint time, so the same plan draws the same chrome
on a themed product, on apple.com, or on a fixture:

```json
"video": { "theme": "memory" }
"video": { "tokens": { "--pc-accent": "#f5a97f", "--pc-radius": "0px" } }
"video": { "tokens": { "--pc-accent": "var(--color-primary)" } }
```

The first names a preset in `themes/` — `memory` is the Memory web UI's dark
palette, copied into literal `oklch()` values so it renders on a page that never
loaded the product's stylesheet. Two more ship with it: `dracula` (the night
palette's ink-violet surfaces and purple ticks) and `catppuccin-mocha` (Catppuccin's
mocha flavour — base and mantle surfaces, mauve ticks; mocha is one of four
flavours, and only the dark ones suit a panel that is dark by design). Neither
invents a radius or a font: a third-party palette documents colours, so the chrome
keeps its own geometry. The second replaces individual values. The third
adopts the app's own palette, which only resolves on a page that defines
`--color-primary`; where it does not, the chrome falls back to its own default
rather than losing the colour. That is the difference between a preset (portable)
and a token (possibly inherited), and both are legitimate. An explicit token wins
over the preset it came with.

Sixteen `--pc-*` properties are the whole vocabulary — surface, surface-strong,
border, border-soft, shadow, shadow-soft, text, text-body, muted, muted-soft,
done, mark, accent, ring, radius, font-family — and a misspelled one is **refused**
by the plan validator rather than inherited silently. `checklist.accent` is the
shorthand for `--pc-accent`. A plan that names neither `theme` nor `tokens` draws
exactly the chrome it always drew, which is why adding a palette changed no figure
and no existing plan.

`node scripts/check-panel-theme.mjs --app-css <app.css>` re-reads each value the
Memory preset derives from the product's theme block and fails when the product has
moved on; the preset is a copy, and copies rot.

### A title card and an end card

A recording that starts mid-app is a video that began before you pressed play:
the first frame is a login form with no statement of what the video is for, and
the last is a screen that looks like the recording stopped rather than ended.
Two cards fix that, and — again — they are plan content:

```json
"video": {
  "intro": { "title": "Sign in to your workspace", "subtitle": "One card, two fields, and a checklist that fills in.", "bullets": ["The screen you already use", "About thirty seconds"] },
  "outro": { "title": "That is the whole path", "bullets": ["Every step is also a screenshot"] },
  "cardMs": 2400
}
```

Both cards carry **the same checklist** the panel ticks — at `0 / N` on the way in
and `N / N`, all struck through, on the way out — so the title cannot promise a
step the path does not run and the recap cannot claim something the video never
did. They take the theme from the plan's `colorScheme`, and they carry no URL bar,
no breadcrumb and no overlay: the card is the recording speaking, not a browser
window.

A card is an ordinary HTML document, not an overlay drawing like the pointer and
the panel. That is why it survives `--no-humanize` — the raw cut opens on the
title too — and why `--video` is still required: a card is a *recorded frame*, so a
figure run never opens on one. `cardMs` (2200 by default) is divided by
`--speed` with every other delay, and a card whose content is taller than the
frame is measured and named rather than silently cut off:

```
  cards: intro + outro  2400ms each
  warning: the outro card is 24px taller than the 900px frame: its bottom is not in the recording (fewer bullets, shorter rows, or a taller viewport)
```

`plans/examples/signin-walkthrough.plan.json` is the whole thing in one plan:
title card, subtitles, a panel that ticks itself off, and an end card.

## The guards

The runner refuses to write a figure when the screen does not prove it is the
right screen. Each of these is a failed run, not a wrong picture:

| Guard | Catches |
|---|---|
| `expect` per figure | the screen lost an element id the path depends on, or the words the document claims |
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
| `--video` | record the walkthrough to `<out>/video/01-main.webm` **and drive it like a person** (needs `npx playwright-core install ffmpeg`) |
| `--no-humanize` | with `--video`, record the raw machine-speed cut instead |
| `--seed <s>` | seed the humanizer (default `run-<stamp>`, logged as `seed=`) |
| `--speed <n>` | scale every human delay: 1 natural, 20 a fast test run |
| `--video-fps <n>` | video frame rate (default 25) |
| `--video-size <WxH>` | shrink the video canvas (default: the viewport). Must have the viewport's shape and be no larger than it — Playwright never scales a recording up, it pads the canvas with a band, so the run is refused instead. 1080p comes from the plan's viewport (`1920x1080`), not from this flag |
| `--poster <id>` | figure to show in the player before play (default: the first frame) |
| `--trace` | write `<out>/trace.zip`; open with `npx playwright-core show-trace` |
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
figure trustworthy, and the failure loop. Install it once and ask for the
figures:

```bash
npx skills add mkucharz/ui-path-recorder --skill path-recorder -g
```

No CLI on the box, or an agent that just reads a folder? The skill is one
directory — clone it where your agent looks:

```bash
git clone https://github.com/mkucharz/ui-path-recorder ~/.config/opencode/skills/path-recorder  # OpenCode, Codex, Cursor
git clone https://github.com/mkucharz/ui-path-recorder ~/.claude/skills/path-recorder            # Claude Code
```

The walkthrough lives at <https://mkucharz.github.io/ui-path-recorder/>.

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

The site — [mkucharz.github.io/ui-path-recorder](https://mkucharz.github.io/ui-path-recorder/) —
is `site/` plus `node scripts/build-site.mjs`: the page is a template and its
examples are recorded from the plans in this repo during the deploy, so nothing
binary is committed and no figure on it can come from anywhere else. The one
exception is the palette strip, which is not a picture at all: it is the
recorder's own panel stylesheet with each preset's tokens set, generated into the
page at build time (`lib/checklist.mjs` → `checklistCss`, `checklistPanelHtml`).

MIT.
