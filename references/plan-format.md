# Plan format

A plan is one browser session and an ordered list of steps. JSON, validated
before a browser opens — a mistyped key is an error, not a step that silently
does nothing.

Machine-readable version: [`../plans/schema.json`](../plans/schema.json).

## Top level

| Key | Default | |
|---|---|---|
| `tutorial` | — | Name of the walkthrough; the run's directory name and the review title. |
| `description` | — | What this path proves, in a sentence. |
| `instance` | — | Which deployment (`dev`, `staging`, a local stack). Documentation only. |
| `baseUrl` | **required** | Absolute URL for relative `goto`s, or `"${INSTANCE_URL}"` so one plan serves several environments. |
| `locale` | `en-US` | Browser locale and `Accept-Language`. A page rendering another language fails the run. |
| `timezoneId` | `UTC` | A page that prints a "last seen" timestamp renders it in this zone. |
| `viewport` | `1600×900` | CSS pixels. Also the video frame: 1600×900 is 16:9, and a recording is 16:9 by default. Pin `1920×1080` for a 1080p upload. |
| `colorScheme` | `dark` | `dark`, `light` or `no-preference`. Under `dark`, a page that paints light fails the run. |
| `deviceScaleFactor` | `1` | Capture ratio. **Use 2 at minimum; 4 for figures a reader zooms into.** |
| `pad` | `32` | Pixels kept around a trimmed frame. |
| `maskColor` | `#0a0e14` | Fill for masked locators. |
| `themeStorage` | — | One storage key, pinned before any script runs: `{"cp-theme": "dark"}`. Use when the app ignores `prefers-color-scheme` for its theme, and for any first-paint chrome the site only suppresses from a stored dismissal — a locale switcher Apple keeps behind `ls-opt-out`. |
| `reducedMotion` | `reduce` | `reduce` or `no-preference`. A recorded video forces `no-preference` — an app with every transition switched off records as a series of stills. |
| `humanize` | on for `--video` | How the page is driven when recording. See below. |
| `video` | — | How the recording is *drawn*: the checklist panel's heading, side, width and tick colour. See below. |
| `vars` | — | `${name}` values. See below. |
| `steps` | **required** | Non-empty array. |

## Vars

Interpolated into any string value as `${name}`. Resolution order: the plan's
`vars`, then the process environment.

```json
"vars": {
  "email":    { "literal": "admin@example.com" },
  "password": { "env": "SHOT_PASSWORD" }
}
```

- `literal` is for a value a figure will **show**. Prefer neutral data
  (`admin@example.com`) over a mask: it reads as a real screen in a document,
  and it leaks nothing.
- `env` is for credentials. `"env"` defaults to the var's own name.
- A name a later `setVar` fills in does not need to exist up front.

## Steps

Executed in order. **Within a step, actions run in this fixed order**, whatever
order the keys appear in:

`when` → `goto` → `fill` → `type` → `press` → `click` → `clickIfPresent` →
`clickNewPage` → `pause` → `setVar` → `waitFor` → `waitHidden` → `mask` →
`expect` → `shot`

So `fill` + `expect` + `shot` in one step is one screen described top to bottom.
Split steps when a screen deserves a figure *before* something else happens on it.

### `when` — skip the step unless the page matches

A plan cannot branch, and a foreign flow looks different on the first run than
on the tenth (a consent screen appears once, then never again).

```json
{ "when": { "url": "railway\\.com/oauth/consent" }, "click": "#authorize" }
{ "when": { "text": "2-Factor Setup" }, "click": "#skip" }
```

`url` is a regular expression against the current URL; `text` must be on screen
(whitespace-insensitive). Either mismatch skips the step with a log line.

### `goto`

```json
{ "goto": "/login" }
{ "goto": "https://elsewhere.example.com/start" }
```

Relative values are joined to `baseUrl` (trailing slash trimmed). `${vars}`
expand, so a scraped token can be carried to the next screen.

### `fill` vs `type`

```json
{ "fill": { "selector": "#email", "value": "${email}" } }
{ "type": { "selector": "#password", "value": "${password}" } }
```

