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

## What the runner cannot do

- **Know a selector was right for the screen you meant.** `expect` text is the
  only defence, and it is only as good as the sentence you copied from the
  document.
- **Notice your own app's flash if you did not tell it** (`waitHidden`).
- **Decide that a figure is redundant.** Three near-identical progress stages may
  be one figure in the document and three in the plan.
- **Fix prose drift.** A re-captured figure often disproves the caption next to
  it. Fix both, in the same change.
- **Guarantee a first run suceeds.** A cold start over an unseen third-party flow
  costs an iteration or two; budget for it, and use `--only` to keep the retries
  cheap.
