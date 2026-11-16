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

## Video

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

## What the runner cannot do

- **Know a selector was right for the screen you meant.** `expect` text is the
  only defence, and it is only as good as the sentence you copied from the
  document.
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
