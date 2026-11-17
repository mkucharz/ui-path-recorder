/**
 * The checklist a recording ticks off as it goes.
 *
 * A walkthrough shows a path; a viewer still needs to know where the path is
 * going. A list on the side that fills in as the video proceeds is the cheapest
 * way to answer "what is left" — and, like the subtitles, it belongs in the plan
 * rather than in an editor afterwards, because a list typed in afterwards drifts
 * off the steps it describes.
 *
 * There is no second list. The items *are* the steps that carry a `check`, in the
 * order they first appear, so the panel cannot promise something the path does not
 * do and a re-ordered plan cannot leave the sidebar stale.
 *
 * Everything here is pure: the state is an array of texts and the drawing is a
 * stylesheet. The overlay in `lib/human.mjs` owns the DOM and the animation,
 * because it has to run inside the page; this module owns what the panel says.
 */

/** A row that needs more than this is a sentence, and a sentence is a caption. */
export const MAX_CHECK_CHARS = 48;

/**
 * The second line under the heading is a glance, not a paragraph: long enough to
 * say what the list is for, short enough that it stays a phrase rather than
 * pushing the rows out of a narrow panel.
 *
 * It is one line *in the plan* — a newline is refused — but nothing promises a
 * single drawn line: at the 220 px minimum width a full-length one wraps to four
 * rows, which is why the cap is a phrase and not a sentence.
 */
export const MAX_SUBTITLE_CHARS = 80;

/** More rows than this is a document beside the video, not a glance. */
export const MAX_ITEMS = 10;

/**
 * Below this width the panel takes a share of the frame that crowds the app it is
 * docked over. It still draws — the plan may be a deliberately narrow one — but
 * the run says so once, because the alternative is discovering it in a finished
 * recording.
 */
export const NARROW_VIEWPORT = 1280;

export const MIN_PANEL_WIDTH = 220;
export const MAX_PANEL_WIDTH = 380;

/** `#rgb` or `#rrggbb`: a colour a viewer can read a tick against. */
export const ACCENT_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * How the panel sits in the frame.
 *
 * `overlay` floats over the app on a translucent card — right for an app that
 * fills its window, and the only option that changes nothing about the page.
 * `dock` reserves a column of its own: the page is laid out beside the panel
 * instead of underneath it, so no control is ever covered and the recording can
 * hand the app every pixel it was designed for. The reservation is the price —
 * an app that paints itself in `100vw` units ignores it, and a plan that docks
 * should be checked once against the real screen.
 */
export const LAYOUTS = Object.freeze(['overlay', 'dock']);

export const CHECKLIST_DEFAULTS = Object.freeze({
  title: "What you'll do",
  subtitle: '',
  side: 'right',
  width: 300,
  layout: 'overlay',
  accent: '#7c9cf5',
});

/** A caption, a check and an item label are all one line: collapse, then trim. */
export const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * The checklist, derived from the steps.
 *
 * Order is first appearance, and a repeated `check` is one item: a flow that
 * returns to the same screen should not grow a second row for it.
 */
export function checklistItems(plan) {
  const items = [];
  for (const step of plan?.steps ?? []) {
    const text = squash(step?.check);
    if (text && !items.includes(text)) items.push(text);
  }
  return items;
}

/**
 * The panel's configuration, or `null` when this plan has no checklist at all.
 *
 * `video.checklist` is optional: the items alone are enough, and everything it
 * can say is a preference about how the list is drawn.
 */
export function checklistOptions(plan) {
  const items = checklistItems(plan);
  const block = plan?.video?.checklist ?? null;
  if (!items.length && !block) return null;
  const options = { ...CHECKLIST_DEFAULTS, ...(block ?? {}), items };
  // An unknown layout is a typo, not a wish: fall back to the one that changes
  // nothing about the page. `validate` refuses it first, so this only covers a
  // plan assembled in code rather than read from disk.
  if (!LAYOUTS.includes(options.layout)) options.layout = CHECKLIST_DEFAULTS.layout;
  return options;
}

/**
 * The width the page gives up so a docked panel can sit beside it.
 *
 * Nothing for an overlay, which covers the app instead of moving it. The docked
 * case is the panel plus its edge: the app column ends where the panel begins,
 * so the two never touch.
 */
export function checklistReserve(cfg) {
  return cfg?.layout === 'dock' ? Math.round(cfg.width) : 0;
}

/**
 * The panel's stylesheet. Passed into the page once per document, because the
 * overlay has to run inside the recorder's browser and cannot import this file.
 *
 * It is a `<style>` block rather than inline styles on purpose: the tick is a
 * `stroke-dashoffset` transition on an SVG path and the strike-through is a
 * `scaleX` on a pseudo-element — neither can be expressed as an inline
 * declaration on the element that changes. The configurable values arrive as
 * custom properties on the panel element, so one stylesheet serves every plan.
 *
 * A panel that must appear already finished is painted before it is inserted
 * (see `renderChecklist` in `lib/human.mjs`), so nothing here needs a rule that
 * suppresses transitions — and a suppression rule would go on suppressing every
 * tick for the rest of the document.
 */
