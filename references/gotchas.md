# Gotchas

Each of these cost a real re-capture. The runner guards most of them; the ones it
cannot guard are marked.

## Language

**An app resolves its UI language from `Accept-Language` when the account has no
stored preference.** A tutorial shipped Polish Zitadel login screenshots for
weeks because the operator's browser was Polish and the app had no per-account
language set.

The runner sends `Accept-Language: <locale>,en;q=0.9` and fails the run when
`<html lang>` disagrees with the plan. Guarded.

## Theme

**A page that applies a stored theme after first paint gives a shot taken a
fraction too early the wrong theme.** A login page reading `cp-theme` from
localStorage and defaulting to "system" is the archetype: the first capture of a
flow catches the default, the second catches what the account wanted.

Two defences: `themeStorage` pins the key before any script runs, and a dark plan
fails when the page paints a light background. Guarded — but only under
`"colorScheme": "dark"`; a light plan has no equivalent measurement.

## First-paint flashes

**Chrome that is server-rendered visible is hidden once the page's script
boots.** An app that renders a destructive "Delete selected" bar inside
`x-show="count > 0"` paints it on first render and hides it when Alpine starts.
Captured at the wrong moment, the figure shows a red bar the app never shows a
reader.

`waitHidden` waits for the settled state. But note the ordering of fixes: the
*product* bug is that the bar paints before its script runs, and the real fix is
`style="display: none"` (or an `[x-cloak]` rule) in the product. Capture-time
guards are a seatbelt; if you find yourself reaching for `waitHidden` on your own
app, fix the app.

The bundled fixture paints its own bar only when asked (`/?flash=1`), because a
recorded demo otherwise opens on 400 ms of "Delete selected" that no reader of the
app ever sees — the same reasoning, applied to the page the demo is shot from.

## Cookie banners

Third-party pages carry consent banners that cover the bottom of the viewport in
some regions and not others. A plan that *waits* for one fails on the runs that
did not get one; a plan that *ignores* one ships it in the figure.

```json
{ "clickIfPresent": { "selector": ".osano-cm-denyAll", "timeout": 4000 } }
```

Prefer a stable class over visible text — "Accept all" is translated, a class is
not. Guarded by convention, not by the runner: a banner the plan forgot simply
appears in the picture.

## Login walls and the honest failure

**A session cookie lives in an httpOnly cookie you cannot copy out of a browser
by hand**, and a session token is a credential. Do not collect one.

`--login --profile <dir>` keeps the session where it was created. When it
expires, the run fails at the page that needed it — `url never matched
/setup/…  (at https://…/login?dest=…)` — instead of capturing a login form and
calling it a figure. Guarded.

Related: **a `--login` window must be a dedicated profile.** Driving the
operator's everyday Chrome drags their extensions in (a password manager's
autofill menu is injected into the page DOM and lands inside the screenshot),
their locale, and their saved accounts.

## OAuth consent screens

A consent screen appears on the first run and is skipped on subsequent ones once
the provider holds a grant. Its URL also moves (it is *not* always on the
provider's API host: `railway.com/oauth/consent/<id>`, not
`backboard.railway.com`).

Consequences for a plan:

- Guard consent steps with `when.url` and accept both routes in `waitFor.url`.
- Do not assume the button is labelled "Authorize": read the failure evidence's
  `on screen:` list.
- A consent card often has no id or data attribute. Measure its box once
  (`getBoundingClientRect`) and use a rect clip; the surrounding page carries
  "Signed in as …", which must not be in the figure.

## Values that only exist on screen

**An installer generates an admin password and shows it once.** It cannot come
from an environment variable, so `setVar` reads it from the panel that printed
it. Two consequences:

- It must never be logged — the runner prints the length, not the value, and
  writes `.vars.json` at mode 600.
- A run that fails *after* the install must not need a second install. That is
  why `.vars.json` is written on failure too, and why a retry plan can start at
  the installed app with `--only`.

## Third-party UI is not the UI you tested

**Two versions of the same identity provider can serve the same product.** A
deployment can run the classic login (`Login Name`, `#submit-button`, a "Next"
button) while the vendor's hosted version runs a newer one (`Loginname`, Angular,
`#submit`). Screenshots taken on a dev instance do not describe a fresh install.