`fill` sets the value in one assignment — fast, and enough for a form that reads
its value on submit. `type` sends real key events one character at a time, for
the frameworks that only enable their submit button after the field has seen
typing. If a form's button stays disabled, switch `fill` to `type`; that is
usually the whole fix.

**Both become typing in a humanized run**: `fill` clicks the field, selects what
is there and types it key by key, because a field that fills itself instantly
reads as a glitch in a video (see `humanize`). The plan means the same thing
either way — which is why a humanized and a plain run produce identical figures.

### `press`

```json
{ "press": { "selector": "#search", "key": "Enter" } }
```

### `click` / `clickIfPresent` / `clickNewPage`

```json
{ "click": "#submit" }
{ "click": { "selector": "#submit" } }
{ "clickIfPresent": { "selector": ".osano-cm-denyAll", "timeout": 5000 } }
{ "clickNewPage": { "selector": "#open-app" } }
```

- `click` must find its target; if it does not, the run fails with evidence.
- `clickIfPresent` is for chrome that may or may not exist — a cookie banner
  shown in some regions, a "what's new" dialog shown to some accounts. Absence
  is not an error.
- `clickNewPage` follows a `target=_blank` link; the rest of the plan continues in
  the new tab, and any masks declared before it are reset (they belonged to the
  old page).

### `pause`

```json
{ "pause": 1500 }
```

Milliseconds. For a third-party page that settles on its own timer, or when the
point of the step is to find out what appeared and there is no element to wait
for yet. Prefer `waitFor` — a pause is a guess.

### `hold` — a beat a viewer can read

```json
{ "hold": 800 }
```

Milliseconds of stillness after the step's actions, before the next step starts.
Only meaningful in a humanized run (a plain run with humanization off returns
immediately), which is why it belongs in the plan and not in the flags: the beat
is timed against *this* screen. Use it on the step whose screen carries the point
of the walkthrough — the generated password, the finished state — so a viewer has
time to read it before the pointer moves on.

### `setVar` — read a value off the page

```json
{ "setVar": { "name": "password", "from": { "selector": "#temp-password" } } }
{ "setVar": { "name": "appUrl", "from": { "selector": "#open-app", "prop": "href" } } }
{ "setVar": { "name": "orgId", "from": { "selector": "#org", "prop": "value" } } }
```

`prop` is `text` (default), `value` (an input) or `href`. For a value that only
exists on screen — a generated password shown once, a freshly created URL — so an
end-to-end walkthrough can carry it to a later step without a human copying it.
The value is never logged (only its length) and lands in `captures/<run>/.vars.json`
at mode 600.

### `waitFor` — wait until the page is worth photographing

```json
{ "waitFor": { "selector": "#dashboard" } }
{ "waitFor": { "text": "Installation complete" } }
{ "waitFor": { "url": ["app\\.example\\.com", "app\\.example\\.com/login"], "timeout": 60000 } }
```

- `text` matches whitespace-insensitively against `body.innerText`, so a sentence
  split across elements still matches. (Do not use "some element is visible" for
  this — every ancestor of a text node is visible before the text exists.)
- `url` is a pattern or a list of alternatives; the list form is how one plan
  works whether or not the session was already signed in.
- `timeout` defaults to 20 s.

### `waitHidden` — wait until chrome is gone

```json
{ "waitHidden": { "selector": "#bulk-actions" } }
```

The mirror of `waitFor`. Some chrome is server-rendered visible and hidden once
the page's own script boots (Alpine's `x-show` before it runs, a flash of a bulk
action bar). A shot taken on first paint ships a control readers never see. Do not
mask it — wait for the settled state.

If the flash is a product bug, fix the product; this guard is a seatbelt, not the
fix.

### `mask`

```json
{ "mask": ["#account-email"] }
```

Painted over with `maskColor` before the shot. A last resort: a neutral literal
value in `vars` reads better than a black rectangle. Masks reset on a new tab.

### `expect` — the guard that makes a figure honest

```json
{ "expect": { "selector": "#signin-form" } }
{ "expect": { "selector": ["#password", "#submit"] } }
{ "expect": "Sign in to your account" }
{ "expect": ["Choose a target", "Railway", "Google Cloud"] }
```

