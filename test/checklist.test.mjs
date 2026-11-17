/**
 * The checklist: derived from the steps, drawn in the page, ticked on the beat.
 *
 * Two halves, because two different things can be wrong. What the panel *says*
 * (which items, in which order, which one is done) is pure and is checked here
 * without a browser. That it actually draws — arrives, ticks, disappears for a
 * capture, comes back already-ticked after a navigation — needs a document, so
 * one test drives a real browser through `createHuman`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import {
  ACCENT_PATTERN,
  MAX_CHECK_CHARS,
  MAX_ITEMS,
  NARROW_VIEWPORT,
  checklistCss,
  checklistItems,
  checklistOptions,
  squash,
} from '../lib/checklist.mjs';
import { validate } from '../lib/plan.mjs';
import { createHuman } from '../lib/human.mjs';

const PLAN = {
  baseUrl: 'http://example.test',
  steps: [
    { goto: '/', check: 'Open the installer' },
    { click: '#signin', check: '  Sign in as   the operator ' },
    { click: '#target', check: 'Pick the target' },
    { click: '#deploy', check: 'Pick the target' },
  ],
};

/* ------------------------------------------------------------------ *
 * What the panel says
 * ------------------------------------------------------------------ */

test('the items are the steps, in first-appearance order, deduped', () => {
  assert.deepEqual(checklistItems(PLAN), ['Open the installer', 'Sign in as the operator', 'Pick the target']);
  // A step may repeat an item — a flow that returns to a screen should not grow
  // a second row for it.
  assert.equal(checklistItems({ steps: [{ check: 'A' }, { check: 'A' }] }).length, 1);
  // Whitespace is collapsed before it is compared, or two spellings of one row
  // become two rows.
  assert.deepEqual(checklistItems({ steps: [{ check: 'A  b' }, { check: 'A b' }] }), ['A b']);
  assert.deepEqual(checklistItems({}), []);
  assert.deepEqual(checklistItems(null), []);
  assert.equal(squash('  a \n b  '), 'a b');
});