Before writing selectors for a third-party screen, load *the deployment you are
capturing* and read it. And if a published figure came from a dev instance while
the document describes a fresh install, that is a bug in the docs.

## Full-page captures

Most apps paint a narrow column on a full viewport. A full-frame capture becomes
"a large box with a small picture in it" in a document. Trim (default, needs
`sharp`) or clip to the subject (always preferable). Trim's edge detection exists
because a colour-distance test sees a soft radial gradient as content and never
trims anything.

## The review sheet

**The slideshow is built from the shots, never from a list.** A review page that
carried its own idea of "the figures" could show a slide for a shot that failed,
or keep one the plan dropped. Both views — the tiles and the slides — are
generated from the same `shots` array in the same order, so the only way they can
disagree is if the run wrote two different sets of figures.

**One figure is not a slideshow.** Below two shots the section is not rendered at
all: arrows over a single slide are a control that cannot do anything.

**The stage is a fixed 16:9 box, not a picture that sizes itself.** A portrait
crop followed by a wide app shot used to resize the stage on every step, which
reads as the page jumping; the player is now the frame and the figure is fitted
inside it (`max-width`/`max-height`, never enlarged). Do not give the image
`width: 100%` or an `object-fit` that crops it — the `width`/`height` attributes
only carry the incoming picture's proportions for the moment before it decodes.

**Stepping through slides is not history.** The slide goes in the URL as
`#fig-2` (so a review comment can point at one) with `history.replaceState`, not a
hash assignment: pressing back after looking at nine figures should leave the
page, not walk them in reverse.

**The player keeps the arrows while it has the focus.** The deck listens on
`document`, and a keydown that started inside a `<video>`, an `<input>` or a
`<textarea>` — or that arrived with a modifier — is left alone. Without that
guard, scrubbing a recording to watch the pointer would silently change the
figure underneath it. Space is the page's scroll key, so it advances only in
fullscreen, where there is no page to scroll.

## Video

**A figure's capture window is not part of the video.** Every figure hides the
pointer, the caption and the panel, and the page repaints — so the recorder
pauses for the capture and holds the frame that is already on screen. It drops
frames by *capture time*, not arrival time: the screencast delivers
asynchronously, so a bare frame composited while the chrome was hidden can arrive
after the resume, and dropping by arrival lets exactly the frame the pause exists
to prevent into the video. `showCursor()` resolves on the frame that carries the
restored chrome for the same reason. If you add another hide/show pair, wrap it in
`pause()`/`resume()` or expect a one-frame flash.

**The pointer in a recording is a depiction, not a capture.** Playwright's
screencast draws no mouse at all — a real OS cursor is never in the frame, which is
why a plain recording is so hard to follow. The pointer in `--video` output is an
in-page overlay the runner places at the coordinates it dispatches, so it cannot
point somewhere the plan did not go — and it cannot reach a figure either: it is
hidden before every capture, and a humanized run's PNGs are byte-identical to a
plain run's (asserted in the tests).

**`--video` forces `prefers-reduced-motion: no-preference`.** A run without it
captures a page whose every transition is switched off, which records as a series
of stills — the recording reads as broken rather than calm. The reverse is also
true: an app with a three-second intro animation now spends three seconds in the
video, and the answer is `waitFor`/`hold`, not switching motion back off. Figures
are unaffected — a shot disables animations for itself.

**A video is recorded at the viewport in CSS pixels, never at
`deviceScaleFactor`.** `2` gives crisp figures and a 900×700 video. For a sharper
video, raise `viewport` (and accept more scrolling in the flow), not the capture
ratio — scaling a small recording up in a document only enlarges its compression
artefacts. Both video dimensions are rounded down to even numbers, because the
encoder refuses odd ones.

**A video is 16:9 by default, and `--video-size` can only shrink it.** The frame
is the plan's viewport, and a plan that pins none gets 1600×900, so a `--video`
run is a 16:9 file without a flag. Pin `1920×1080` (with `deviceScaleFactor: 2`)
for a 1080p upload. `--video-size` exists for a *lighter* file — a 1440p plan
shipped at 1080p — never for a bigger one: Playwright fits the recorded frame
inside the canvas without stretching it and **does not scale it up**, so a canvas
of another aspect, or one larger than the viewport, is the page in the corner of a
grey field. The runner refuses both before the browser opens rather than write a
banded file that looks like a pass.

