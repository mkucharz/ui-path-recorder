/**
 * The recording chrome's palette, as CSS custom properties.
 *
 * The panel and the cards are drawn over — and next to — an app nobody here
 * wrote, so their colours cannot be Tailwind classes: a utility only exists if
 * the *recorded page's* stylesheet happens to contain it, which is true on one
 * site and false on the next. A custom property is different: it is a value,
 * resolved when the browser paints, so the same plan renders the same chrome on
 * a Memory gateway, on apple.com, or on a fixture served from localhost.
 *
 * That gives two ways to restyle the chrome without touching this file:
 *
 * - `video.theme` names a preset shipped in `themes/` — literal values, so it
 *   works on a page that defines no tokens at all;
 * - `video.tokens` sets any of these properties explicitly — including to
 *   `var(--color-primary)`, which is how a recording of a themed app inherits
 *   that app's own palette (the product's runtime-injected badges are styled the
 *   same way: see `.memory-badge` in the Memory web UI's `chat-components.js`).
 *
 * The names are a closed set on purpose. A mistyped custom property is invisible
 * — the browser keeps the default and says nothing — which is exactly the class
 * of mistake the plan validator exists to refuse.
 */

import { readFileSync, readdirSync } from 'node:fs';

/**
 * Every property the *panel* and the *cards* read — and the whole set a plan may
 * name. The subtitle pill, the pointer and the click ripple are separate
 * drawings with a fixed look of their own (the pill is the caption speaking, the
 * pointer is the hand), so they are deliberately not themeable here.
 */
export const PANEL_TOKENS = Object.freeze([
  '--pc-surface',
  '--pc-surface-strong',
  '--pc-border',
  '--pc-border-soft',
  '--pc-shadow',
  '--pc-shadow-soft',
  '--pc-text',
  '--pc-text-body',
  '--pc-muted',
  '--pc-muted-soft',
  '--pc-done',
  '--pc-mark',
  '--pc-accent',
  '--pc-ring',
  '--pc-radius',
  '--pc-font-family',
]);

/**
 * The values the chrome drew before it had a palette.
 *
 * These are the panel's own defaults — the docked layout has two refinements of
 * its own (`--pc-surface-strong`, `--pc-border-soft`, `--pc-shadow-soft`), and a
 * theme that leaves them alone keeps a dock that looks like the dock it always
 * was. A card overrides them per `colorScheme` (see `lib/cards.mjs`), because a
 * card is the recording speaking, not the app.
 */
export const TOKEN_DEFAULTS = Object.freeze({
  '--pc-surface': 'rgba(10,13,20,.84)',
  '--pc-surface-strong': '#0d121b',
  '--pc-border': 'rgba(255,255,255,.12)',
  '--pc-border-soft': 'rgba(255,255,255,.09)',
  '--pc-shadow': 'rgba(0,0,0,.45)',
  '--pc-shadow-soft': 'rgba(0,0,0,.3)',
  '--pc-text': '#eef2fa',
  '--pc-text-body': '#c8d1e0',
  '--pc-muted': '#93a0b6',
  '--pc-muted-soft': '#8593a8',
  '--pc-done': '#79859a',
  '--pc-mark': '#0b0e14',
  '--pc-accent': '#7c9cf5',
  '--pc-ring': 'rgba(255,255,255,.3)',
  '--pc-radius': '14px',
  '--pc-font-family': "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
});

/** The font stack a card uses before a theme replaces it. */
export const CARD_FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/**
 * A value that cannot end its own declaration, or its own `<style>` element.
 *
 * Two different failures, one function, because both are a plan that reads as a
 * value and behaves as markup:
 *
 * - `;`, `{` or `}` means the plan was written as if it were a stylesheet, and it
 *   never ends where the author thinks it does;
 * - `<` means the value can close the `<style>` block a card is generated into, so
 *   the rest of it parses as HTML — a card is a whole document built by
 *   interpolation, and every other field in it is escaped. A CSS value has no use
 *   for an angle bracket, so refusing one costs nothing and closes the only route
 *   from plan text to markup that the escaping does not cover.
 */
export function tokenValueProblem(value) {
  if (typeof value !== 'string') return 'must be a CSS value string';
  if (!value.trim()) return 'is empty';
  if (/[;{}]/.test(value)) return 'contains ";", "{" or "}" — it is a value, not a declaration';
  if (/[<>]/.test(value)) return 'contains "<" or ">" — it is a CSS value, not markup';
  if (/[\r\n]/.test(value)) return 'must be a single line';
  return null;
}

