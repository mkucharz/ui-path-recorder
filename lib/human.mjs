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
function installOverlay({ background, fadeMs, showCursor, ripple, scroll }) {
  if (window.top !== window) return;
  const CURSOR = '__path_cursor';
  const FADE = '__path_fade';
  const STYLE = '__path_human_style';
  const TIP = 2;
  const state = (window.__pathHuman = window.__pathHuman ?? { hidden: false, point: { x: 60, y: 80 } });
  let fadeShown = false;

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
  };
  window.__pathCursorShow = () => {
    state.hidden = false;
    const el = document.getElementById(CURSOR);
    if (el) {
      el.style.transition = 'opacity 120ms linear';
      el.style.opacity = '1';
    }
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

  let current = page;
  let pointer = null;
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
    await nap(options.loadMs);
    // The overlay is per-document, so it is placed again at the pointer's last
    // known position instead of appearing in the top-left corner of every page.
    if (pointer) await call('__pathCursorTo', [pointer.x, pointer.y, 0]);
    await settle();
  }

  async function hold(ms) {
    if (!ms) return;
    await nap(ms);
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
    /** Screenshots, evidence and traces must not contain the pointer. */
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
