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
| `viewport` | `1600×827` | CSS pixels. |
| `colorScheme` | `dark` | `dark`, `light` or `no-preference`. Under `dark`, a page that paints light fails the run. |
| `deviceScaleFactor` | `1` | Capture ratio. **Use 2 at minimum; 4 for figures a reader zooms into.** |
| `pad` | `32` | Pixels kept around a trimmed frame. |
| `maskColor` | `#0a0e14` | Fill for masked locators. |
| `themeStorage` | — | One storage key a third-party app reads for its theme, pinned before any script runs: `{"cp-theme": "dark"}`. Use when the app ignores `prefers-color-scheme`. |
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
{ "expect": "Sign in to your account" }
{ "expect": ["Choose a target", "Railway", "Google Cloud"] }
```

Text that must be on screen (whitespace-insensitive, all of it). This is what
turns a stale figure into a failed run, and it is *the* reason to write a plan
instead of clicking through a flow by hand. Every figure should carry one —
ideally the sentence from the document that the figure illustrates.

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
- The figure is captured after `networkidle` (5 s cap) plus 250 ms, with
  animations disabled and the text caret hidden.