**One video per tab, and each is written while the run happens.** A
`clickNewPage` flow writes `01-main.webm` and `02-tab-2.webm`; both are linked
from `review.html`, and each chapter points at the tab it happened in. The runner
owns the recording (`page.screencast` + its own ffmpeg invocation, see
`lib/recorder.mjs`) rather than using `recordVideo`, so the file is named up front
and there is nothing to move afterwards.

**A frame the page never rendered is dropped, not padded — and the log says how
many.** Taking a figure calls `page.screenshot()`, which transiently changes the
surface Chromium is screencasting; the screencast is shared, so one frame in a few
hundred arrives with the page laid out for a different viewport (a 500-px-wide
phone layout, or the whole page shrunk into the corner). Playwright's recorder
pipes every frame through `pad=W:H:0:0:gray`, and a viewer sees a grey field with
a blink of the page in it. This recorder hands each frame to its own pump instead:
a frame whose JPEG dimensions or reported viewport differ from the recording's is
thrown away and the frame before it covers the gap. `frames dropped: N` in the run
log is therefore a normal, small number — `N: 0` on a plan with no figures at all.

Each recording starts when *its* page opened, so a chapter is a seek into its own
tab's file, not into the first one: `.timeline.json` records `recordingStartMs`
per video and a chapter subtracts it. Without that, the second tab's chapters seek
seconds into a file that is only a second long.

**The file has no timestamps, so the pump resamples.** A screencast is variable
rate — an idle page emits nothing — while the file is constant rate. Each accepted
frame is written once per output frame period it was on screen, which is what
ffmpeg's `-r` does with a timestamped input; writing every frame exactly once
would stretch a fast-redrawing page (a humanized pointer moves at 60 fps) into a
slow-motion video of the wrong length. The last frame is held for
`max(time since it appeared, 1s)`, so a video does not stop the instant the plan
does.

**A recording starts with the browser, not with the plan.** The first frames are
the blank page or the app's loading state, so the video is a second or two longer
than `.timeline.json` reports. That is why the poster defaults to nothing: the
first frame is the honest thumbnail, whereas a figure used as a poster is a crop
stretched across the whole player. `--poster <id>` overrides it deliberately.

**Only the scheduled delays are reproducible.** `plannedMs` in `.timeline.json`
comes from the seed and is identical on every re-run; `startMs`/`endMs` are wall
clock and never are. `--speed` rescales every delay without changing the sampled
path, so a fast test run and the final take share chapter *names*, not chapter
seconds. Shoot at `--speed 1` with a pinned `--seed`; test at 20.

**A subtitle is drawn in the page, so a navigation takes it with the document.**
That is the one place a caption can go missing mid-step: a `click` that posts a
form and loads a new page loses the pill until the runner next waits for the page
— `arrive()` (every `goto`), `hold`, and the `settle()` before a figure all say it
again. So a caption on a step that ends in a hard navigation reads as a subtitle
that stops at the page load; put the sentence on the step that lands on the new
screen (after its `waitFor`) instead. The `.vtt` is unaffected either way, because
its cue is the step's own clock.

**A step that says nothing takes the subtitle with it, so a guard between two
narrated steps flickers.** The pill belongs to its step: the next step clears it,
even if that step is a 10 ms `expect` and the one after it captions the same
screen. A viewer sees the subtitle blink rather than pause, and a recording shows
it as one blank frame. The validator warns about that shape — fold the guard into
a neighbour (`expect` runs last in the step, so two guards on one screen combine
cleanly) or give the quiet step a line. A `hold`, `waitFor`, `pause`, `waitHidden` or `shot` makes
the silence deliberate and is not warned about. This is why
`plans/examples/signin-captions.plan.json` guards `#password` and `#submit` on the
step that already inspected the form instead of spending a step on it.

