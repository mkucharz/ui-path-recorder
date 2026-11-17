/**
 * The humanizer, without a browser.
 *
 * A video is only worth recording if what it shows is the run that happened, so
 * the parts that can be checked without pixels are checked here: the sampled
 * path starts and ends where the pointer is, the pacing is seeded (replayable),
 * a click still goes through Playwright's actionability check first, and the
 * pointer is hidden for a capture and shown again afterwards.
 *
 * The end-to-end proof — that a humanized figure is byte-identical to a plain
 * one, i.e. the pointer never reaches a picture — lives in fixture.test.mjs,
 * because it needs a real browser.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHuman, createRng, easeInOutCubic, resolveOptions, travelPath } from '../lib/human.mjs';

/** A page with just enough surface for the humanizer, recording what it is told. */
function fakePage({ width = 900, height = 700, box = { x: 100, y: 100, width: 120, height: 140 } } = {}) {
  const moves = [];
  const keys = [];
  const calls = [];
  /** What the overlay was asked to draw, with the arguments it was given. */
  const overlay = [];
  const page = {
    viewportSize: () => ({ width, height }),
    mouse: {
      move: async (x, y) => moves.push({ x, y }),
      down: async () => moves.push({ down: true }),
      up: async () => moves.push({ up: true }),
    },
    keyboard: {
      type: async (char) => keys.push(char),
      press: async (key) => keys.push(`<${key}>`),
      insertText: async (text) => keys.push(`+${text}`),
    },
    evaluate: async (_fn, arg) => {
      calls.push(arg?.name);
      if (arg?.name) overlay.push({ name: arg.name, args: arg.args ?? [] });
      return undefined;
    },
  };
  const locator = {
    waitFor: async () => calls.push('waitFor'),
    click: async (opts) => calls.push(opts?.trial ? 'click:trial' : 'click'),
    boundingBox: async () => box,
    focus: async () => calls.push('focus'),
    fill: async (value) => calls.push(`fill:${value}`),
    pressSequentially: async (value, opts) => calls.push(`type:${value}:${opts?.delay}`),
    press: async (key) => calls.push(`press:${key}`),
    first() {
      return this;
    },
  };
  return { page, locator, moves, keys, calls, overlay };
}

const human = ({ page, speed = 200, seed = 'unit', enabled = true } = {}) =>
  createHuman({ context: { addInitScript: () => {} }, page, plan: { viewport: { width: 900, height: 700 } }, enabled, seed, speed });

test('a seed replays the same numbers, and another seed does not', () => {
  const a = createRng('signin-v1');
  const b = createRng('signin-v1');
  const c = createRng('signin-v2');
  const fromA = Array.from({ length: 5 }, a);
  assert.deepEqual(fromA, Array.from({ length: 5 }, b));
  assert.notDeepEqual(fromA, Array.from({ length: 5 }, c));
});

test('a travel path ends on the target and gets closer all the way', () => {
  const rng = createRng('path');
  const from = { x: 10, y: 10 };
  const to = { x: 410, y: 310 };
  const { points, durationMs } = travelPath(from, to, rng, { moveMs: [220, 640] });

  assert.equal(points.length, 14);
  const last = points.at(-1);
  assert.ok(Math.abs(last.x - to.x) < 0.001 && Math.abs(last.y - to.y) < 0.001, 'the last sample is the target');
  // Monotonic approach: every sample is at least as close as the one before it.
  const distances = points.map((p) => Math.hypot(p.x - to.x, p.y - to.y));
  for (let i = 1; i < distances.length; i += 1) assert.ok(distances[i] <= distances[i - 1] + 1e-9);
  // A 500 px trip is neither instant nor glacial.
  assert.ok(durationMs >= 220 && durationMs <= 640, `duration ${durationMs}`);
});

test('a path shorter than a few pixels does not animate', () => {
  const { points, durationMs } = travelPath({ x: 5, y: 5 }, { x: 6, y: 5 }, createRng('x'));
  assert.equal(durationMs, 0);
  assert.equal(points.length, 1);
});

test('easing is 0 at the start, 1 at the end and monotonic between', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  let previous = -1;
  for (let i = 0; i <= 20; i += 1) {
    const value = easeInOutCubic(i / 20);
    assert.ok(value >= previous);
    previous = value;
  }
});