export function checklistCss() {
  return `
#__path_checklist{position:fixed;top:50%;right:var(--pc-gap);left:auto;width:min(var(--pc-w),30vw);box-sizing:border-box;max-height:76vh;overflow:hidden;padding:14px 16px 12px;border-radius:14px;background:rgba(10,13,20,.84);border:1px solid rgba(255,255,255,.12);box-shadow:0 18px 40px rgba(0,0,0,.45);backdrop-filter:blur(10px) saturate(1.1);color:#eef2fa;font:500 clamp(12px,.95vw,17px)/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;letter-spacing:.01em;pointer-events:none;z-index:2147483643;opacity:0;transform:translateY(-50%) translateX(14px);transition:opacity .3s ease,transform .34s cubic-bezier(.2,.8,.2,1)}
#__path_checklist.pc-left{right:auto;left:var(--pc-gap);transform:translateY(-50%) translateX(-14px)}
#__path_checklist.pc-in{opacity:1;transform:translateY(-50%) translateX(0)}
/* A docked panel is a column, so the page gives up that column: the two never
   overlap and no control is ever covered. The reservation is keyed off the root
   so it survives the panel being removed for a figure — the page must not
   reflow between the video and the picture of it. */
html[data-pc-dock="right"]{margin-right:var(--pc-dock,0px)}
html[data-pc-dock="left"]{margin-left:var(--pc-dock,0px)}
#__path_checklist.pc-dock{top:0;bottom:0;right:0;left:auto;width:var(--pc-w);max-height:none;border-radius:0;border:0;border-left:1px solid rgba(255,255,255,.09);background:#0d121b;box-shadow:-18px 0 38px rgba(0,0,0,.3);backdrop-filter:none;padding:clamp(18px,3.4vh,36px) clamp(16px,1.6vw,28px);display:flex;flex-direction:column;justify-content:center;transform:translateX(12px)}
#__path_checklist.pc-dock.pc-left{left:0;right:auto;border-left:0;border-right:1px solid rgba(255,255,255,.09);box-shadow:18px 0 38px rgba(0,0,0,.3);transform:translateX(-12px)}
#__path_checklist.pc-dock.pc-in{transform:none}
#__path_checklist.pc-dock .pc-head-group{margin-bottom:clamp(12px,2.2vh,22px)}
#__path_checklist.pc-dock .pc-items{gap:clamp(10px,1.4vh,16px)}
#__path_checklist.pc-dock .pc-count{margin-top:auto;padding-top:clamp(12px,2vh,22px)}
/* The heading and its second line are one block, so the gap under them is the
   group's: a panel with a heading alone and a panel with a heading and a line
   keep the same distance to the first row. */
#__path_checklist .pc-head-group{margin-bottom:10px}
#__path_checklist .pc-head{font-size:.72em;letter-spacing:.13em;text-transform:uppercase;color:#93a0b6}
#__path_checklist .pc-sub{margin-top:5px;color:#8593a8;font-size:.86em;line-height:1.45;text-wrap:balance}
#__path_checklist.pc-dock .pc-sub{font-size:.95em}
#__path_checklist .pc-items{list-style:none;margin:0;padding:0;display:grid;gap:9px}
#__path_checklist .pc-item{display:grid;grid-template-columns:17px 1fr;gap:9px;align-items:start;color:#c8d1e0;transition:color .25s ease}
#__path_checklist .pc-box{width:17px;height:17px;box-sizing:border-box;border-radius:50%;border:1.6px solid rgba(255,255,255,.3);display:grid;place-items:center;margin-top:.1em;transition:background .25s ease,border-color .25s ease}
#__path_checklist .pc-box svg{width:11px;height:11px;display:block}
#__path_checklist .pc-box path{fill:none;stroke:#0b0e14;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:12;stroke-dashoffset:12;transition:stroke-dashoffset .26s ease-out .05s}
#__path_checklist .pc-label{justify-self:start;display:inline-block;max-width:100%;position:relative;transition:opacity .3s ease}
#__path_checklist .pc-label::after{content:"";position:absolute;left:0;right:0;top:55%;height:1px;background:currentColor;opacity:.45;transform:scaleX(0);transform-origin:left;transition:transform .3s ease .04s}
#__path_checklist .pc-item.pc-done{color:#79859a}
#__path_checklist .pc-item.pc-done .pc-box{background:var(--pc-accent);border-color:var(--pc-accent)}
#__path_checklist .pc-item.pc-done .pc-box path{stroke-dashoffset:0}
#__path_checklist .pc-item.pc-done .pc-label{opacity:.85}
#__path_checklist .pc-item.pc-done .pc-label::after{transform:scaleX(1)}
#__path_checklist .pc-count{margin-top:11px;text-align:right;font-size:.76em;color:#8593a8;font-variant-numeric:tabular-nums}`;
}
