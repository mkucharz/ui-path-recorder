/**
 * human — make a scripted run look like a person driving it.
 *
 * A figure does not care how fast a click happened; a video does. Playwright's
 * screencast draws no pointer at all and dispatches a click the instant it is
 * asked, so a recorded walkthrough reads as teleporting, cursorless and
 * machine-paced — which is exactly what it is.
 *
 * This module adds the two things a viewer needs to follow a flow:
 *
 *   1. **A visible pointer.** An in-page overlay (`#__path_cursor`) injected
 *      before any script runs. It is a *depiction*, not a capture: it is placed
 *      at the coordinates the runner actually dispatches, so it cannot point
 *      somewhere the plan did not. It is hidden before every screenshot,
 *      evidence capture and trace frame, and re-shown after.
 *
 *   2. **Human pacing.** Travel along a curved path with eased velocity, a hover
 *      dwell before the press, a real key-by-key typing cadence, a scroll that
 *      animates, and a beat of stillness after an action before the next one.
 *
 *   3. **A checklist beside the page.** The items are the steps that carry a
 *      `check` (see `lib/checklist.mjs`), so the list cannot promise something
 *      the path does not do. Each row ticks on the same beat as the subtitle of
 *      the step that completes it. It is drawn in the page for the same reason
 *      the pointer is — and obeys the same rule: a capture removes it.
 *
 * Everything is sampled from a **seeded** generator, so a run is replayable: the
 * same seed and the same plan produce the same path, the same typing rhythm and
 * the same total of scheduled delays. `.timeline.json` records those scheduled
 * milliseconds separately from wall-clock time, because only the first is
 * reproducible.
 *
 * Interaction still goes through Playwright's actionability checks first
 * (`locator.click({ trial: true })` — visible, stable, receives events,
 * enabled; it fires nothing), so a humanized click cannot silently hit nothing:
 * if the target moved between the check and the press, the click misses and the
 * plan's `expect`/`waitFor` fails the run exactly as it does today.
 *
 * When `enabled` is false every method delegates to the plain Playwright call it
 * replaces, so the runner has one code path and `--no-humanize` is the same run
 * as before this module existed.
 */

import { checklistCss, checklistOptions, squash } from './checklist.mjs';

/** Defaults. A plan's `humanize` block overrides these key by key. */
export const DEFAULTS = {
  enabled: true,
  speed: 1,
  cursor: 'arrow',
  clickRipple: true,
  moveMs: [220, 640],
  dwellMs: [80, 220],
  pressMs: [60, 120],
  afterMs: [180, 420],
  typing: { minMs: 55, maxMs: 140, maxChars: 40, longValueLead: 6 },
  shotHoldMs: 1200,
  loadMs: 400,
  loadFade: 180,
};

/** Merge a plan's `humanize` block over the defaults, keeping nested typing. */
export function resolveOptions(humanize = {}, { speed } = {}) {
  const merged = { ...DEFAULTS, ...humanize, typing: { ...DEFAULTS.typing, ...(humanize.typing ?? {}) } };
  if (speed !== undefined && speed !== null) merged.speed = speed;
  return merged;
}

/* ------------------------------------------------------------------ *
 * Deterministic sampling
 * ------------------------------------------------------------------ */

/** FNV-1a: a stable 32-bit hash, so a seed string is a seed string. */
function hashSeed(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 1;
}