test('plan options merge over the defaults without losing nested typing', () => {
  const options = resolveOptions({ typing: { maxMs: 200 }, clickRipple: false });
  assert.equal(options.typing.maxMs, 200);
  assert.equal(options.typing.minMs, 55, 'the unspecified half of typing survives');
  assert.equal(options.clickRipple, false);
  assert.equal(options.dwellMs[0], 80);
  assert.equal(resolveOptions({}, { speed: 20 }).speed, 20, '--speed overrides the plan');
});

test('a humanized click travels, dwells, presses — and checks actionability first', async () => {
  const { page, locator, moves, calls } = fakePage();
  const humanizer = human({ page });
  await humanizer.click(locator);

  assert.equal(calls[0], 'waitFor', 'the target must be visible before aiming');
  assert.equal(calls[1], 'click:trial', 'actionability runs before the mouse moves');
  assert.ok(moves.filter((m) => !m.down && !m.up).length > 1, 'the pointer moved in more than one event');
  const down = moves.findIndex((m) => m.down);
  const up = moves.findIndex((m) => m.up);
  assert.ok(down > 0 && up > down, 'press happened after the travel and before the release');
  // The overlay is told where to animate to, once per move.
  assert.ok(calls.includes('__pathCursorTo'));
  assert.ok(calls.includes('__pathRipple'), 'the ripple follows the click');
});

test('the pointer lands inside the target box, not on its dead centre', async () => {
  const box = { x: 100, y: 100, width: 200, height: 200 };
  const { page, locator, moves } = fakePage({ box });
  await human({ page, seed: 'aim' }).click(locator);
  const landing = moves.filter((m) => !m.down && !m.up).at(-1);
  assert.ok(landing.x >= box.x && landing.x <= box.x + box.width, `x ${landing.x} outside ${box.x}..${box.x + box.width}`);
  assert.ok(landing.y >= box.y && landing.y <= box.y + box.height, `y ${landing.y} outside the box`);
});

test('without humanizing, every action is the plain Playwright call', async () => {
  const { page, locator, moves, calls } = fakePage();
  const plain = createHuman({ context: { addInitScript: () => {} }, page, enabled: false });
  await plain.click(locator);
  await plain.fill(locator, 'admin@example.com');
  await plain.type(locator, 'abc');
  await plain.press(locator, 'Enter');
  assert.deepEqual(calls, ['click', 'fill:admin@example.com', 'click', 'type:abc:10', 'press:Enter']);
  assert.equal(moves.length, 0, 'the pointer does not move at all');
  assert.equal(plain.enabled, false);
});

test('typing sends one key event per character and keeps the value', async () => {
  const { page, locator, keys } = fakePage();
  await human({ page }).fill(locator, 'admin@example.com');
  const typed = keys.filter((k) => k.length === 1).join('');
  assert.equal(typed, 'admin@example.com');
});

test('a long value is typed at the start and pasted, not typed for a minute', async () => {
  const { page, locator, keys } = fakePage();
  await human({ page }).fill(locator, 'https://example.com/install?token=abcdef0123456789');
  const typed = keys.filter((k) => k.length === 1).join('');
  assert.equal(typed, 'https:', 'six characters are typed');
  assert.ok(
    keys.some((k) => k.startsWith('+') && k.endsWith('abcdef0123456789')),
    'the remainder arrives in one paste',
  );
});

test('the pointer is hidden for a capture and shown again after it', async () => {
  const { page, calls } = fakePage();
  const humanizer = human({ page });
  await humanizer.hideCursor();
  await humanizer.showCursor();
  assert.deepEqual(calls, ['__pathCursorHide', '__pathCursorShow']);
});