One guard, two forms, because there are two different things worth checking:

- **A selector** asks whether the controls this path depends on are still on the
  screen. Every selector must match an element that is visible, and a miss fails
  the run. This is the form to reach for by default: ids survive copy edits,
  renames and translations, and the failure is the one a reader would hit next —
  you cannot type into a field that is gone.
- **Text** asks whether the words the document makes a claim about are still on
  screen (whitespace-insensitive, all of it). Use it when the text *is* the
  claim — a price, a plan name, a warning — and let the figure carry the rest.

`expect` is what turns a stale figure into a failed run, and it is *the* reason
to write a plan instead of clicking through a flow by hand. Every figure should
carry one: the ids it depends on, or the sentence the document says it shows.

A guard is checked at its point in the path, not waited for. Use `waitFor` to
let a slow screen settle first; use `expect` to refuse a screen that settled
wrong.

### `shot` — take the picture

```json
{ "shot": "03-dashboard" }
{ "shot": { "id": "01-signin", "clip": "main.card" } }
{ "shot": { "id": "02-consent", "clip": { "x": 587, "y": 218, "width": 418, "height": 626 } } }
{ "shot": { "id": "03-step", "clip": "#card", "pad": 24 } }
```

- `id` is the figure id **and** the file name (`<id>.png`), unique within a plan.
  Name them with a numeric prefix — `01-`, `02-` — so a directory listing reads in
  walkthrough order and a document can reference them stably.
- `clip` is a selector (padded by `pad`, default 32) or a measured rect in CSS
  pixels (used as-is, for a subject with no element of its own). The padding is
  not optional decoration: a figure that ends on a card border reads as a crop,
  so selector clips always keep margin, and a measured rect must carry its own.
- A selector clip is scrolled to the middle of the viewport before capture, so a
  figure can live below the first screen. A measured rect is not scrolled: it
  must already be inside the current viewport.
- No `clip` means the whole viewport, then trimmed to its content (unless
  `--no-trim` or `sharp` is unavailable). A clip is never trimmed: it is
  already the composition, and re-cropping it would slice the subject's edges.
- `holdMs` overrides how long the video holds this frame before the next action
  (`humanize.shotHoldMs`, default 1200). A dense dashboard deserves longer than a
  labelled button.
- The figure is captured after `networkidle` (5 s cap) plus 250 ms, with
  animations disabled and the text caret hidden. The pointer — and the step's
  caption — is hidden for the capture and shown again afterwards, so both are in
  the video and neither is in the figure.

### `caption` — the subtitle for this step

```json
{ "caption": "Open the sign-in page for your workspace.", "goto": "/signin" }
{ "caption": "Sign in with the address and password you already use.", "shot": "01-signin" }
```

The sentence a viewer reads while this step plays. It is part of the plan rather
than of a video editor, for the same reason `expect` is: a subtitle that is typed
in afterwards is a claim nobody checks, and it drifts off the screen it describes
the moment the path changes.

One `caption` is two artefacts, both timed by the step:

- **drawn in the recording** — a dark pill at the bottom centre, sized from the
  viewport (so it stays proportionate at 1080p) — for the whole step. This is what
  makes the video explain itself in any player, including one that ignores
  sidecar tracks.
- **`video/01-main.vtt`** beside the recording — a WebVTT file a `<track>`, a
  docs page or a video host reads: switchable off, searchable, translatable. The
  review sheet's player carries it as a captions track, off by default so it
  cannot paint a second caption over the drawn-in pill; turn it on to check the
  file's timing.

Rules worth knowing:

- **No `caption` on the next step clears it.** A subtitle never outlives the
  screen it described, and the `.vtt` cue stops at the same boundary the pill
  does.
- **Consecutive steps with the same caption are one cue**, so a two-step screen
  does not blink a subtitle on and off.
- **A cue shorter than 1.2 s is lengthened** to its step's own boundary: a click
  that swaps a screen in 200 ms is not something a viewer can read. It never runs
  into the following step.
- **One line, under 160 characters**, and it is not an action — a step with only
  `caption` does nothing and is refused. Both are checked before a browser opens.