test('the panel defaults are a preference, not a requirement', () => {
  const options = checklistOptions(PLAN);
  assert.equal(options.side, 'right');
  assert.equal(options.width, 300);
  assert.match(options.accent, ACCENT_PATTERN);
  assert.match(options.title, /what you'll do/i);
  assert.equal(options.items.length, 3);

  const overridden = checklistOptions({ ...PLAN, video: { checklist: { title: '', side: 'left', width: 320, accent: '#0f0' } } });
  assert.equal(overridden.title, '');
  assert.equal(overridden.side, 'left');
  assert.equal(overridden.width, 320);
  assert.equal(overridden.accent, '#0f0');

  // No items and no block: nothing to draw, so the overlay is not told about a
  // panel at all.
  assert.equal(checklistOptions({ steps: [{ goto: '/' }] }), null);
});

test('the stylesheet carries the panel and the animation it needs', () => {
  const css = checklistCss();
  // Below the load fade and the caption, above the app: a panel that paints over
  // the subtitle is worse than no panel.
  assert.match(css, /#__path_checklist\{[^}]*z-index:2147483643/);
  assert.match(css, /\.pc-item\.pc-done/);
  assert.match(css, /stroke-dashoffset/);
  // Nothing here suppresses transitions: a rule that did would go on suppressing
  // every tick for the rest of the document, not just the one frame it was
  // written for. A panel that must appear finished is painted before it is
  // inserted instead — see the navigation case below.
  assert.doesNotMatch(css, /transition:\s*none/);
  assert.match(css, /--pc-accent/);
});

/* ------------------------------------------------------------------ *
 * The plan contract
 * ------------------------------------------------------------------ */

const withVideo = (video, steps = PLAN.steps) => ({ baseUrl: 'http://example.test', video, steps });

test('a plan refuses a checklist it cannot draw', () => {
  assert.throws(() => validate(withVideo({ cheklist: {} })), /unknown "video" key "cheklist"/);
  assert.throws(() => validate(withVideo({ checklist: { side: 'middle' } })), /must be "left" or "right"/);
  assert.throws(() => validate(withVideo({ checklist: { width: 100 } })), /width" must be 220–380 pixels/);
  assert.throws(() => validate(withVideo({ checklist: { width: 'wide' } })), /width" must be 220–380 pixels/);
  assert.throws(() => validate(withVideo({ checklist: { accent: 'blue' } })), /accent" must be a #rgb or #rrggbb colour/);
  assert.throws(() => validate(withVideo({ checklist: { title: 7 } })), /title" must be a string/);
  // A panel configured for a list nobody ticks would draw an empty box.
  assert.throws(() => validate(withVideo({ checklist: {} }, [{ goto: '/' }])), /no step carries "check"/);
});

test('a check is a row, not a step and not a paragraph', () => {
  const step = (extra) => ({ baseUrl: 'http://example.test', steps: [{ goto: '/', ...extra }] });
  assert.throws(() => validate(step({ check: '' })), /"check" must be a non-empty string/);
  assert.throws(() => validate(step({ check: '  ' })), /"check" must be a non-empty string/);
  assert.throws(() => validate(step({ check: 'a\nb' })), /"check" must be a single line/);
  assert.throws(() => validate(step({ check: 'x'.repeat(MAX_CHECK_CHARS + 1) })), /"check" is \d+ characters/);
  // A tick with no action has no screen and no duration: it would animate over
  // whatever happened to be there.
  assert.throws(() => validate({ baseUrl: 'http://example.test', steps: [{ check: 'Only a tick' }] }), /does nothing/);
  // Beyond this the panel is a document beside the video.
  const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ goto: '/', check: `Item ${i}` }));
  assert.throws(() => validate({ baseUrl: 'http://example.test', steps: many }), /checklist has \d+ items/);
});

test('a valid checklist validates and warns about nothing', () => {
  const { warnings } = validate(withVideo({ checklist: { title: 'Setup', side: 'left', width: 340, accent: '#f5a97f' } }));
  assert.deepEqual(warnings, []);
  // The items alone are enough: the block is decoration.
  assert.deepEqual(validate(PLAN).warnings, []);
  assert.ok(NARROW_VIEWPORT >= 1280, 'a narrow-warning threshold below 1280 would fire on a normal 1440p page');
});

/* ------------------------------------------------------------------ *
 * The drawing, in a real page
 * ------------------------------------------------------------------ */

/** The bundled browser, or one the host already has — CI installs the former. */
async function launch() {
  const candidates = process.env.CHROME
    ? [{ executablePath: process.env.CHROME }]
    : [
        {},
        { executablePath: '/usr/local/bin/chromium' },
        { executablePath: '/usr/bin/chromium' },
        { executablePath: '/usr/bin/google-chrome' },
      ];
  for (const options of candidates) {
    try {
      return await chromium.launch(options);
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const PANEL = `(() => {
  const el = document.getElementById('__path_checklist');
  if (!el) return null;
  return {
    count: el.querySelector('.pc-count')?.textContent ?? null,
    rows: [...el.querySelectorAll('.pc-item')].map((row) => row.querySelector('.pc-label')?.textContent ?? ''),
    done: [...el.querySelectorAll('.pc-item.pc-done')].map((row) => row.getAttribute('data-check')),
    visible: el.classList.contains('pc-in'),
    title: el.querySelector('.pc-head')?.textContent ?? null,
  };
})()`;

/** Transitions actually running inside the panel, tick or entrance. */
const panelAnimations = (page) =>
  page.evaluate(
    () =>
      document.getAnimations().filter((animation) => {
        const target = animation.effect?.target;
        return (
          animation.playState === 'running' &&
          Boolean(target) &&
          (target.id === '__path_checklist' || Boolean(target.closest?.('#__path_checklist')))
        );
      }).length,
  );

/** The panel paints on the frame after it is appended, so wait for the paint. */
const waitForPanel = (page) =>
  page.waitForFunction(() => {
    const el = document.getElementById('__path_checklist');
    return Boolean(el && el.classList.contains('pc-in') && el.querySelector('.pc-count')?.textContent);
  });


test('the overlay draws the panel, ticks it, and hides it for a capture', async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no browser to draw with');

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.route('http://checklist.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<main><h1>App</h1></main>' }),
    );
    const page = await context.newPage();
    const human = createHuman({
      context,
      page,
      plan: {
        viewport: { width: 1440, height: 900 },
        humanize: { seed: 'panel', loadFade: 0 },
        video: { checklist: { title: 'Setup' } },
        steps: [{ check: 'Open the installer' }, { check: 'Sign in as the operator' }, { check: 'Pick the target' }],
      },
      speed: 200,
    });
    human.attachInit();
    await page.goto('http://checklist.test/');

    // The list arrives with the recording, at 0 / N, with its heading.
    await human.begin();
    await waitForPanel(page);
    assert.deepEqual(await page.evaluate(PANEL), {
      count: '0 / 3',
      rows: ['Open the installer', 'Sign in as the operator', 'Pick the target'],
      done: [],
      visible: true,
      title: 'Setup',
    });
    assert.ok(await page.evaluate(() => Boolean(document.getElementById('__path_checklist_style'))), 'the stylesheet is injected once');
    // The one drawn entrance: the panel slides in and its first row ticks.
    assert.ok((await panelAnimations(page)) > 0, 'the panel animates in once, at the start');

    // A check ticks exactly its own row and moves the counter — the panel is not
    // re-rendered, so the other rows do not animate again.
    await human.check('Sign in as the operator');
    let drawn = await page.evaluate(PANEL);
    assert.deepEqual(drawn.done, ['Sign in as the operator']);
    assert.equal(drawn.count, '1 / 3');
    assert.deepEqual(drawn.rows, ['Open the installer', 'Sign in as the operator', 'Pick the target']);

    // The figure rule: a screenshot must not contain the panel. It is removed,
    // not faded, so the picture is identical to one taken without a checklist.
    await human.hideCursor();
    assert.equal(await page.evaluate(PANEL), null, 'the panel is gone while the capture is taken');
    await human.showCursor();
    drawn = await page.evaluate(PANEL);
    assert.deepEqual(drawn.done, ['Sign in as the operator'], 'the tick survives the capture');

    // A navigation replaces the document that held the list. The new one draws
    // it already ticked and settled — re-animating every row on every page
    // change would read as a second, phantom run.
    // A navigation replaces the document that held the list. The new one draws it
    // already ticked — a row that re-ticks itself on every page change reads as a
    // second, phantom run — which is done by painting the panel before it is
    // inserted, so there is no change for a transition to catch.
    await page.goto('http://checklist.test/second');
    await human.arrive();
    await waitForPanel(page);
    await page.waitForTimeout(100); // long enough for a replayed tick to be visible
    drawn = await page.evaluate(PANEL);
    assert.deepEqual(drawn.done, ['Sign in as the operator']);
    assert.equal(drawn.count, '1 / 3');
    assert.equal(await panelAnimations(page), 0, 'a re-drawn panel replays nothing');

    // And a tick later in that document still animates. A suppression rule would
    // have made every remaining tick pop in silently.
    await human.check('Pick the target');
    assert.ok((await panelAnimations(page)) > 0, 'the next tick still animates');
    drawn = await page.evaluate(PANEL);
    assert.deepEqual(drawn.done, ['Sign in as the operator', 'Pick the target']);
    // The counter is a view of the rows, not a second record of them: a paint
    // queued on the frame after a check must not leave `0 / 3` beside three ticks.
    await human.check('Open the installer');
    drawn = await page.evaluate(PANEL);
    assert.equal(drawn.count, `${drawn.done.length} / 3`);
    assert.equal(drawn.done.length, 3);
  } finally {
    await context.close();
    await browser.close();
  }
});
