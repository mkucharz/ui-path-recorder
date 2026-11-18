/**
 * The two cards a walkthrough can open and close on.
 *
 * A recording that starts mid-app is a video that began before you pressed play:
 * the viewer's first frame is a login form with no statement of what the video is
 * for, and the last is a screen that looks like the recording stopped rather than
 * ended. An intro card says what the walkthrough will do; an end card says it is
 * done, with the checklist filled in.
 *
 * A card is an ordinary HTML document, not an overlay drawing like the pointer,
 * the subtitle and the checklist panel. That is the point: it is shown before the
 * app is opened and after it is finished, so it must work in the raw cut too
 * (`--no-humanize` installs no overlay at all), and it must not depend on a page
 * that is still loading.
 *
 * The checklist on a card is the *same* list the panel ticks — derived from the
 * steps that carry a `check` — so an intro card cannot promise a step the path
 * does not run, and an end card cannot claim something the video never did.
 */

import { checklistOptions, squash } from './checklist.mjs';
import { CARD_FONT_FAMILY, TOKEN_DEFAULTS, cssEscapeValue, resolveTokens, tokenRule } from './theme.mjs';

/** Long enough to read twice, short enough not to drag. Divided by `--speed`. */
export const CARD_DEFAULT_MS = 2_200;

export const MAX_CARD_TITLE_CHARS = 60;
export const MAX_CARD_SUBTITLE_CHARS = 120;
export const MAX_CARD_BULLETS = 6;
export const MAX_CARD_BULLET_CHARS = 60;

/** Keys a `video.intro` / `video.outro` block may carry. */
export const CARD_KEYS = new Set(['title', 'subtitle', 'bullets']);

/** Both cards are HTML, so a title containing `<` is text, not markup. */
export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

const oneLine = (text) => squash(text);

/**
 * The cards this plan asks for, or `null` when it asks for none.
 *
 * `intro` and `outro` are independent: a video may open on a card and end on the
 * last screen, or start on the app and end on a summary. `ms` is divided by
 * `--speed` with every other delay, so a fast test run is not stuck on a card.
 */
export function cardOptions(plan, { speed = 1 } = {}) {
  const block = plan?.video ?? {};
  if (!block.intro && !block.outro) return null;
  const ms = Math.max(0, Number.isFinite(block.cardMs) ? block.cardMs : CARD_DEFAULT_MS);
  return {
    intro: block.intro ?? null,
    outro: block.outro ?? null,
    ms: Math.round(ms / (speed || 1)),
  };
}

/**
 * Whether a card's content runs past the frame it is recorded in.
 *
 * A card is a whole screen, so a card taller than the viewport is content the
 * recording never shows — and it fails silently: the video plays, the bottom
 * rows are simply not there. The contract caps the *text* (60/120/6×60), not the
 * pixels, and how many pixels a line takes depends on the app's font and the
 * frame's size, so the only honest check is a measurement of the rendered card.
 *
 * Pure, because the numbers come from the page: the caller measures the content
 * and the frame, and this decides what to say about them.
 */
export function cardFitWarning({ kind, contentHeight, frameHeight, padding = 0 }) {
  const over = Math.round(contentHeight + padding * 2 - frameHeight);
  if (!(over > 0)) return null;
  return (
    `the ${kind} card is ${over}px taller than the ${frameHeight}px frame: its bottom is not in the recording ` +
    '(fewer bullets, shorter rows, or a taller viewport)'
  );
}

/**
 * One card, as a whole document.
 *
 * The theme follows the plan's `colorScheme` rather than whatever the app paints:
 * a card is the recording speaking, not the product, and a light card in front of
 * a dark app is a deliberate choice a plan can make.
 *
 * @param {any} plan
 * @param {'intro'|'outro'} kind
 */