- **Figures never contain it**, exactly like the pointer.
- `--no-humanize` has no overlay to draw with, so the recording carries no
  burned-in subtitles; the `.vtt` is still written and the run logs a warning.

The shipped example is `plans/examples/signin-captions.plan.json`.

### `check` — the checklist row this step ticks

```json
{ "check": "Open your workspace", "goto": "/?lang=${lang}" }
{ "check": "Sign in with your email", "fill": { "selector": "#email", "value": "${email}" } }
```

A short line for the checklist panel docked beside the recording. The panel's rows
**are** the steps that carry a `check`, in the order they first appear: there is
no second list to keep in sync, so the panel cannot promise a step the path does
not run, and re-ordering the plan re-orders the panel.

- **The tick happens when the step starts**, on the same beat as its `caption`, so
  the row and the subtitle change together. `timeline.checks()` (and the review
  sheet's checklist block) seek to that moment.
- **A repeated `check` is one row**, ticked once. A flow that returns to the same
  screen does not grow a second row, and the later occurrence does not re-tick it.
- **One line, at most 48 characters**, whitespace collapsed. More than ten
  distinct items is refused: past that a viewer reads the list instead of watching.
- **It is not an action.** A step carrying only `check` does nothing and is
  refused; put it on the step whose work completes the item.
- **A hard navigation re-draws the panel settled.** The list lives in the page, so
  a `goto` replaces the document holding it; the new one draws the list with its
  ticks already in place rather than animating them a second time.
- **Figures never contain it**, exactly like the pointer and the caption.
- `--no-humanize` has no overlay to draw with, so the recording carries no panel
  and the run logs a warning.

How the panel looks — and whether it floats over the page or docks beside it —
is `video.checklist` (below). The shipped examples are
`plans/examples/signin-checklist.plan.json` (overlay) and
`plans/examples/signin-sidebar.plan.json` (docked, 1920×1080).

## `video` — how the recording is drawn

Optional. These keys describe the picture, never the path. The panel is drawn by
the humanizer's overlay, so it applies to a humanized run (`--video` turns that
on); the cards are page content and appear in the raw cut too, but only in a run
that records.

| Key | | |
|---|---|---|
| `checklist` | — | `{ title, side, width, layout, accent }` for the panel beside the video. |
| `intro` | — | The title card the video opens on. `{ title, subtitle?, bullets? }`. |
| `outro` | — | The end card the video closes on. Same shape. |
| `cardMs` | `2200` | How long each card is held, divided by `humanize.speed` like every other delay. |

### `video.checklist`

| Key | Default | |
|---|---|---|
| `title` | `"What you'll do"` | Heading above the rows. An empty string hides it. |
| `side` | `"right"` | `left` or `right`. Pick the side the app leaves empty; a panel over a sidebar is a panel over evidence. |
| `width` | `300` | 220–380 CSS pixels. In `overlay` it is capped at 30% of the viewport; in `dock` it keeps its width, because the page gives up exactly that column. |
| `layout` | `"overlay"` | `overlay` floats a translucent card over the app; `dock` reserves a column of its own and lays the page out beside it. |
| `accent` | `"#7c9cf5"` | Colour of a completed tick, `#rgb` or `#rrggbb`. |

`overlay` changes nothing about the page — the card blurs what is under it, so a
control behind it is still readable — and its width is a share of the frame: a
viewport narrower than 1280 px logs a warning, because 30% of a 900 px page is a
different video from 30% of 1600.

`dock` is the one that makes a 16:9 composition: the page is laid out beside the
panel instead of under it, nothing is covered, and the app gets
`viewport − width` pixels. Two consequences worth planning for: the app must
be designed for a narrower column (a page painted in `100vw` units ignores the
reservation), and a dock that leaves the app under 1280 px logs its own warning.
The reservation is set on the root element at the document's first paint and stays
when the panel is hidden for a figure, so the page does not reflow between the
video and the picture of it. A card is a document of its own and never reserves
anything.

Like the subtitle pill, the panel is drawn dark whatever the plan's
`colorScheme`: it is a recording decoration, not part of the app, and a dark
panel on a light page reads as an overlay rather than as a broken screen.

