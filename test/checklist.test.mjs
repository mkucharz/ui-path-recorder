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
  MAX_SUBTITLE_CHARS,
  NARROW_VIEWPORT,
  checklistCss,
  checklistItems,
  checklistOptions,
  checklistReserve,
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
  // No second line unless the plan asks for one: the panel is a heading and rows.
  assert.equal(options.subtitle, '');
  assert.equal(options.items.length, 3);

  const overridden = checklistOptions({
    ...PLAN,
    video: { checklist: { title: '', subtitle: 'Four steps, no detours.', side: 'left', width: 320, accent: '#0f0' } },
  });
  assert.equal(overridden.title, '');
  assert.equal(overridden.subtitle, 'Four steps, no detours.');
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
  assert.throws(() => validate(withVideo({ checklist: { layout: 'sidebar' } })), /layout" must be "overlay" or "dock"/);
  // The docked layout is valid, and validating it must not need a wider viewport:
  // whether the app has room left is a warning the run prints, not a typo.
  assert.deepEqual(validate(withVideo({ checklist: { layout: 'dock' } })).warnings, []);
  assert.throws(() => validate(withVideo({ checklist: { accent: 'blue' } })), /accent" must be a #rgb or #rrggbb colour/);
  assert.throws(() => validate(withVideo({ checklist: { title: 7 } })), /title" must be a string/);
  // The second line is a glance under the heading: a string, one line, short.
  assert.throws(() => validate(withVideo({ checklist: { subtitle: 7 } })), /subtitle" must be a string/);
  assert.throws(() => validate(withVideo({ checklist: { subtitle: 'Two\nlines' } })), /subtitle" must be a single line/);
  // "" is how a plan says "no second line"; spaces are a paragraph that says
  // nothing, and would take the heading's gap to do it.
  assert.throws(() => validate(withVideo({ checklist: { subtitle: '   ' } })), /subtitle" is only spaces/);
  assert.doesNotThrow(() => validate(withVideo({ checklist: { subtitle: '' } })));
  assert.throws(
    () => validate(withVideo({ checklist: { subtitle: 'x'.repeat(MAX_SUBTITLE_CHARS + 1) } })),
    /subtitle" is \d+ characters — keep it under \d+/,
  );
  // A mistyped key is still refused, now naming the subtitle among what is allowed.
  assert.throws(() => validate(withVideo({ checklist: { decription: 'typo' } })), /unknown "video.checklist" key "decription" \(allowed: .*subtitle/);
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
  const { warnings } = validate(
    withVideo({ checklist: { title: 'Setup', subtitle: 'Three steps to a running install.', side: 'left', width: 340, accent: '#f5a97f' } }),
  );
  assert.deepEqual(warnings, []);
  // The items alone are enough: the block is decoration.
  assert.deepEqual(validate(PLAN).warnings, []);
  assert.ok(NARROW_VIEWPORT >= 1280, 'a narrow-warning threshold below 1280 would fire on a normal 1440p page');
});

test('the panel floats over the page unless the plan docks it', () => {
  // Nothing about an existing plan changes: the overlay covers the app and the
  // page gives up no space for it.
  const floated = checklistOptions(PLAN);
  assert.equal(floated.layout, 'overlay');
  assert.equal(checklistReserve(floated), 0);

  const docked = checklistOptions({ ...PLAN, video: { checklist: { layout: 'dock', width: 360 } } });
  assert.equal(docked.layout, 'dock');
  assert.equal(checklistReserve(docked), 360);
  // A half-pixel width is rounded once, here, so the stylesheet and the page
  // cannot disagree about where the panel begins.
  assert.equal(checklistReserve({ layout: 'dock', width: 319.6 }), 320);

  // A typo is not a wish: it falls back to the layout that changes nothing about
  // the page rather than silently docking an app that was never measured for it.
  assert.equal(checklistOptions({ ...PLAN, video: { checklist: { layout: 'sidebar' } } }).layout, 'overlay');
  assert.equal(checklistOptions({ ...PLAN, video: { checklist: { layout: null } } }).layout, 'overlay');
});

test('the two layouts are two different panels, not one recoloured', () => {
  const css = checklistCss();
  // The overlay is translucent and blurs what is under it, which is the whole
  // reason it may sit on top of a control: you can still see the control.
  assert.match(css, /#__path_checklist\{[^}]*background:rgba\(/);
  assert.match(css, /#__path_checklist\{[^}]*backdrop-filter:blur\(/);
  // The docked panel is opaque and full height: it is the second column of the
  // page, so there is nothing of the app behind it to blur.
  assert.match(css, /#__path_checklist\.pc-dock\{[^}]*top:0;bottom:0/);
  assert.match(css, /#__path_checklist\.pc-dock\{[^}]*backdrop-filter:none/);
  assert.match(css, /#__path_checklist\.pc-dock\{[^}]*background:#0d121b/);
  // And the page reserves that column on the root, on the side the panel is on.
  assert.match(css, /html\[data-pc-dock="right"\]\{margin-right:var\(--pc-dock/);
  assert.match(css, /html\[data-pc-dock="left"\]\{margin-left:var\(--pc-dock/);
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
    subtitle: el.querySelector('.pc-sub')?.textContent ?? null,
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

/** The entrance is a transition, so a rect read too early is still sliding. */
const settled = (page) =>
  page.waitForFunction(() => {
    const el = document.getElementById('__path_checklist');
    return Boolean(el) && getComputedStyle(el).transform === 'none';
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
        video: { checklist: { title: 'Setup', subtitle: 'Three steps to a running install.' } },
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
      subtitle: 'Three steps to a running install.',
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

test('a docked panel takes a column of the page instead of covering it', async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no browser to draw with');

  const APP = `<!doctype html><html><head><style>
    html,body{margin:0;height:100%}body{background:#111}main{height:100%;background:#1b2130}
  </style></head><body><main id="app"></main></body></html>`;
  const CARD = `<!doctype html><html data-pc-card><head><style>
    html,body{margin:0;height:100%}body{background:#0a0e14}
  </style></head><body><main>Done</main></body></html>`;

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.route('http://dock.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: new URL(route.request().url()).pathname === '/done' ? CARD : APP,
      }),
    );
    const page = await context.newPage();
    const human = createHuman({
      context,
      page,
      plan: {
        viewport: { width: 1440, height: 900 },
        humanize: { seed: 'dock', loadFade: 0 },
        video: { checklist: { title: 'Setup', layout: 'dock', width: 360 } },
        steps: [{ goto: '/', check: 'Open the installer' }, { check: 'Sign in as the operator' }, { check: 'Pick the target' }],
      },
      speed: 200,
    });
    human.attachInit();
    await page.goto('http://dock.test/');
    await human.begin();
    await waitForPanel(page);
    await settled(page);

    /**
     * The column the page laid itself out in, where the panel begins, and where
     * the subtitle ends up — the subtitle is the one overlay that is centred on
     * the frame, so it is the one that shows whether "centred" means the page.
     */
    const geometry = () =>
      page.evaluate(() => {
        const app = document.getElementById('app')?.getBoundingClientRect() ?? document.body.getBoundingClientRect();
        const panel = document.getElementById('__path_checklist')?.getBoundingClientRect() ?? null;
        const pill = document.getElementById('__path_caption')?.getBoundingClientRect() ?? null;
        const root = document.documentElement;
        return {
          docked: root.getAttribute('data-pc-dock'),
          shift: getComputedStyle(root).getPropertyValue('--pc-dock-shift').trim(),
          // The box the document actually laid out in: the root's margin is what
          // the reservation is, and clientWidth does not subtract it.
          column: Math.round(document.body.getBoundingClientRect().width),
          appRight: Math.round(app.right),
          panel: panel && { left: Math.round(panel.left), right: Math.round(panel.right), top: Math.round(panel.top), bottom: Math.round(panel.bottom), width: Math.round(panel.width) },
          pill: pill && { left: Math.round(pill.left), right: Math.round(pill.right), centre: Math.round((pill.left + pill.right) / 2) },
        };
      });

    let drawn = await geometry();
    assert.equal(drawn.docked, 'right', 'the page is told to reserve the right column from its first paint');
    // The app lays out in what is left — the panel is a column, not a sheet of
    // glass over the last 360px of a 1440px app.
    assert.equal(drawn.column, 1080);
    assert.equal(drawn.appRight, 1080);
    assert.ok(drawn.panel.left >= drawn.appRight, `the panel starts where the app ends (${drawn.panel.left} >= ${drawn.appRight})`);
    assert.equal(drawn.panel.right, 1440, 'and ends at the right edge of the frame');
    assert.equal(drawn.panel.top, 0);
    assert.equal(drawn.panel.bottom, 900, 'a docked panel is full height, not a card in the middle');
    // This plan asks for no second line, so the panel draws none: a missing
    // subtitle leaves no empty gap where one would have been.
    assert.equal(await page.evaluate(() => document.querySelector('#__path_checklist .pc-sub')?.textContent ?? null), null);

    // A figure may not carry video chrome, but it must show the page the video
    // showed: removing the panel must not hand the app its 360px back.
    await human.hideCursor();
    assert.equal(await page.evaluate(PANEL), null, 'the panel is gone while the capture is taken');
    drawn = await geometry();
    assert.equal(drawn.docked, 'right', 'the reservation survives the panel being removed');
    assert.equal(drawn.column, 1080, 'so the page does not reflow for the picture');

    await human.showCursor();
    await waitForPanel(page);
    await settled(page);
    drawn = await geometry();
    assert.equal(drawn.column, 1080);
    assert.equal(drawn.panel.left, 1080, 'the panel comes back to the column it reserved');

    // The subtitle is centred on the page, not on page + list: over the whole
    // frame it reads as shifted off the screen it is captioning.
    await human.caption('Sign in to your workspace.');
    drawn = await geometry();
    assert.equal(drawn.shift, '-180px', 'the frame publishes half the reserved column as the shift');
    assert.ok(Math.abs(drawn.pill.centre - 540) <= 1, `the subtitle is centred on the app column (${drawn.pill.centre} vs 540)`);
    assert.ok(drawn.pill.right <= drawn.appRight, `and a long one cannot run under the panel (${drawn.pill.right} <= ${drawn.appRight})`);
    // It is still drawn while the panel is hidden for a figure, where the video
    // is: the capture removes it, the reservation does not move.
    await human.hideCursor();
    drawn = await geometry();
    assert.equal(drawn.pill, null, 'the subtitle is part of the chrome a figure may not carry');
    await human.showCursor();
    await settled(page);

    // A card is a document of its own with no app to make room for, so it opts
    // out: the intro and the recap stay centred instead of pushed left.
    await page.goto('http://dock.test/done');
    await human.arrive();
    await human.caption('That is the whole path.');
    drawn = await geometry();
    assert.equal(drawn.docked, null, 'a card reserves no column');
    assert.equal(drawn.column, 1440);
    assert.equal(drawn.shift, '', 'so it publishes no shift');
    assert.ok(Math.abs(drawn.pill.centre - 720) <= 1, `and its own subtitle is centred on the card (${drawn.pill.centre} vs 720)`);
  } finally {
    await context.close();
    await browser.close();
  }
});

test('the panel docks on either edge, above rows the heading introduces', async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no browser to draw with');

  const APP = `<!doctype html><html><head><style>
    html,body{margin:0;height:100%}body{background:#111}main{height:100%;background:#1b2130}
  </style></head><body><main id="app"></main></body></html>`;

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.route('http://left.test/**', (route) => route.fulfill({ contentType: 'text/html', body: APP }));
    const page = await context.newPage();
    const human = createHuman({
      context,
      page,
      plan: {
        viewport: { width: 1440, height: 900 },
        humanize: { seed: 'left', loadFade: 0 },
        video: {
          checklist: {
            title: 'Sign-in checklist',
            subtitle: 'Four steps, no detours.',
            layout: 'dock',
            side: 'left',
            width: 360,
          },
        },
        steps: [{ goto: '/', check: 'Open your workspace' }, { check: 'Sign in with your email' }],
      },
      speed: 200,
    });
    human.attachInit();
    await page.goto('http://left.test/');
    await human.begin();
    await waitForPanel(page);
    await settled(page);

    const drawn = await page.evaluate(() => {
      const root = document.documentElement;
      const box = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const panel = box('#__path_checklist');
      const app = box('#app');
      const head = box('#__path_checklist .pc-head');
      const sub = box('#__path_checklist .pc-sub');
      const items = box('#__path_checklist .pc-items');
      return {
        docked: root.getAttribute('data-pc-dock'),
        shift: getComputedStyle(root).getPropertyValue('--pc-dock-shift').trim(),
        panel: { left: Math.round(panel.left), right: Math.round(panel.right), width: Math.round(panel.width) },
        app: { left: Math.round(app.left), width: Math.round(app.width) },
        order: {
          headBottom: Math.round(head.bottom),
          subTop: Math.round(sub.top),
          subBottom: Math.round(sub.bottom),
          itemsTop: Math.round(items.top),
        },
      };
    });

    // `side: "left"` is the same reservation mirrored: the panel takes the left
    // edge and the page lays itself out in what is left of the frame.
    assert.equal(drawn.docked, 'left');
    assert.equal(drawn.shift, '180px', 'a left dock publishes a positive shift');
    assert.equal(drawn.panel.left, 0);
    assert.equal(drawn.panel.right, 360);
    assert.equal(drawn.app.left, 360, 'the page starts where the panel ends');
    assert.equal(drawn.app.width, 1080);

    // The heading introduces the rows, and the second line belongs to the heading,
    // not to the list: head, then the line, then the items, with nothing overlapping.
    assert.ok(drawn.order.subTop >= drawn.order.headBottom - 1, `the line sits under the heading (${drawn.order.subTop} >= ${drawn.order.headBottom})`);
    assert.ok(drawn.order.itemsTop >= drawn.order.subBottom - 1, `and the rows under the line (${drawn.order.itemsTop} >= ${drawn.order.subBottom})`);

    // The frame is centred on the page on this side too: half a 360px column to
    // the right of the viewport's middle.
    await human.caption('Sign in to your workspace.');
    const centre = await page.evaluate(() => {
      const pill = document.getElementById('__path_caption').getBoundingClientRect();
      return Math.round((pill.left + pill.right) / 2);
    });
    assert.ok(Math.abs(centre - 900) <= 1, `the subtitle is centred on the app column (${centre} vs 900)`);
  } finally {
    await context.close();
    await browser.close();
  }
});