test('a caption is drawn, cleared by an empty one, and said again after a page swap', async () => {
  const { page, overlay, calls } = fakePage();
  const humanizer = human({ page });

  await humanizer.caption('Open the sign-in page.');
  assert.deepEqual(overlay.at(-1), { name: '__pathCaption', args: ['Open the sign-in page.'] });
  // Whitespace collapses, because a subtitle is a line rather than a block.
  await humanizer.caption('  Open  the sign-in\npage.  ');
  assert.deepEqual(overlay.at(-1), { name: '__pathCaption', args: ['Open the sign-in page.'] });

  // A navigation replaces the document that held the caption. `arrive()` is
  // where the runner waits for the new one, so it must say it again — otherwise
  // a caption set on a `goto` step would never be seen.
  calls.length = 0;
  await humanizer.arrive();
  assert.ok(calls.includes('__pathCaption'), 'the caption follows the page it describes');

  // A step with no caption clears it: no subtitle outlives the screen it
  // described.
  await humanizer.caption('');
  assert.deepEqual(overlay.at(-1), { name: '__pathCaption', args: [''] });
  calls.length = 0;
  await humanizer.hold(1);
  assert.ok(!calls.includes('__pathCaption'), 'a cleared caption is not repeated');
});

test('the checklist arrives at the start and ticks on the beat, once per item', async () => {
  const { page, overlay, calls } = fakePage();
  const plan = {
    viewport: { width: 900, height: 700 },
    video: { checklist: { title: 'Setup' } },
    steps: [{ check: 'Open the installer' }, { check: 'Sign in' }],
  };
  const humanizer = createHuman({ context: { addInitScript: () => {} }, page, plan, speed: 200, seed: 'checklist' });

  // The panel is the one thing whose entrance animates: 0 / N, before any step
  // has a picture of its own.
  await humanizer.begin();
  assert.deepEqual(overlay.at(-1), { name: '__pathChecklist', args: [[], true] });

  await humanizer.check('  Open   the installer ');
  assert.deepEqual(overlay.at(-1), { name: '__pathChecklist', args: [['Open the installer'], false] }, 'a tick is a settled redraw');
  // Two spellings of one row are one row, and the page is told the same list.
  await humanizer.check('Open the installer');
  assert.deepEqual(overlay.at(-1).args, [['Open the installer'], false]);
  await humanizer.check('Sign in');
  assert.deepEqual(overlay.at(-1).args, [['Open the installer', 'Sign in'], false]);

  // A navigation replaces the document that held the list: `arrive()` is where
  // the runner waits for the new one, so it must draw the list again — settled,
  // with the ticks it already had.
  calls.length = 0;
  await humanizer.arrive();
  assert.ok(calls.includes('__pathChecklist'), 'the list follows the page it describes');
  assert.deepEqual(overlay.at(-1).args, [['Open the installer', 'Sign in'], false]);
});

test('the panel travels in the init script, and a raw cut carries none', () => {
  const scripts = [];
  const context = { addInitScript: (_fn, arg) => scripts.push(arg) };
  const plan = {
    viewport: { width: 900, height: 700 },
    video: { checklist: { side: 'left', width: 320 } },
    steps: [{ check: 'Open the installer' }],
  };
  createHuman({ context, page: fakePage().page, plan }).attachInit();
  assert.equal(scripts[0].checklist.side, 'left');
  assert.equal(scripts[0].checklist.width, 320);
  assert.deepEqual(scripts[0].checklist.items, ['Open the installer']);
  assert.match(scripts[0].checklistCss, /#__path_checklist/);

  // A plan with no `check` has no panel, and the overlay is not given an empty
  // one to draw.
  createHuman({ context, page: fakePage().page, plan: { steps: [{ goto: '/' }] } }).attachInit();
  assert.equal(scripts[1].checklist, null);
  assert.equal(scripts[1].checklistCss, '');
});

test('without humanizing there is no panel and nothing to tick', async () => {
  const { page, overlay, calls } = fakePage();
  const plain = createHuman({ context: { addInitScript: () => {} }, page, enabled: false, plan: { steps: [{ check: 'Open the installer' }] } });
  await plain.begin();
  await plain.check('Open the installer');
  assert.deepEqual(calls, [], 'the page is never touched');
  assert.deepEqual(overlay, []);
});

test('the same seed produces the same scheduled delay', async () => {
  const run = async (seed) => {
    const fake = fakePage();
    const humanizer = human({ page: fake.page, seed });
    await humanizer.click(fake.locator);
    await humanizer.fill(fake.locator, 'admin@example.com');
    return humanizer.plannedMsSince();
  };
  const a = await run('same');
  const b = await run('same');
  const c = await run('other');
  assert.equal(a, b, 'the plan is reproducible, which is what a re-run needs');
  assert.notEqual(a, c, 'a different seed is a different path');
  assert.ok(a > 0);
});