```json
"video": { "checklist": { "title": "Sign-in check", "width": 320 } }
"video": { "checklist": { "title": "Sign-in checklist", "layout": "dock", "width": 360 } }
```

### `video.intro` / `video.outro`

A card is a whole screen of the recording, so it is built around one line.

| Key | Default | |
|---|---|---|
| `title` | **required** | The line the card is built around, up to 60 characters. A single line — a title that needs a paragraph is a `subtitle`. |
| `subtitle` | — | One sentence under it, up to 120 characters. |
| `bullets` | — | Up to 6 one-line points, 60 characters each. Six is a glance; more is a slide nobody reads. |

Both cards carry **the same rows the panel ticks** — the steps that carry a
`check` — at `0 / N` on the way in and `N / N`, all struck through, on the way
out. There is nothing to write a second time, so a card cannot promise a step the
path does not run.

Two consequences worth knowing before you write one:

- A card is an ordinary HTML document set in the page, not an overlay drawing, so
  `--no-humanize` still records it. It is also why a card needs `--video`: a card
  is a *recorded frame*, and a figure run must not open on a title card.
- A card is measured after it renders. If its content plus its own padding is
  taller than the viewport, the run warns with the number of pixels and the frame
  height, because that overflow is a silent cut-off in the finished video. The
  contract caps the text, not the pixels: how tall a line is depends on the
  frame's size.

The theme follows the plan's `colorScheme` rather than the app's, since a card is
the recording speaking rather than the product. It carries no URL bar, no
breadcrumb and no overlay.

```json
"video": {
  "intro": { "title": "Sign in to your workspace", "bullets": ["About thirty seconds"] },
  "outro": { "title": "That is the whole path" },
  "cardMs": 2400
}
```

An unknown key in any of these blocks is refused before a browser opens, the same
way a mistyped step key is.

## `humanize` — how the page is driven when recording

On by default for `--video`. Off otherwise, unless `--humanize` forces it on for a
pacing-only run; `--no-humanize` records the raw machine-speed cut. Every key is
optional, and the default is the value in the table.

| Key | Default | |
|---|---|---|
| `enabled` | `true` | `false` is the same as `--no-humanize`. |
| `seed` | `run-<stamp>` | A string. The same seed replays the same path, the same typing rhythm and the same scheduled delays. Set it to pin a video's look; `--seed` overrides. |
| `speed` | `1` | Divides every delay. 1 is a natural pace, 20 is a fast test run. `--speed` overrides. |
| `cursor` | `"arrow"` | `arrow` or `none`. |
| `clickRipple` | `true` | A ring where the click landed. |
| `moveMs` | `[220, 640]` | Travel duration range in ms, interpolated by distance and clamped to it. |
| `dwellMs` | `[80, 220]` | Hover on the target before the press. |
| `pressMs` | `[60, 120]` | How long the button is held down. |
| `afterMs` | `[180, 420]` | Stillness after an action, before the next one starts. |
| `typing` | below | `{minMs, maxMs, maxChars, longValueLead}` |
| `shotHoldMs` | `1200` | How long a figure's frame is held in the video. |
| `loadMs` | `400` | Wait after a navigation, before the page is trusted to hold still. |
| `loadFade` | `180` | Fade up from `maskColor` instead of a white flash between pages. |

In `typing`, `minMs`/`maxMs` are per-key delays (default 55–140 ms, longer after
a delimiter, with an occasional longer stop), `maxChars` is the length above
which a value is typed at the start and pasted (40), and `longValueLead` is how
many characters are typed before that paste (6).

An unknown key here is refused before a browser opens: a mistyped
`{"humanzie": …}` would otherwise leave the whole block silently inert.

```json
"humanize": { "seed": "install-v3", "shotHoldMs": 2000, "typing": { "maxMs": 90 } }
```

The pointer it draws is a *depiction*, not a capture: an overlay placed at the
coordinates the runner really dispatches, hidden for every figure and every piece
of failure evidence. It cannot point somewhere the plan did not go, and it cannot
end up inside a figure.
