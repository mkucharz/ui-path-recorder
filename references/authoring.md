# Authoring a plan for an app you have never captured

The runner is the easy half. The plan is where the judgement is, because a plan
is a claim about what a screen shows — and the value of the whole thing is that
the claim is checked on every run.

## 1. Get the flow from something authoritative

In order of preference:

1. **The app's source.** A portal that renders `#deploy`, `#progress-step`,
   `#success-card` lets you write those ids directly. Selectors read from source
   are not guesses, and renaming one breaks the plan instead of shipping a stale
   figure.
2. **The document's own prose.** A tutorial that says "click **Deploy** in the
   Railway card" is telling you what the figure must show, which is what the
   `expect` string should be.
3. **`npx playwright codegen <url>`.** Click through the flow in the recorded
   window; it prints Playwright calls with worked-out selectors. Draft with it,
   then hand-write the plan — codegen gives you selectors, it does not know what
   deserves a figure.

For a page you cannot log into yet, capture the pre-auth part first. The flow is
usually linear enough that a plan can be extended later from the evidence of a
failed run.

## 2. Decide the screens before writing steps

Walk the flow and mark the screens a reader cannot proceed without seeing. Those
are the figures. Everything else is a step with no `shot`.

A useful rule: **one figure per decision the reader has to make**, plus one per
outcome they are promised. Do not photograph a spinner; do photograph the
progress stage whose *text* the document quotes.

Name ids in walkthrough order with a zero-padded prefix:

```
01-choose-target  02-consent  03-workspace  04-progress-project  …
```

A directory listing then reads like the tutorial does, and re-numbering never
happens because inserting a screen is rare and obvious.

## 3. Pin the frame

```json
"viewport": { "width": 1600, "height": 900 },
"deviceScaleFactor": 4,
"colorScheme": "dark",
"locale": "en-US",
```

- **`deviceScaleFactor: 2` minimum, `4` if a reader may zoom.** A 1× figure is
  mush the moment it is shown on a 2× display or in a lightbox.
- **Match the deployment's theme.** If the product is dark, a dark plan also gets
  you the theme guard: a figure that caught the page before its theme applied
  fails instead of shipping.
- **Set the app's own theme key** with `themeStorage` when it ignores
  `prefers-color-scheme` (a login page that reads `cp-theme` from localStorage
  and defaults to "system" is the common case).

## 4. Clip to the subject

A viewport-wide capture of a 360 px card is a large box with a small picture in
it. Prefer `"clip": "<selector>"`; it is exact, repeatable, and makes a drifting
crop show as a size diff in review.

**Leave breathing room around the subject.** A clip that ends exactly on a
card's border reads as a crop, not a figure: the border touches the edge, the
heading above it loses its leading, and a shadow or focus ring is cut in half.
Every selector clip is padded (`pad`, default 32 CSS px) for this reason. Raise
it to 48–64 for a dense card, a card with a drop shadow, or a subject whose
neighbours help a reader place it; only drop below the default for a bare text
run where the padding would be a field of white. A measured rect is used
as-is — include the padding yourself. Figures in one set should share a `pad`
value so their margins line up in a document column.

Measure before you guess:

```js
// inside page.evaluate: the box the plan should clip to
const el = document.querySelector('#card');
const r = el.getBoundingClientRect();
({ x: r.x, y: r.y, width: r.width, height: r.height })
```

Use a measured rect only for a subject with no element of its own. Watch for
inner padding: a login page's `.content-container` may be 440 CSS px with 20 px
of padding, so the visible card is 400 and the *clip target* decides which width
every figure in the set will have. Consistency across a set matters more than
any single crop: if figures end up at different widths, the column looks ragged.

## 5. Write the guards first, then the steps

Write every `expect` from the sentence in the document the figure illustrates.
That single habit is what makes a stale capture fail instead of ship.

Then, for a page that settles slowly:

```json
{ "waitHidden": { "selector": "#bulk-bar" } },
{ "expect": "Memory's Project", "shot": { "id": "13-projects" } }
```

and for a screen that only some deployments show:

```json
{ "when": { "text": "2-Factor Setup" }, "click": "#skip" }
```

## 6. Iterate from evidence

The first run over an unseen page fails on a selector. That is normal and cheap:

1. Run it.
2. Open `captures/<run>/failures/<stamp>--<step>.txt` and read `on screen:`.
3. Fix that one step.
4. Re-run.

Two techniques make the loop fast:

- **`--only <shot-id>`** replays up to the figure you are fixing, so you do not
  re-walk the flow for the eleventh figure.
- **Split long flows into several plans that share a session.** When a flow costs
  minutes (an installer that provisions a cloud project), capture the expensive
  part once, then use `--profile` plus a smaller plan starting at the installed
  app. Nothing about the plan says "one plan per document".

If a run dies *after* an expensive step, its `.vars.json` keeps what it scraped —
so the retry plan can pick up where it stopped instead of repeating the setup.

## 7. Data in the figures

- **Alias, do not mask.** `"email": { "literal": "admin@example.com" }` produces a
  figure that looks like a real screen and carries nothing personal. A black
  rectangle reads as a mistake.
- **Mask only what must be real**: an account that genuinely exists and must not
  be published. `"mask": ["#account-email"]`.
- **Never put a credential in a plan.** `env` vars for passwords, `setVar` for
  anything the app generates.
- **Check the whole frame, not just the subject.** A masked card in the middle of
  a page whose header says "signed in as …" is not masked.

## 8. Keep the plan honest

A plan that nobody re-runs silently describes an old UI. Tie it to the document:

- Reference the figure ids from the document's figure captions, so a rename is a
  grep away.
- Re-run when the flow changes — a new consent screen, a renamed button. The
  guards make that a five-minute fix rather than a wrong page.
- When the prose changes, check the figure still illustrates it. A figure that
  disagrees with its caption is worse than an old figure.

## Anti-patterns

- **A plan per figure.** Replaying to figure 12 re-walks 1–11. One plan per flow.
- **Sleeps for the sake of it.** `pause` is a guess; `waitFor`/`waitHidden` are
  facts. Reach for `pause` only when the step's purpose is to discover what
  appeared.
- **Asserting on a selector that a redesign will move.** Assert on text the
  document promises the reader; move the plan's selectors as rarely as possible.
- **Re-shooting one figure by hand** "just this once". That is how a set of
  figures stops being reproducible, and how a password manager ends up in a
  published picture.