export function cardHtml(plan, kind) {
  const block = plan?.video?.[kind];
  if (!block) return '';
  const light = (plan?.colorScheme ?? 'dark') === 'light';
  // The panel's heading and tick colour, so a card and the panel read as one
  // recording rather than two artefacts that happen to share a video.
  const checklist = checklistOptions(plan);
  const items = checklist?.items ?? [];
  const accent = checklist?.accent ?? '#7c9cf5';
  const heading = checklist?.title ?? '';
  // The panel's second line, repeated here so a card and the panel it introduces
  // describe the same list the same way.
  const note = checklist?.subtitle ?? '';
  const title = oneLine(block.title);
  const subtitle = oneLine(block.subtitle);
  const bullets = (block.bullets ?? []).map(oneLine).filter(Boolean);
  const done = kind === 'outro';

  const rows = items
    .map(
      (text) =>
        `<li class="pc-row${done ? ' pc-done' : ''}"><span class="pc-box">${
          done ? '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.4 6.5 L4.9 9 L9.6 3.4"/></svg>' : ''
        }</span><span class="pc-text">${escapeHtml(text)}</span></li>`,
    )
    .join('');

  const muted = light ? '#6b7a90' : '#93a0b6';
  const body = light ? '#0f1724' : '#eef2fa';
  const soft = light ? '#33415c' : '#c3cddd';
  const dim = light ? '#7b879b' : '#79859a';
  const bg = light ? '#ffffff' : '#0a0e14';
  const rule = light ? 'rgba(15,23,36,.12)' : 'rgba(255,255,255,.12)';
  const ring = light ? 'rgba(15,23,36,.28)' : 'rgba(255,255,255,.3)';
  // The card is a whole document, so its palette is simply declared on `:root`:
  // the scheme's values first, then whatever the plan's `theme`/`tokens` change.
  // A card that names neither is the card this drew before there was a palette.
  const theme = tokenRule(':root', resolveTokens(plan));
  const scheme = {
    '--pc-surface': bg,
    '--pc-text': body,
    '--pc-text-body': soft,
    '--pc-muted': muted,
    '--pc-accent': accent,
    '--pc-done': dim,
    '--pc-border': rule,
    '--pc-ring': ring,
    '--pc-mark': light ? '#ffffff' : '#0b0e14',
  };
  // Escaped like `tokenRule`'s values, because `checklist.accent` reaches this
  // document through the scheme map rather than through the plan's token map — a
  // plan assembled in code never met the validator that pattern-checks it.
  const surfaceTokens = Object.entries(scheme)
    .map(([name, value]) => `${name}:${cssEscapeValue(value)}`)
    .join(';');
  // A token read falls back to what this card would have painted anyway, not to
  // the panel's default: a plan pointing a token at a variable the page does not
  // define must leave a light card light. See `lib/theme.mjs` → `tokenRef`.
  const C = (name) => `var(${name},${cssEscapeValue(scheme[name] ?? TOKEN_DEFAULTS[name])})`;

  return `<!doctype html>
<html lang="${escapeHtml((plan?.locale ?? 'en-US').split('-')[0])}" data-pc-card>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: ${light ? 'light' : 'dark'}; ${surfaceTokens} }
  ${theme}
  * { box-sizing: border-box }
  html, body { height: 100% }
  body {
    margin: 0; display: grid; place-items: safe center; padding: 3.6vh 7vw;
    background: ${C('--pc-surface')}; color: ${C('--pc-text')};
    font: 500 16px/1.42 var(--pc-font-family, ${CARD_FONT_FAMILY});
    letter-spacing: .01em;
  }
  main { width: min(880px, 100%) }
  h1 { margin: 0 0 .35em; font-size: clamp(30px, 3.6vw, 54px); line-height: 1.12; letter-spacing: -.02em; text-wrap: balance }
  .pc-sub { margin: 0; font-size: clamp(15px, 1.35vw, 21px); color: ${C('--pc-text-body')}; text-wrap: pretty }
  ul.pc-bullets { margin: 1.2em 0 0; padding: 0; list-style: none; display: grid; gap: .45em }
  ul.pc-bullets li { position: relative; padding-left: 1.1em; font-size: clamp(13px, 1.05vw, 17px); color: ${C('--pc-text-body')} }
  ul.pc-bullets li::before { content: ""; position: absolute; left: 0; top: .62em; width: .38em; height: .38em; border-radius: 50%; background: ${C('--pc-accent')} }
  section.pc-check { margin-top: clamp(18px, 2.4vh, 32px); border-top: 1px solid ${C('--pc-border')}; padding-top: clamp(12px, 1.8vh, 22px) }
  .pc-head { display: flex; justify-content: flex-end; align-items: baseline; gap: 1em; margin-bottom: .55em }
  section.pc-check p.pc-check-sub { margin: -.2em 0 .75em; font-size: clamp(12px, .95vw, 15px); color: ${C('--pc-muted')}; text-wrap: pretty }
  section.pc-check h2 { margin: 0 auto 0 0; font-size: clamp(11px, .82vw, 14px); letter-spacing: .13em; text-transform: uppercase; color: ${C('--pc-muted')} }
  ol.pc-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: .45em }
  .pc-row { display: grid; grid-template-columns: 1.05em 1fr; gap: .6em; align-items: center; font-size: clamp(13px, 1.05vw, 17px); color: ${C('--pc-text-body')} }
  .pc-box { width: 1.05em; height: 1.05em; border-radius: 50%; border: 1.6px solid ${C('--pc-ring')}; display: grid; place-items: center }
  .pc-box svg { width: 66%; height: 66%; display: block }
  .pc-box path { fill: none; stroke: ${C('--pc-mark')}; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round }
  .pc-text { justify-self: start }
  .pc-done { color: ${C('--pc-done')} }
  .pc-done .pc-box { background: ${C('--pc-accent')}; border-color: ${C('--pc-accent')} }
  .pc-done .pc-text { text-decoration: line-through; text-decoration-thickness: 1px; text-decoration-color: currentColor }
  .pc-total { font-size: clamp(11px, .82vw, 14px); color: ${C('--pc-muted')}; font-variant-numeric: tabular-nums }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  ${subtitle ? `<p class="pc-sub">${escapeHtml(subtitle)}</p>` : ''}
  ${bullets.length ? `<ul class="pc-bullets">${bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>` : ''}
  ${
    rows
      ? `<section class="pc-check"><div class="pc-head">${heading ? `<h2>${escapeHtml(heading)}</h2>` : ''}<span class="pc-total">${done ? items.length : 0} / ${items.length}</span></div>${note ? `<p class="pc-check-sub">${escapeHtml(note)}</p>` : ''}<ol class="pc-rows">${rows}</ol></section>`
      : ''
  }
</main>
</body>
</html>`;
}