/**
 * The presets, read once.
 *
 * `themes/*.json` rather than a map in this file so a preset is data a reader can
 * diff against the product it came from — the Memory one is checked against the
 * web UI's own theme block by `scripts/check-panel-theme.mjs`. A malformed preset
 * is our bug, not a plan's, so it throws with the file name instead of being
 * skipped: silently dropping a preset would turn `"theme": "memory"` into a panel
 * that ignores the plan.
 */
let presetCache = null;

export function presets() {
  if (presetCache) return presetCache;
  const dir = new URL('../themes/', import.meta.url);
  const found = {};
  let files = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    // A bundled install with no `themes/` is an empty preset list, not a crash:
    // `tokens` still styles everything, and the validator names what is missing.
    files = [];
  }
  for (const name of files) {
    const file = new URL(name, dir);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`themes/${name} is not readable JSON: ${error.message}`);
    }
    const tokens = parsed?.tokens ?? {};
    for (const [token, value] of Object.entries(tokens)) {
      if (!PANEL_TOKENS.includes(token)) {
        throw new Error(`themes/${name}: "${token}" is not a panel token (known: ${PANEL_TOKENS.join(', ')})`);
      }
      const problem = tokenValueProblem(value);
      if (problem) throw new Error(`themes/${name}: "${token}" ${problem}`);
    }
    found[name.replace(/\.json$/, '')] = { tokens, description: parsed?.description ?? '', source: parsed?.source ?? '' };
  }
  presetCache = Object.freeze(found);
  return presetCache;
}

/** The preset names a plan may name, for an error message that lists them. */
export function presetNames() {
  return Object.keys(presets());
}

/**
 * The chrome's tokens for a plan: defaults → preset → explicit `video.tokens`.
 *
 * Only what the plan actually changes is returned, so the CSS keeps owning the
 * defaults and a plan that says nothing about colour draws the chrome it always
 * drew. `video.checklist.accent` is folded in here because it is a shortcut for
 * one token, and the validator refuses a plan that sets both.
 */
export function resolveTokens(plan) {
  const video = plan?.video ?? {};
  const preset = video.theme ? presets()[video.theme] : null;
  const resolved = { ...(preset?.tokens ?? {}) };
  for (const [token, value] of Object.entries(video.tokens ?? {})) resolved[token] = value;
  const accent = video?.checklist?.accent;
  if (accent && !Object.hasOwn(video.tokens ?? {}, '--pc-accent')) resolved['--pc-accent'] = accent;
  return resolved;
}

/**
 * A token read, with its default as the fallback: `var(--pc-accent,#7c9cf5)`.
 *
 * The fallback is not belt-and-braces, it is the difference between a chrome and a
 * hole. A plan may set a token to the *app's* variable — `--pc-accent:
 * var(--color-accent)` — and on a page that defines no `--color-accent` that
 * declaration is invalid at computed-value time: the custom property becomes the
 * guaranteed-invalid value, and `background:var(--pc-accent)` then paints nothing
 * at all (a tick that is invisible, not a tick that is blue). A fallback in the
 * consumer is what turns "the app had no such colour" into the default instead of
 * into a missing circle.
 *
 * `tokenDefaultsRule()` is still emitted: it makes the resolved palette visible on
 * the element, and every rule that reads a token after this change keeps working
 * whether or not the plan named it.
 */
export function tokenRef(name) {
  return `var(${name},${TOKEN_DEFAULTS[name]})`;
}

/**
 * The panel's custom properties, as one rule.
 *
 * Declared on the panel element rather than on `:root` so nothing leaks into the
 * page: the recorded app must be byte-identical to a run with no chrome, and a
 * `html{--pc-*}` block would be inherited by every element of it.
 */
export function tokenDefaultsRule() {
  const body = Object.entries(TOKEN_DEFAULTS)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
  return `#__path_checklist{${body}}`;
}

/**
 * `selector{a:b;c:d}` for a token map, or `''` when there is nothing to say.
 *
 * The cards are whole documents, so they get their tokens on `:root` — the only
 * node above the card in a document that has nothing else in it.
 *
 * The value is CSS-escaped on the way in: a `<` in a token value would close the
 * `<style>` element the card is generated into and turn the rest of the palette
 * into HTML. `tokenValueProblem` refuses one, and this is the second lock — the
 * validator runs on plans read from disk, not on every plan assembled in code.
 */
export function tokenRule(selector, tokens) {
  const entries = Object.entries(tokens ?? {});
  if (!entries.length) return '';
  const value = (raw) => String(raw).replace(/</g, '\\3c ').replace(/>/g, '\\3e ');
  return `${selector}{${entries.map(([name, raw]) => `${name}:${value(raw)}`).join(';')}}`;
}