**A caption is a line, and `--no-humanize` does not burn it in.** Over 160
characters, carrying a newline, empty, or on a step with no action: refused before
the browser opens. The pill is drawn by the humanizer's overlay, so the raw cut
(`--no-humanize`) records no subtitles at all — the `.vtt` is still written and
the run prints a warning. The pill is hidden for every figure and every piece of
evidence along with the pointer, which is why a captioned run's PNGs stay
byte-identical to a plain run's.

**A checklist row is a step, so it cannot drift — and it ticks on the step's
first frame, not its last.** A `check` marks the item done the moment the step
starts, which is the right beat for "we are now doing X" but the wrong one if the
work only finishes at the end of the step: put the `check` on the step that
lands on the finished screen (after its `waitFor`), not on the click that starts
the work. A row over 48 characters, a step carrying only `check`, more than ten
items, or `video.checklist` with nothing to tick: refused before the browser
opens.

**An `overlay` panel covers the app, so the viewport decides how much.** It is
300 px by default (220–380 configurable), capped at 30% of the frame, and drawn
over the page rather than shrinking it. A viewport under 1280 px triggers the
warning in the log; a plan recorded at 900 px with a 380 px panel is a video of a
panel with an app behind it. Pick the side the app leaves empty, and check the
panel against a real frame — `--speed 20`, extract one.

**A `dock` panel reserves its column instead of covering one.** The page is laid
out beside the panel, so the app gets `viewport − width` pixels and a 1920×1080
recording is a true 16:9 composition. Three things bite:

- **The app must be designed for the narrower column.** The reservation is a
  margin on the root element; a page painted in `100vw` (or a fixed-width layout
  wider than the column) ignores it and is clipped or scrolled. Look at one frame
  before publishing.
- **The reservation outlives the panel.** It is set at first paint and kept while
  the panel is removed for a figure, so a figure shows the same narrow page the
  video did. Do not expect a full-width capture from a docked run.
- **The viewport must have room for both.** A dock that leaves the app under
  1280 px logs a warning; 1920−360 = 1560 is the shipped example
  (`plans/examples/signin-sidebar.plan.json`), 1600−360 = 1240 is the one the
  warning is about.
- **Everything centred in the frame follows the reservation.** The subtitle is
  the one that shows: centred on the frame it sits under the middle of page +
  list, which reads as shifted off the screen it is captioning. It is centred on
  the app column (`--pc-dock-shift`) and bounded by it, and a card — which
  reserves nothing — still centres on the whole frame. A new fixed, centred
  overlay should do the same, or it will look off by half the panel.

**A hard navigation takes the panel with the document.** Like the caption, the
list is redrawn by the first `arrive()`/`hold`/`settle()` after a `goto`. It is
redrawn *settled*, with the ticks already in place, so a page change does not
re-run every tick; a row ticked before the navigation therefore appears
already-ticked on the new page. Ticking in the panel itself happens only while
the panel is on screen — which is what makes one run of ticks, not two.

**A card is recorded content, not a decoration — so it needs `--video` and it
survives `--no-humanize`.** `video.intro` and `video.outro` are ordinary HTML
documents set in the page before the app opens and after the last step. That
ordering is the whole reason they work in the raw cut, where no overlay is
installed at all; a card drawn by the humanizer would vanish with `--no-humanize`.
The other half of the same rule: a run *without* `--video` records nothing, so it
never shows a card — a figure run opens on the app.

**A card is a whole screen, and a screen can overflow.** The contract caps the
text (60-character title, 120 subtitle, 6 × 60 bullets) but not the pixels, and
a maximal card on a 16:9 frame is a tight fit: at 1600×900 it fills the frame,
and on a short frame (a 1600×700 window, or a 1280×720 viewport with ten rows and
six bullets) the bottom is genuinely cut off. The runner measures the rendered
card and says so, naming the overflow and the frame height, so it is never a
silent cut. If you see that warning, drop a bullet or a row, or record taller.

**A card must not be given a `caption` or a `check`.** It is not a step: it has no
page, no duration of its own and no row in the panel. Its chapter is added by the
runner (`action: "card"`), and it carries the *whole* checklist — `0 / N` in,
`N / N` out — derived from the steps that carry a `check`. Writing that list a
second time on the card is exactly the drift the derivation exists to prevent.

