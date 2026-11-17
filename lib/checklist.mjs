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

export const CHECKLIST_DEFAULTS = Object.freeze({
  title: "What you'll do",
  side: 'right',
  width: 300,
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
  return { ...CHECKLIST_DEFAULTS, ...(block ?? {}), items };
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
#__path_checklist .pc-head{font-size:.72em;letter-spacing:.13em;text-transform:uppercase;color:#93a0b6;margin-bottom:10px}
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
