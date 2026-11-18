/**
 * The chrome's palette.
 *
 * Three things are worth holding still here, because each one fails silently:
 * a token name is inherited and forgotten, a preset is a copy of someone else's
 * theme, and a default is the only reason a plan that says nothing about colour
 * still draws the chrome it always drew.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

import {
  CARD_FONT_FAMILY,
  PANEL_TOKENS,
  TOKEN_DEFAULTS,
  presetNames,
  presets,
  resolveTokens,
  tokenDefaultsRule,
  tokenValueProblem,
} from '../lib/theme.mjs';
import { checklistCss, checklistOptions } from '../lib/checklist.mjs';
import { cardHtml } from '../lib/cards.mjs';
import { createHuman } from '../lib/human.mjs';
import { validate } from '../lib/plan.mjs';

const PLAN = {
  baseUrl: 'http://app.example.test',
  steps: [
    { goto: '/', check: 'Open the app' },
  ],
};

/** `validate` returns warnings and throws on a bad plan: accepted is doesNotThrow. */
function accepts(plan) {
  assert.doesNotThrow(() => validate(plan));
}

/** What a colour looks like in a generated stylesheet. */
const COLOR = /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(|color-mix\(/i;

/* ------------------------------------------------------------------ *
 * The vocabulary
 * ------------------------------------------------------------------ */

test('every token has a default, and the defaults are a closed set too', () => {
  for (const token of PANEL_TOKENS) {
    assert.ok(TOKEN_DEFAULTS[token], `${token} has no default`);
  }
  // The other direction: a default for a token nobody reads is dead CSS, and a
  // typo in the defaults map is exactly the kind of thing that survives review.
  for (const token of Object.keys(TOKEN_DEFAULTS)) {
    assert.ok(PANEL_TOKENS.includes(token), `${token} is a default with no token`);
  }
  assert.equal(new Set(PANEL_TOKENS).size, PANEL_TOKENS.length);
});

test('the defaults are declared on the panel element, not on the page', () => {
  const rule = tokenDefaultsRule();
  // On `:root` these would be inherited by every element of the recorded app,
  // which is the one thing the overlay must never do.
  assert.match(rule, /^#__path_checklist\{/);
  assert.doesNotMatch(rule, /:root/);
  for (const token of PANEL_TOKENS) assert.ok(rule.includes(`${token}:`), `${token} is missing`);
});

test('a token value cannot end its own declaration', () => {
  assert.equal(tokenValueProblem('#7c9cf5'), null);
  assert.equal(tokenValueProblem('var(--color-primary)'), null);
  assert.equal(tokenValueProblem('color-mix(in oklab, red 20%, transparent)'), null);
  // The three that would turn a value into a stylesheet.
  assert.match(tokenValueProblem('red;--pc-text:#fff'), /declaration/);
  assert.match(tokenValueProblem('red}'), /declaration/);
  assert.match(tokenValueProblem('a\nb'), /single line/);
  assert.match(tokenValueProblem(''), /empty/);
  assert.match(tokenValueProblem('   '), /empty/);
  assert.match(tokenValueProblem(7), /string/);
  assert.match(tokenValueProblem(null), /string/);
});

test('the stylesheet paints from tokens, so a theme can reach every colour', () => {
  const css = checklistCss().trimStart();
  // The defaults rule is the one place a token's literal lives. Every other rule
  // must reach a colour through a token, and a literal may only appear as that
  // token's fallback — a bare literal is a colour a theme cannot change.
  const [defaults, ...blocks] = css.split('}');
  assert.match(defaults, /^#__path_checklist\{--pc-surface:/);
  const offenders = [];
  for (const block of blocks) {
    const body = block.slice(block.indexOf('{') + 1);
    for (const declaration of body.split(';')) {
      const [, value = ''] = declaration.split(/:(.+)/s);
      if (!COLOR.test(value)) continue;
      if (value.includes('var(--pc-')) continue;
      offenders.push(declaration.trim());
    }
  }
  assert.deepEqual(offenders, [], 'these paint a literal colour instead of a token');
});

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

test('the shipped presets are well formed', () => {
  const names = presetNames();
  assert.ok(names.length > 0, 'no presets shipped');
  assert.ok(names.includes('memory'), `memory preset missing (have: ${names.join(', ')})`);
  for (const name of names) {
    const preset = presets()[name];
    assert.ok(preset.tokens && Object.keys(preset.tokens).length, `${name} has no tokens`);
    // A preset that does not say where it came from cannot be checked for drift.
    assert.ok(preset.source, `${name} has no source`);
    for (const [token, value] of Object.entries(preset.tokens)) {
      assert.ok(PANEL_TOKENS.includes(token), `${name}: ${token} is not a token`);
      assert.equal(tokenValueProblem(value), null, `${name}: ${token} is not a usable value`);
    }
  }
});

test('a preset is literal values, so it renders on a page with no CSS', () => {
  // `var(--color-primary)` in a preset would resolve on the product's own pages
  // and turn into nothing anywhere else — the opposite of what a preset is for.
  for (const [name, preset] of Object.entries(presets())) {
    for (const [token, value] of Object.entries(preset.tokens)) {
      assert.ok(!/var\(--color-/.test(value), `${name}: ${token} reads the app's tokens; use video.tokens for that`);
    }
  }
});

test('every preset name is a plan `theme` away from being accepted', () => {
  for (const name of presetNames()) accepts({ ...PLAN, video: { theme: name } });
  assert.throws(() => validate({ ...PLAN, video: { theme: 'nope' } }), /not a preset/);
  // The message lists what there is, so the fix does not need the source.
  try {
    validate({ ...PLAN, video: { theme: 'nope' } });
    assert.fail('should have thrown');
  } catch (error) {
    assert.match(error.message, new RegExp(presetNames().join('|')));
    assert.match(error.message, /video\.tokens/);
  }
  // A theme is a name, not a path or an inline palette.
  assert.throws(() => validate({ ...PLAN, video: { theme: 7 } }), /preset/);
  assert.throws(() => validate({ ...PLAN, video: { theme: '' } }), /preset/);
});

/* ------------------------------------------------------------------ *
 * Precedence
 * ------------------------------------------------------------------ */

test('the plan resolves to an override map, never a full palette', () => {
  // Empty is the point: the stylesheet owns the defaults, so a plan that says
  // nothing about colour draws exactly the panel it drew before tokens existed.
  assert.deepEqual(resolveTokens(PLAN), {});
  assert.deepEqual(resolveTokens({}), {});

  const preset = resolveTokens({ video: { theme: 'memory' } });
  assert.deepEqual(preset, presets().memory.tokens);

  // An explicit token wins over the preset it names.
  const overridden = resolveTokens({ video: { theme: 'memory', tokens: { '--pc-accent': '#ff0000' } } });
  assert.equal(overridden['--pc-accent'], '#ff0000');
  assert.equal(overridden['--pc-surface'], presets().memory.tokens['--pc-surface']);

  // `accent` is the shorthand for one token, and loses to the token itself —
  // the plan validator refuses a plan that sets both, so this only covers a plan
  // assembled in code.
  assert.deepEqual(resolveTokens({ video: { checklist: { accent: '#00ff00' } } }), { '--pc-accent': '#00ff00' });
  assert.equal(
    resolveTokens({ video: { checklist: { accent: '#00ff00' }, tokens: { '--pc-accent': 'var(--brand)' } } })['--pc-accent'],
    'var(--brand)',
  );
});

test('theme and tokens are both optional and may be combined', () => {
  accepts(PLAN);
  accepts({ ...PLAN, video: { theme: 'memory' } });
  accepts({ ...PLAN, video: { tokens: { '--pc-accent': 'var(--color-primary)' } } });
  accepts({ ...PLAN, video: { theme: 'memory', tokens: { '--pc-radius': '0px' } } });
});

test('a token name is closed, because an unknown custom property is silent', () => {
  assert.throws(() => validate({ ...PLAN, video: { tokens: { '--pc-accentt': '#fff' } } }), /not a chrome token/);
  // And the message names a legal one, so the fix is a copy-paste.
  try {
    validate({ ...PLAN, video: { tokens: { '--pc-accentt': '#fff' } } });
    assert.fail('should have thrown');
  } catch (error) {
    assert.match(error.message, /--pc-accent\b/);
  }
  // A stylesheet in the value is refused: it never ends where the author thinks.
  assert.throws(() => validate({ ...PLAN, video: { tokens: { '--pc-accent': 'red;--pc-text:#fff' } } }), /declaration/);
  assert.throws(() => validate({ ...PLAN, video: { tokens: { '--pc-accent': 5 } } }), /string/);
  assert.throws(() => validate({ ...PLAN, video: { tokens: [] } }), /object/);
});

test('the accent shorthand and the token it duplicates cannot both be set', () => {
  assert.throws(
    () => validate({ ...PLAN, video: { checklist: { accent: '#ff0000' }, tokens: { '--pc-accent': '#00ff00' } } }),
    /set the same colour/,
  );
  // Any *other* token alongside the shorthand is fine.
  accepts({ ...PLAN, video: { checklist: { accent: '#ff0000' }, tokens: { '--pc-text': '#fff' } } });
});

/* ------------------------------------------------------------------ *
 * What reaches the panel and the cards
 * ------------------------------------------------------------------ */

test('the panel is told only the overrides, and draws without them', () => {
  assert.deepEqual(checklistOptions(PLAN).tokens, {});
  assert.deepEqual(checklistOptions({ ...PLAN, video: { theme: 'memory' } }).tokens, presets().memory.tokens);
});

test('a card declares the plan palette after the scheme it replaces', () => {
  const html = cardHtml(
    { ...PLAN, video: { intro: { title: 'Hello' }, theme: 'memory', tokens: { '--pc-radius': '2px' } } },
    'intro',
  );
  // The scheme's own values first, so a card in a themed plan is themed and a
  // card in an unthemed plan is exactly the card it always was.
  assert.ok(html.includes('--pc-surface:#0a0e14'), 'scheme defaults are not on :root');
  assert.ok(html.includes(`--pc-surface:${presets().memory.tokens['--pc-surface']}`), 'preset did not reach the card');
  assert.ok(html.includes('--pc-radius:2px'), 'explicit token did not reach the card');
  // Preset after scheme: order in the document is what decides.
  assert.ok(
    html.indexOf('--pc-surface:#0a0e14') < html.indexOf(presets().memory.tokens['--pc-surface']),
    'the preset must come after the scheme values',
  );
  // The font is a token with a fallback, so a card in a fontless theme still reads.
  assert.ok(html.includes(`var(--pc-font-family, ${CARD_FONT_FAMILY})`));
  // And a colour token carries the card's own value as its fallback, so a plan
  // pointing one at a variable the page does not define leaves the card as light
  // or dark as it was, instead of painting the panel's default over it.
  assert.ok(html.includes('var(--pc-surface,#0a0e14)'), 'a dark card must fall back to the dark scheme');
  const light = cardHtml(
    { ...PLAN, colorScheme: 'light', video: { intro: { title: 'Hello' }, tokens: { '--pc-surface': 'var(--nope)' } } },
    'intro',
  );
  assert.ok(light.includes('var(--pc-surface,#ffffff)'), 'a light card must fall back to the light scheme');
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

const HUMAN_PLAN = {
  viewport: { width: 1440, height: 900 },
  humanize: { seed: 'theme', loadFade: 0 },
  steps: [{ check: 'Open the app' }, { check: 'Pick the target' }],
};

/** The panel's painted colours, as the browser resolved them. */
const painted = (page) =>
  page.evaluate(() => {
    const el = document.getElementById('__path_checklist');
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      background: style.backgroundColor,
      colour: style.color,
      radius: style.borderTopLeftRadius,
      // The docked panel is the token's own value, not a recolour of it.
      docked: el.classList.contains('pc-dock'),
    };
  });

const waitForPanel = (page) =>
  page.waitForFunction(() => {
    const el = document.getElementById('__path_checklist');
    return Boolean(el && el.classList.contains('pc-in'));
  });

/**
 * Draw one panel and read its colours.
 *
 * A context per case, not a page per case: `attachInit` installs the overlay on
 * the *context*, so a second human in a shared one leaves two init scripts racing
 * for the same element and the first one to run wins. One context per plan is
 * also what the recorder does.
 */
async function drawPanel(browser, plan, { extraContext = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...extraContext });
  await context.route('http://theme.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<main><h1>App</h1></main>' }),
  );
  const page = await context.newPage();
  const human = createHuman({ context, page, plan, speed: 200 });
  human.attachInit();
  await page.goto('http://theme.test/');
  await human.begin();
  await waitForPanel(page);
  const result = await painted(page);
  await context.close();
  return result;
}

test('a theme reaches the panel that is actually painted', async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no browser to draw with');
  try {
    // Unthemed: the defaults, exactly as before there was a palette.
    assert.deepEqual(await drawPanel(browser, HUMAN_PLAN), {
      background: 'rgba(10, 13, 20, 0.84)',
      colour: 'rgb(238, 242, 250)',
      radius: '14px',
      docked: false,
    });

    // Themed: a literal preset changes what the browser paints, on a page that
    // defined none of these properties itself.
    const memory = await drawPanel(browser, { ...HUMAN_PLAN, video: { theme: 'memory' } });
    assert.notEqual(memory.background, 'rgba(10, 13, 20, 0.84)', 'the preset did not reach the painted panel');
    assert.equal(memory.radius, '8px', 'the Memory preset is 0.5rem at 16px');

    // An explicit token wins over the preset it came with — and may read the
    // app's own palette, the case a literal preset cannot cover because `var()`
    // belongs to the page.
    const override = await drawPanel(browser, {
      ...HUMAN_PLAN,
      video: { theme: 'memory', tokens: { '--pc-radius': '0px', '--pc-accent': 'var(--color-primary)' } },
    });
    assert.equal(override.radius, '0px', 'an explicit token must win over the preset');

    // A token may point at a variable the page does not define. That declaration
    // is invalid at computed-value time, which without a fallback paints nothing —
    // an accent circle that silently disappears. The consumer's fallback is what
    // turns "this app had no such colour" into the default chrome.
    const unresolved = await drawPanel(browser, {
      ...HUMAN_PLAN,
      video: { tokens: { '--pc-radius': 'var(--not-defined-here)', '--pc-surface': 'var(--not-defined-here)' } },
    });
    assert.equal(unresolved.radius, '14px', 'an unresolvable token must fall back to the default');
    assert.equal(unresolved.background, 'rgba(10, 13, 20, 0.84)', 'an unresolvable surface must not paint nothing');
  } finally {
    await browser.close();
  }
});

test('a page with a strict style-src cannot drop the chrome', async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no browser to draw with');

  const html = '<main><h1>App</h1></main>';
  // `style-src 'none'` is the policy a hardened app ships: an injected
  // stylesheet is refused silently, and the panel arrives as unstyled text. The
  // recorder bypasses the policy on its own context, so the chrome is a property
  // of the recorder rather than of whoever wrote the page being recorded.
  const route = (context) =>
    context.route('http://csp.test/**', (r) =>
      r.fulfill({
        contentType: 'text/html',
        headers: { 'content-security-policy': "style-src 'none'; script-src 'none'" },
        body: html,
      }),
    );

  // Without the policy bypassed: the failure this guard exists for.
  const plain = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await route(plain);
    const page = await plain.newPage();
    const human = createHuman({ context: plain, page, plan: HUMAN_PLAN, speed: 200 });
    human.attachInit();
    await page.goto('http://csp.test/');
    await human.begin();
    await waitForPanel(page);
    assert.equal(
      (await painted(page)).background,
      'rgba(0, 0, 0, 0)',
      'the styled panel is not what a strict style-src draws — if this changed, the test is no longer proving anything',
    );
  } finally {
    await plain.close();
  }

  // With it: the panel draws as it would on any page.
  const bypassed = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
  try {
    await route(bypassed);
    const page = await bypassed.newPage();
    const human = createHuman({ context: bypassed, page, plan: HUMAN_PLAN, speed: 200 });
    human.attachInit();
    await page.goto('http://csp.test/');
    await human.begin();
    await waitForPanel(page);
    assert.equal((await painted(page)).background, 'rgba(10, 13, 20, 0.84)', 'bypassCSP did not let the chrome through');
  } finally {
    await bypassed.close();
    await browser.close();
  }
});