**One card may be asked for on its own, and neither is a promise about the run.**
`intro` without `outro` (or the reverse) is legal and common while authoring.
The end card is skipped by `--only` and never shown after a failure, because a
recap that says "done" over a run that died is a claim the video would repeat
every time it is watched.

**The chrome is styled with custom properties, not utility classes.** The panel
and the cards are drawn over a page this repo does not own, and a Tailwind class
only exists if *that page's* stylesheet contains it — so `class="bg-base-100"` is
the product's own colour on the product's pages and nothing at all on apple.com.
A custom property is a value the browser resolves at paint time, which is why the
same plan renders the same chrome anywhere. The names are a closed set of sixteen
`--pc-*` properties checked by the plan validator: an unknown one is refused,
because an inherited-and-ignored property is the one mistake that never shows up
in a run. `checklist.accent` is the shorthand for `--pc-accent`, and setting both
is refused rather than silently resolved.

**A preset is literal; a `var()` belongs in `tokens`.** `themes/memory.json` holds
concrete `oklch()` values so `"theme": "memory"` draws the Memory palette on a
page that never loaded Memory's stylesheet. Putting `var(--color-primary)` in a
preset would resolve on the product's pages and vanish everywhere else — the
opposite of what a preset is for, and the theme test refuses it. Inheritance is
what `video.tokens` is for: `{ "--pc-accent": "var(--color-primary)" }` follows
the app's theme, at the cost of only working where the app defines it. The preset
is a copy and copies rot: `node scripts/check-panel-theme.mjs --app-css PATH`
re-reads each derived value from the stylesheet it came from.

**A colour token must be read with its default as the fallback.** A plan that
points a token at a variable the page does not define (`var(--color-accent)` on a
fixture) produces a declaration that is *invalid at computed-value time*: the
custom property becomes the guaranteed-invalid value, and a consumer written as
`background:var(--pc-accent)` paints nothing — a tick circle that silently
disappears, with no warning anywhere. Every consumer therefore reads
`var(--pc-accent,#7c9cf5)`, which turns "this app had no such colour" into the
default chrome. `lib/theme.mjs` → `tokenRef` is the only place that string is
built, and `test/theme.test.mjs` asserts it both in the generated CSS and in a
painted browser.

**A page with a strict `style-src` would silently drop the chrome.** The overlay is
injected CSS and DOM, so a target shipping `style-src 'none'` refuses both without
an error: the recording completes and the finished video has an unstyled panel. The
context is created with `bypassCSP: true` for exactly that reason — the chrome is a
property of the recorder, not of whoever wrote the page being recorded. Asserted in
`test/theme.test.mjs` both ways: a policy that refuses the stylesheet leaves the
panel transparent, and the bypassed context paints it.

The bypass applies to **every** run, including `--profile <dir>` — the persistent
profile a human signed into once. So a scripted run against a signed-in app also
has its page policy relaxed, which is what the tool needs and what the plan never
says out loud. The scope is one browser context per run, the profile is a
capture-host file that is never transferred, and the recorded page is a URL the
person naming it meant to record; but it is not a no-op, and it is the reason a
token value is refused when it contains `<` (`lib/theme.mjs` → `tokenValueProblem`):
plan text must not be able to become markup in a context that no longer has a
policy to stop it.

## What the runner cannot do

- **Know a selector was right for the screen you meant.** The guards are the only
  defence, and a selector guard is only as good as the id you chose: `#card` on
  the wrong page passes. Guard the control the next step actually touches.
- **Notice your own app's flash if you did not tell it** (`waitHidden`).
- **Decide that a figure is redundant.** Three near-identical progress stages may
  be one figure in the document and three in the plan.
- **Fix prose drift.** A re-captured figure often disproves the caption next to
  it. Fix both, in the same change.
- **Watch the recording for you.** A video can be forty seconds of correct
  figures with the pointer resting on the wrong control, or a step that scrolled
  the point of the screen out of frame. Watch it — `--speed 20` while iterating,
  `--speed 1` before publishing — or extract frames and look at them.
- **Guarantee a first run suceeds.** A cold start over an unseen third-party flow
  costs an iteration or two; budget for it, and use `--only` to keep the retries
  cheap.