/** mulberry32 — small, fast, and identical across runs and platforms. */
export function createRng(seed) {
  let state = hashSeed(seed);
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** Cubic ease-in-out: slow at both ends, which is how a hand moves. */
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const cubic = (a, b, c, d, t) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;

/**
 * A curved path from one point to another.
 *
 * Control points are pushed perpendicular to the straight line, so two points
 * 400 px apart produce an arc rather than a ruler line — and the perpendicular
 * offset is what stops consecutive clicks looking like the same laser track.
 * Positions are sampled at an eased parameter, but spaced at uniform *times*,
 * so velocity ramps up in the middle and settles at the end.
 *
 * @returns {{points: Array<{x:number,y:number}>, durationMs: number}}
 */
export function travelPath(from, to, rng, { samples = 14, moveMs = DEFAULTS.moveMs } = {}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const durationMs = clamp(180 + 0.28 * distance, moveMs[0], moveMs[1]);
  if (distance < 3) return { points: [{ x: to.x, y: to.y }], durationMs: 0 };

  const nx = -dy / distance;
  const ny = dx / distance;
  const bow = (rng() - 0.5) * distance * 0.5;
  const c1 = { x: from.x + dx * 0.28 + nx * bow, y: from.y + dy * 0.28 + ny * bow };
  const c2 = { x: from.x + dx * 0.72 + nx * bow * 0.7, y: from.y + dy * 0.72 + ny * bow * 0.7 };

  const points = [];
  for (let i = 1; i <= samples; i += 1) {
    const u = easeInOutCubic(i / samples);
    points.push({ x: cubic(from.x, c1.x, c2.x, to.x, u), y: cubic(from.y, c1.y, c2.y, to.y, u) });
  }
  return { points, durationMs };
}

/* ------------------------------------------------------------------ *
 * The in-page overlay
 * ------------------------------------------------------------------ */

/**
 * Runs in every top-level document before its own scripts, so the pointer
 * exists from the first frame and survives navigation. The window functions it
 * publishes are the node side's only handle on the picture.
 */
function installOverlay({ background, fadeMs, showCursor, ripple, scroll, checklist, checklistCss }) {
  if (window.top !== window) return;
  const CURSOR = '__path_cursor';
  const CAPTION = '__path_caption';
  const CHECKLIST = '__path_checklist';
  const CHECKLIST_STYLE = '__path_checklist_style';
  const FADE = '__path_fade';
  const STYLE = '__path_human_style';
  const TIP = 2;
  const state = (window.__pathHuman = window.__pathHuman ?? { hidden: false, point: { x: 60, y: 80 }, caption: '' });
  // Every top-level document is a new overlay with no list: the node side tells
  // it which items are done (see `__pathChecklist`), and until it does the panel
  // is deliberately absent — the load fade covers that gap.
  state.checklist = checklist ?? null;
  if (state.checklistDone === undefined) state.checklistDone = null;
  let fadeShown = false;

  /**
   * The subtitle for the step now running.
   *
   * It is drawn in the page, not composited into the recording afterwards, so it
   * needs no encoder that can render text and it cannot drift off the frame it
   * describes. That also means it must obey the *figure* rule: a picture is
   * evidence, and a subtitle is a depiction — so it is removed with the pointer
   * and put back the moment the capture is over.
   */
  const renderCaption = () => {
    const root = document.documentElement;
    if (!root) return;
    const el = document.getElementById(CAPTION);
    const text = state.hidden ? '' : String(state.caption ?? '').trim();
    if (!text) {
      if (el) el.remove();
      return;
    }
    if (el) {
      if (el.textContent !== text) el.textContent = text;
      return;
    }
    const pill = document.createElement('div');
    pill.id = CAPTION;
    pill.setAttribute('aria-hidden', 'true');
    pill.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:clamp(18px,3.4vh,46px)',
      'transform:translateX(-50%)',
      'max-width:min(84vw,64ch)',
      'padding:.5em 1.05em',
      'border-radius:999px',
      'background:rgba(9,12,18,.84)',
      'border:1px solid rgba(255,255,255,.13)',
      'color:#f2f5fb',
      "font:500 clamp(14px,1.75vw,30px)/1.32 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      'letter-spacing:.01em',
      'text-align:center',
      'text-wrap:balance',
      'box-shadow:0 10px 28px rgba(0,0,0,.42)',
      'pointer-events:none',
      // Below the load fade, so a subtitle arrives with the page it belongs to
      // instead of sitting on top of a white (or black) curtain.
      'z-index:2147483644',
    ].join(';');
    pill.textContent = text;
    root.appendChild(pill);
  };

  /**
   * The checklist panel, built from the plan's steps.
   *
   * Everything is created with DOM calls rather than an HTML string: the item
   * texts come from the plan and are set as text, so a label containing `<` is
   * a label and not markup. The class names are the ones `checklistCss` styles.
   */
  const buildChecklist = (cfg) => {
    const el = document.createElement('div');
    el.id = CHECKLIST;
    el.setAttribute('aria-hidden', 'true');
    if (cfg.side === 'left') el.classList.add('pc-left');
    el.style.setProperty('--pc-accent', cfg.accent);
    el.style.setProperty('--pc-w', `${cfg.width}px`);
    el.style.setProperty('--pc-gap', 'clamp(16px,2.5vw,44px)');

    if (cfg.title) {
      const head = document.createElement('div');
      head.className = 'pc-head';
      head.textContent = cfg.title;
      el.appendChild(head);
    }

    const list = document.createElement('ol');
    list.className = 'pc-items';
    for (const text of cfg.items) {
      const item = document.createElement('li');
      item.className = 'pc-item';
      item.setAttribute('data-check', text);
      const box = document.createElement('span');
      box.className = 'pc-box';
      box.innerHTML =
        '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.4 6.5 L4.9 9 L9.6 3.4"/></svg>';
      const label = document.createElement('span');
      label.className = 'pc-label';
      label.textContent = text;
      item.append(box, label);
      list.appendChild(item);
    }
    el.appendChild(list);

    const count = document.createElement('div');
    count.className = 'pc-count';
    el.appendChild(count);
    return el;
  };

  /**
   * Tick the rows that are done and keep the counter honest.
   *
   * Only the class is added, so the tick and the strike-through animate — a full
   * re-render would restart the row that just moved and leave the rest blank. The
   * state is read from `window.__pathHuman` rather than captured, because a paint
   * can be queued on the frame after a `check` that has already moved on.
   */
  const paintChecklist = (el) => {
    const done = new Set(state.checklistDone ?? []);
    let ticked = 0;
    const rows = el.querySelectorAll('.pc-item');
    for (const row of rows) {
      if (!done.has(row.getAttribute('data-check'))) continue;
      row.classList.add('pc-done');
      ticked += 1;
    }
    const count = el.querySelector('.pc-count');
    if (count) count.textContent = `${ticked} / ${rows.length}`;
  };

  /**
   * Draw, update, or remove the panel.
   *
   * `animate` is for the one moment the panel is supposed to arrive in front of
   * the viewer. Every other draw is settled: the first frame of a new document
   * after a navigation, and the frame after a capture, are already-ticked lists,
   * and a list that re-ticks itself on every page change reads as a bug.
   *
   * The order is what makes that true, not a flag: a settled panel is *painted
   * before it is inserted*, so when it first has a computed style the ticks are
   * already there and there is no change to transition. Its `pc-in` goes on at
   * the same moment, so it does not slide in either — and because nothing is
   * suppressed afterwards, a row ticked later in the same document still
   * animates like every other.
   */
  const renderChecklist = (animate = false) => {
    const root = document.documentElement;
    if (!root) return;
    const cfg = state.checklist;
    if (!cfg || !cfg.items?.length || state.checklistDone === null || state.hidden) {
      const gone = document.getElementById(CHECKLIST);
      if (gone) gone.remove();
      return;
    }

    let el = document.getElementById(CHECKLIST);
    if (el) {
      paintChecklist(el);
      return;
    }

    if (!document.getElementById(CHECKLIST_STYLE)) {
      const style = document.createElement('style');
      style.id = CHECKLIST_STYLE;
      style.textContent = checklistCss ?? '';
      root.appendChild(style);
    }

    el = buildChecklist(cfg);
    if (!animate) {
      // Painted before it is in the document, so its first computed style is the
      // finished one: no tick, no slide-in, nothing to replay on a page change.
      paintChecklist(el);
      el.classList.add('pc-in');
      root.appendChild(el);
      return;
    }
    // The one drawn entrance: in the document at rest first, then a forced style
    // read (an appended element has no computed style until something asks for
    // one) and only then shown and ticked — otherwise both would be the state the
    // panel was born in rather than a transition.
    root.appendChild(el);
    void el.offsetWidth;
    el.classList.add('pc-in');
    paintChecklist(el);
  };

  /**
   * Everything attaches to `document.documentElement`, and only once it exists.
   * At document-start Chromium has no root yet — the trap is appending to
   * `document` as a fallback, which *makes the appended node the document
   * element* and leaves the real page with no root at all.
   */
  const ensureFrame = () => {
    const root = document.documentElement;
    if (!root) return false;

    // The first paint of a navigation is otherwise a white flash in the video.
    // A background on the root is overpainted by the app's own paint.
    if (background) root.style.backgroundColor = background;

    if (!document.getElementById(STYLE)) {
      const style = document.createElement('style');
      style.id = STYLE;
      // Playwright's own scroll-into-view animates once the page says it may,
      // which is what makes a scroll read as a scroll instead of a jump cut.
      style.textContent = scroll
        ? 'html{scroll-behavior:smooth}@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}'
        : '';
      root.appendChild(style);
    }

    if (showCursor && !document.getElementById(CURSOR)) {
      const el = document.createElement('div');
      el.id = CURSOR;
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = [
        'position:fixed',
        'left:0',
        'top:0',
        'width:24px',
        'height:24px',
        'pointer-events:none',
        'z-index:2147483647',
        'will-change:transform,opacity',
        `transform:translate3d(${state.point.x - TIP}px,${state.point.y - TIP}px,0)`,
        'opacity:1',
      ].join(';');
      // White pointer with a dark outline: legible on a dark app and a light one.
      el.innerHTML =
        '<svg width="24" height="24" viewBox="0 0 24 24" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">' +
        '<path d="M2 2 L2 19.2 L7.1 14.4 L10 20.6 L13.2 19.1 L10.3 13 L16.8 12.6 Z" ' +
        'fill="#fff" stroke="#111318" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      root.appendChild(el);
    }

    // The fade needs a body to cover: created after the parser has one, so it
    // never overlays a half-built document.
    if (fadeMs > 0 && background && document.body && !fadeShown) {
      fadeShown = true;
      const fade = document.createElement('div');
      fade.id = FADE;
      fade.setAttribute('aria-hidden', 'true');
      fade.style.cssText = [
        'position:fixed',
        'inset:0',
        'pointer-events:none',
        'z-index:2147483645',
        `background:${background}`,
        'opacity:1',
        `transition:opacity ${fadeMs}ms linear`,
      ].join(';');
      root.appendChild(fade);
      requestAnimationFrame(() => {
        fade.style.opacity = '0';
        setTimeout(() => fade.remove(), fadeMs + 120);
      });
    }

    const cursor = document.getElementById(CURSOR);
    if (cursor) cursor.style.opacity = state.hidden ? '0' : '1';
    // A new document has a fresh overlay and no subtitle: `ensureFrame` is what
    // puts back what the node side last asked for.
    renderCaption();
    renderChecklist(false);
    return true;
  };

  const place = (x, y, ms) => {
    const el = document.getElementById(CURSOR);
    if (!el) return;
    state.point = { x, y };
    el.style.transition = ms > 0 ? `transform ${ms}ms cubic-bezier(.33,.75,.24,1)` : 'none';
    el.style.transform = `translate3d(${x - TIP}px, ${y - TIP}px, 0)`;
  };

  window.__pathCursorTo = (x, y, ms) => {
    ensureFrame();
    place(x, y, ms);
  };
  window.__pathCursorHide = () => {
    state.hidden = true;
    for (const id of [CURSOR, FADE]) {
      const el = document.getElementById(id);
      if (el) {
        el.style.transition = 'none';
        el.style.opacity = '0';
      }
    }
    // No transition on the way out either: a subtitle that fades away for the
    // length of a screenshot is a flicker a viewer notices.
    renderCaption();
    // The panel is a depiction too, and it is *removed* rather than faded so a
    // figure is byte-identical to one captured without a checklist.
    const panel = document.getElementById(CHECKLIST);
    if (panel) panel.remove();
  };
  window.__pathCursorShow = () => {
    state.hidden = false;
    const el = document.getElementById(CURSOR);
    if (el) {
      el.style.transition = 'opacity 120ms linear';
      el.style.opacity = '1';
    }
    renderCaption();
    renderChecklist(false);
    // Resolve on the frame that carries the restored chrome, not before it. The
    // recorder resumes here, and everything composited while the page still had
    // no pointer belongs to the figure — two frames of a bare page after resume
    // is exactly the flash this exists to prevent.
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    });
  };
  /**
   * Set (or clear, with an empty string) the subtitle for what is on screen. The
   * node side owns the text: the page only draws it.
   */
  window.__pathCaption = (text) => {
    state.caption = String(text ?? '');
    // Before the document has a root this is a no-op: the overlay's own retry
    // draws it as soon as one exists.
    renderCaption();
  };
  /**
   * Set the checklist state: which items are ticked, and whether this is the
   * panel's entrance. The node side owns the list; the page only draws it.
   */
  window.__pathChecklist = (done, animate) => {
    state.checklistDone = Array.isArray(done)
      ? done.map((text) => String(text ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean)
      : [];
    renderChecklist(Boolean(animate));
  };
  window.__pathCursorPress = (down) => {
    const el = document.getElementById(CURSOR);
    if (el) el.style.filter = down ? 'brightness(.85)' : '';
  };
  window.__pathRipple = (x, y) => {
    if (!ripple) return;
    const root = document.documentElement;
    if (!root) return;
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = [
      'position:fixed',
      `left:${x - 20}px`,
      `top:${y - 20}px`,
      'width:40px',
      'height:40px',
      'border-radius:50%',
      'pointer-events:none',
      'z-index:2147483646',
      'background:radial-gradient(circle,rgba(122,162,247,.55) 0%,rgba(122,162,247,0) 70%)',
      'transform:scale(.35)',
      'opacity:.95',
      'transition:transform 420ms ease-out,opacity 420ms ease-out',
    ].join(';');
    root.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = 'scale(1.7)';
      el.style.opacity = '0';
    });
    setTimeout(() => el.remove(), 520);
  };

  if (!ensureFrame()) {
    // document-start has no root in Chromium: wait for one, then stop retrying.
    document.addEventListener('DOMContentLoaded', () => ensureFrame(), { once: true });
    let attempts = 0;
    const tick = () => {
      if (ensureFrame()) return;
      if ((attempts += 1) < 120) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

/* ------------------------------------------------------------------ *
 * The node side
 * ------------------------------------------------------------------ */

const now = () => Date.now();

/**
 * @param {object} opts
 * @param {import('playwright-core').BrowserContext} opts.context
 * @param {import('playwright-core').Page|null} opts.page  Replaced by `setPage` on a new tab.
 * @param {any} [opts.plan]
 * @param {boolean} [opts.enabled]
 * @param {string} [opts.seed]
 * @param {number} [opts.speed]
 * @param {string} [opts.maskColor]
 */
export function createHuman({ context, page = null, plan = null, enabled = true, seed = 'default', speed, maskColor = '#0a0e14' }) {
  const options = resolveOptions(plan?.humanize ?? {}, { speed });
  const active = Boolean(enabled) && options.enabled !== false;
  const rng = createRng(seed);
  const background = (plan?.colorScheme ?? 'dark') === 'light' ? '#ffffff' : maskColor;
  const checklist = checklistOptions(plan);

  let current = page;
  let pointer = null;
  /** The subtitle the plan asked for, so a new document can be told again. */
  let captionText = '';
  /** The items ticked so far, in the order the plan ticked them. */
  let checked = [];
  /**
   * Whether the panel has been drawn at all. Only the first draw animates in;
   * every draw after a navigation is already-ticked and must not re-animate.
   */
  let checklistShown = false;
  /** Scheduled human delay since the last drain — deterministic, unlike wall time. */
  let planned = 0;

  const scaled = (ms) => Math.max(0, ms / (options.speed || 1));
  const between = ([min, max]) => min + rng() * Math.max(0, max - min);

  /** A delay we chose: counted in `planned`, so a timeline can be reproduced. */
  async function nap(ms) {
    const delay = scaled(ms);
    planned += delay;
    if (delay >= 1) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async function call(name, args = []) {
    if (!current) return;
    await current
      .evaluate(({ name, args }) => {
        const fn = window[name];
        if (typeof fn === 'function') return fn(...args);
      }, { name, args })
      .catch(() => {
        /* mid-navigation, or a page whose scripts never installed the overlay */
      });
  }

  const viewportSize = () => current?.viewportSize?.() ?? plan?.viewport ?? { width: 1600, height: 900 };

  /**
   * The caption lives in the page, so a navigation replaces the document that is
   * holding it. Anything that waits for a page to hold still is also the moment
   * to say the subtitle again — which is what keeps one caption across a
   * navigation inside a single step.
   */
  async function applyCaption() {
    if (!active || !captionText) return;
    await call('__pathCaption', [captionText]);
  }

  /**
   * The checklist, for the same reason: it lives in the page, so a navigation
   * replaces the document that is holding it. Anything that waits for a page to
   * hold still is also the moment to draw the list again — settled, with the
   * items already ticked, so a page change never re-runs the ticks.
   */
  async function applyChecklist() {
    if (!active || !checklist) return;
    await call('__pathChecklist', [checked, !checklistShown]);
    checklistShown = true;
  }

  /** A point inside the box but not its dead centre — people aim approximately. */
  function aimPoint(box) {
    const pad = Math.min(14, box.width * 0.2, box.height * 0.2);
    const vp = viewportSize();
    const x = box.x + pad + rng() * Math.max(0, box.width - pad * 2);
    const y = box.y + pad + rng() * Math.max(0, box.height - pad * 2);
    return { x: clamp(x, 1, vp.width - 1), y: clamp(y, 1, vp.height - 1) };
  }

  /**
   * Wait for the page to hold still. A smooth scroll is an animation, so a box
   * measured during it is the box *before* it — aiming at that point clicks
   * whatever happened to be there.
   */
  async function settle({ timeout = 1_500 } = {}) {
    if (!active || !current) return;
    // The page may have replaced its document since the caption was set; this is
    // the first moment it is worth saying it again.
    await applyCaption();
    await applyChecklist();
    const deadline = now() + timeout;
    let previous = null;
    let stable = 0;
    while (now() < deadline) {
      const at = await current.evaluate(() => `${Math.round(window.scrollY)}:${Math.round(window.scrollX)}`).catch(() => null);
      if (at === null) return;
      if (at === previous) {
        stable += 1;
        if (stable >= 2) return;
      } else {
        stable = 0;
        previous = at;
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  async function moveTo(x, y) {
    if (!active || !current) return;
    const from = pointer ?? { x: 0, y: 0 };
    const { points, durationMs } = travelPath(from, { x, y }, rng, { moveMs: options.moveMs });
    const duration = scaled(durationMs);
    const started = now();
    await call('__pathCursorTo', [x, y, duration]);
    for (const [index, point] of points.entries()) {
      await current.mouse.move(point.x, point.y);
      const due = started + (duration * (index + 1)) / points.length;
      const wait = due - now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    planned += duration;
    pointer = { x, y };
  }

  /** The element a locator (or a chained `.first()`) points at. */
  const first = (locator) => (typeof locator.first === 'function' ? locator.first() : locator);

  async function pressAndRelease() {
    await call('__pathCursorPress', [true]);
    await current.mouse.down({ button: 'left' });
    await nap(between(options.pressMs));
    await current.mouse.up({ button: 'left' });
    await call('__pathCursorPress', [false]);
  }

  /**
   * A click a viewer can follow: actionability check, travel, hover, press.
   * The trial check is Playwright's own — it is the difference between "the
   * mouse landed somewhere" and "the element was clickable when we left".
   */
  async function click(locator, { timeout = 20_000 } = {}) {
    const el = first(locator);
    if (!active) {
      await el.click({ timeout });
      return;
    }
    await el.waitFor({ state: 'visible', timeout });
    await el.click({ trial: true, timeout });
    await settle();
    const box = await el.boundingBox();
    if (!box) throw new Error('target has no box to aim at — it may have been hidden by a script');
    const point = aimPoint(box);
    await moveTo(point.x, point.y);
    await nap(between(options.dwellMs));
    await pressAndRelease();
    if (options.clickRipple && options.cursor !== 'none') await call('__pathRipple', [point.x, point.y]);
    await nap(between(options.afterMs));
  }

  /** Type into whatever has focus, one real key event at a time. */
  async function typeKeys(text) {
    const { minMs, maxMs } = options.typing;
    for (const char of text) {
      await current.keyboard.type(char);
      let delay = minMs + rng() * Math.max(0, maxMs - minMs);
      // A hand lingers after a delimiter, and occasionally stops to think.
      if (/[ .,\-@/:_]/.test(char)) delay *= 1.8;
      if (rng() < 0.06) delay += 260 + rng() * 340;
      await nap(delay);
    }
  }

  /**
   * `fill` as a person does it: click the field, select what is there, type.
   * A long value (a URL, a token) would take half a minute at a human cadence,
   * so the first few characters are typed and the rest arrives in one paste —
   * which is also what a person does with a long value.
   */
  async function fill(locator, text) {
    const el = first(locator);
    if (!active) {
      await el.fill(text);
      return;
    }
    await click(el);
    await current.keyboard.press('ControlOrMeta+A').catch(() => {});
    const { maxChars, longValueLead } = options.typing;
    if (text.length > maxChars) {
      await typeKeys(text.slice(0, longValueLead));
      await current.keyboard.insertText(text.slice(longValueLead));
      await nap(between(options.afterMs));
    } else {
      await typeKeys(text);
    }
  }

  async function type(locator, text) {
    const el = first(locator);
    if (!active) {
      await el.click();
      await el.pressSequentially(text, { delay: 10 });
      return;
    }
    await click(el);
    await typeKeys(text);
  }

  async function press(locator, key) {
    const el = first(locator);
    if (!active) {
      await el.press(key);
      return;
    }
    await el.click({ trial: true }).catch(() => {});
    await settle();
    await el.focus().catch(() => {});
    await nap(between(options.dwellMs));
    await current.keyboard.press(key);
    await nap(between(options.afterMs));
  }

  /** After a navigation: let the page paint, then wait for it to hold still. */
  async function arrive() {
    if (!active) return;
    // The subtitle belongs to the first frame of the new page, not to whenever
    // the page stopped moving: say it before the wait, not after it.
    await applyCaption();
    await applyChecklist();
    await nap(options.loadMs);
    // The overlay is per-document, so it is placed again at the pointer's last
    // known position instead of appearing in the top-left corner of every page.
    if (pointer) await call('__pathCursorTo', [pointer.x, pointer.y, 0]);
    await settle();
  }

  async function hold(ms) {
    if (!ms) return;
    // A hold is usually the beat after a click that swapped the screen; if the
    // swap came with a navigation, this is where the subtitle comes back.
    await applyCaption();
    await applyChecklist();
    await nap(ms);
  }

  /**
   * The step's subtitle: shown in every frame it runs for, and cleared by an
   * empty value. It is not part of the figure — the overlay removes it with the
   * pointer for a capture.
   */
  async function caption(text) {
    if (!active) return;
    const next = String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    captionText = next;
    await call('__pathCaption', [next]);
  }

  /**
   * Tick a checklist item, at the moment the step that completes it starts — the
   * same beat as that step's subtitle, so the list and the picture agree.
   */
  async function check(text) {
    if (!active) return;
    const item = squash(text);
    if (!item || !checklist) return;
    if (!checked.includes(item)) checked = [...checked, item];
    await applyChecklist();
  }

  async function begin() {
    if (!active || !current) return;
    if (!pointer) {
      const vp = viewportSize();
      const start = { x: Math.round(vp.width * 0.62), y: Math.round(vp.height * 0.72) };
      pointer = start;
      await current.mouse.move(start.x, start.y).catch(() => {});
    }
    await call('__pathCursorTo', [pointer.x, pointer.y, 0]);
    // The list arrives once, on the first frame of the recording, at 0 / N.
    await applyChecklist();
  }

  return {
    enabled: active,
    options,
    attachInit() {
      if (!active) return;
      context.addInitScript(installOverlay, {
        background,
        fadeMs: scaled(options.loadFade),
        showCursor: options.cursor !== 'none',
        ripple: Boolean(options.clickRipple),
        scroll: true,
        checklist,
        checklistCss: checklist ? checklistCss() : '',
      });
    },
    setPage(next) {
      current = next;
    },
    begin,
    click,
    fill,
    type,
    press,
    moveTo,
    settle,
    arrive,
    hold,
    caption,
    check,
    /** Screenshots, evidence and traces must not contain the pointer, a subtitle or the checklist. */
    hideCursor: () => call('__pathCursorHide'),
    showCursor: () => call('__pathCursorShow'),
    /** Scheduled milliseconds since the last call — the reproducible half of a timeline. */
    plannedMsSince() {
      const value = Math.round(planned);
      planned = 0;
      return value;
    },
  };
}
