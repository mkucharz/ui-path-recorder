/**
 * The intro and end cards: the two screens a walkthrough can open and close on.
 *
 * What a card *says* is pure — a string of HTML built from the plan, checked here
 * without a browser. What it *looks like* is not: a card is a whole viewport of
 * content, so the interesting failure is that the largest legal card does not fit
 * in the frame the plan records. That needs a document, so one test renders the
 * worst case and measures it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import {
  CARD_DEFAULT_MS,
  MAX_CARD_BULLETS,
  MAX_CARD_BULLET_CHARS,
  MAX_CARD_SUBTITLE_CHARS,
  MAX_CARD_TITLE_CHARS,
  cardFitWarning,
  cardHtml,
  cardOptions,
  escapeHtml,
} from '../lib/cards.mjs';
import { validate } from '../lib/plan.mjs';

const PLAN = {
  baseUrl: 'http://app.example.test',
  colorScheme: 'dark',
  video: {
    intro: { title: 'Deploy the stack', subtitle: 'Four services, one run.', bullets: ['Bring your own domain', 'Roughly ten minutes'] },
    outro: { title: 'That is the whole path', bullets: ['Re-run it whenever the app changes'] },
    checklist: { title: 'Setup', subtitle: 'Three steps to a running install.', accent: '#f5a97f' },
  },
  steps: [
    { goto: '/', check: 'Open the installer' },
    { click: '#signin', check: 'Sign in as the operator' },
    { click: '#deploy', check: 'Pick the target' },
  ],
};

/* ------------------------------------------------------------------ *
 * What a card says
 * ------------------------------------------------------------------ */

test('a card is text, never markup', () => {
  assert.equal(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml(undefined), '');
  // A title is author-written prose, not a template: `<` in it is a `<`.
  const html = cardHtml(
    { ...PLAN, video: { ...PLAN.video, intro: { title: 'Set up <b>teams</b> & roles', subtitle: 'a < b', bullets: ['x & y'] } } },
    'intro',
  );
  assert.match(html, /<h1>Set up &lt;b&gt;teams&lt;\/b&gt; &amp; roles<\/h1>/);
  assert.doesNotMatch(html, /<b>teams<\/b>/);
  assert.match(html, /a &lt; b/);
  assert.match(html, /<li>x &amp; y<\/li>/);
});

test('the intro is 0 of N and the end card is all N', () => {
  const intro = cardHtml(PLAN, 'intro');
  const outro = cardHtml(PLAN, 'outro');
  const rows = (html) => html.match(/<li class="pc-row[^"]*"/g) ?? [];
  assert.equal(rows(intro).length, 3, 'the card carries the same rows as the panel');
  assert.equal(rows(outro).length, 3);
  // Nothing is ticked on the way in, everything is on the way out: a card that
  // disagreed with the video would be a second, contradictory record.
  assert.equal(rows(intro).filter((row) => row.includes('pc-done')).length, 0);
  assert.equal(rows(outro).filter((row) => row.includes('pc-done')).length, 3);
  assert.match(intro, /<span class="pc-total">0 \/ 3<\/span>/);
  assert.match(outro, /<span class="pc-total">3 \/ 3<\/span>/);
  // The ticks are the panel's: drawn check marks, and a strike-through.
  assert.match(outro, /<svg viewBox="0 0 12 12"/);
  assert.doesNotMatch(intro, /<svg viewBox="0 0 12 12"/);
  assert.match(outro, /\.pc-done \.pc-text \{ text-decoration: line-through/);
  // The heading and the tick colour come from `video.checklist`, so a card and
  // the panel read as one recording rather than two artefacts.
  assert.match(intro, /<h2>Setup<\/h2>/);
  assert.match(intro, /#f5a97f/);
  // The panel's second line comes with the heading, above the rows it describes.
  assert.match(intro, /<h2>Setup<\/h2>[\s\S]*<p class="pc-check-sub">Three steps to a running install\.<\/p>[\s\S]*<ol class="pc-rows">/);
  // A plan with no second line draws none, rather than an empty paragraph.
  assert.doesNotMatch(cardHtml({ ...PLAN, video: { ...PLAN.video, checklist: { title: 'Setup' } } }, 'intro'), /<p class="pc-check-sub"/);
  // A card shows the rows the panel shows, and nothing the panel does not: the
  // counter goes at the end, not a number beside every row.
  assert.match(intro, /grid-template-columns: 1\.05em 1fr/);
  assert.doesNotMatch(intro, /class="pc-num"/);
});

test('a card with nothing to tick carries no checklist', () => {
  const plan = { baseUrl: 'http://x.test', video: { intro: { title: 'Hello' } }, steps: [{ goto: '/' }] };
  const html = cardHtml(plan, 'intro');
  assert.doesNotMatch(html, /<section class="pc-check"/);
  assert.doesNotMatch(html, /class="pc-total"/);
  // A card is still a card without a list.
  assert.match(html, /<h1>Hello<\/h1>/);
});

test('the card is the recording speaking, not the app', () => {
  const dark = cardHtml(PLAN, 'intro');
  const light = cardHtml({ ...PLAN, colorScheme: 'light' }, 'intro');
  // The theme follows the plan rather than the page the video goes on to show:
  // a light card in front of a dark app is a decision, not an accident.
  assert.match(dark, /background: #0a0e14/);
  assert.match(dark, /color-scheme: dark/);
  assert.match(light, /background: #ffffff/);
  assert.match(light, /color-scheme: light/);
  // No URL, no breadcrumb, no app chrome: a viewer must not think the recording
  // started inside a browser they can see.
  assert.doesNotMatch(dark, /app\.example\.test/);
  assert.doesNotMatch(dark, /https?:\/\//);
  // And no overlay: a card is page content, not a drawing over an app.
  assert.doesNotMatch(dark, /__path_/);
  assert.doesNotMatch(dark, /<script/);
  assert.equal(cardHtml(PLAN, 'nope'), '');
  assert.equal(cardHtml({ baseUrl: 'http://x.test', video: {}, steps: [] }, 'intro'), '');
});

test('a card that asks for no title is not a card', () => {
  assert.equal(cardOptions({ steps: [] }), null);
  assert.equal(cardOptions({ video: { checklist: {} }, steps: [] }), null);
  const options = cardOptions(PLAN, { speed: 1 });
  assert.equal(options.ms, CARD_DEFAULT_MS);
  assert.equal(options.intro.title, 'Deploy the stack');
  assert.equal(options.outro.title, 'That is the whole path');
  // `--speed` is for a test run, not for a shorter video: every delay a card
  // holds is divided like the rest of the pacing, so a fast replay stays fast.
  assert.equal(cardOptions(PLAN, { speed: 20 }).ms, Math.round(CARD_DEFAULT_MS / 20));
  assert.equal(cardOptions({ ...PLAN, video: { ...PLAN.video, cardMs: 4000 } }, { speed: 2 }).ms, 2000);
  assert.equal(cardOptions({ ...PLAN, video: { ...PLAN.video, cardMs: 0 } }).ms, 0);
  // One card may be asked for alone, in either direction.
  assert.equal(cardOptions({ ...PLAN, video: { outro: PLAN.video.outro } }).intro, null);
});

test('a card that does not fit its frame says so', () => {
  // Padding is part of the frame the card may use, not free space around it.
  assert.equal(cardFitWarning({ kind: 'intro', contentHeight: 820, frameHeight: 900, padding: 40 }), null);
  assert.equal(cardFitWarning({ kind: 'intro', contentHeight: 800, frameHeight: 900 }), null);
  assert.match(
    cardFitWarning({ kind: 'outro', contentHeight: 850, frameHeight: 900, padding: 40 }),
    /^the outro card is 30px taller than the 900px frame/,
  );
  assert.match(cardFitWarning({ kind: 'intro', contentHeight: 900, frameHeight: 900, padding: 1 }), /2px taller/);
});

/* ------------------------------------------------------------------ *
 * The plan contract
 * ------------------------------------------------------------------ */

const withVideo = (video) => ({ baseUrl: 'http://example.test', video, steps: PLAN.steps });

test('a plan refuses a card it cannot draw', () => {
  assert.throws(() => validate(withVideo({ intro: 'Deploy' })), /"video\.intro" must be an object/);
  assert.throws(() => validate(withVideo({ intro: { sub: 'x' } })), /unknown "video\.intro" key "sub"/);
  assert.throws(() => validate(withVideo({ intro: {} })), /"video\.intro\.title" must be a non-empty string/);
  assert.throws(() => validate(withVideo({ intro: { title: '   ' } })), /must be a non-empty string/);
  assert.throws(() => validate(withVideo({ intro: { title: 'a\nb' } })), /must be a single line/);
  assert.throws(() => validate(withVideo({ intro: { title: 'x'.repeat(MAX_CARD_TITLE_CHARS + 1) } })), /is \d+ characters/);
  assert.throws(() => validate(withVideo({ outro: { title: 'ok', subtitle: 'x'.repeat(MAX_CARD_SUBTITLE_CHARS + 1) } })), /subtitle" is \d+ characters/);
  assert.throws(() => validate(withVideo({ outro: { title: 'ok', subtitle: 7 } })), /subtitle" must be a string/);
  assert.throws(() => validate(withVideo({ outro: { title: 'ok', bullets: [] } })), /bullets" must be a non-empty array/);
  assert.throws(() => validate(withVideo({ outro: { title: 'ok', bullets: 'one' } })), /bullets" must be a non-empty array/);
  const many = Array.from({ length: MAX_CARD_BULLETS + 1 }, (_, i) => `Point ${i}`);
  assert.throws(() => validate(withVideo({ outro: { title: 'ok', bullets: many } })), /has 7 lines/);
  assert.throws(() => validate(withVideo({ outro: { title: 'ok', bullets: ['x'.repeat(MAX_CARD_BULLET_CHARS + 1)] } })), /entry is \d+ characters/);
  assert.throws(() => validate(withVideo({ outro: { title: 'ok', bullets: [7] } })), /entry must be a non-empty string/);
  assert.throws(() => validate(withVideo({ outro: { title: 'ok', bullets: ['a\nb'] } })), /entry must be a single line/);
  // A typo in the duration is a plan that renders the recording at another pace.
  assert.throws(() => validate(withVideo({ cardMs: -1 })), /"video\.cardMs" must be a number of milliseconds/);
  assert.throws(() => validate(withVideo({ cardMs: '2s' })), /"video\.cardMs" must be a number of milliseconds/);
});

test('a valid card plan validates and warns about nothing', () => {
  const { warnings } = validate(withVideo({ intro: { title: 'Deploy', bullets: ['One', 'Two'] }, outro: PLAN.video.outro, cardMs: 3000 }));
  assert.deepEqual(warnings, []);
  // A card is optional in both directions.
  assert.deepEqual(validate(withVideo({ intro: PLAN.video.intro })).warnings, []);
  assert.deepEqual(validate(PLAN).warnings, []);
});

/* ------------------------------------------------------------------ *
 * The card in a real viewport
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

/** The largest card the contract allows: the one that has to fit. */
const BIGGEST = {
  baseUrl: 'http://app.example.test',
  colorScheme: 'dark',
  viewport: { width: 1600, height: 900 },
  video: {
    outro: {
      title: 'Deploy the whole stack from a clean machine',
      subtitle:
        'This walkthrough creates four services, wires them together and proves the deployment answers: no copy-paste, no second terminal.',
      bullets: Array.from({ length: MAX_CARD_BULLETS }, (_, i) => `Bullet number ${i + 1} that is about this long, maybe`),
    },
    checklist: { title: 'What the video does' },
  },
  steps: Array.from({ length: 10 }, (_, i) => ({ goto: '/', check: `Step number ${i + 1}, described in one line` })),
};

test('the largest legal card still fits the frame it is recorded in', async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no Chromium on this host; set CHROME to one');
  try {
    for (const frame of [
      { width: 1600, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      const page = await browser.newPage({ viewport: frame });
      await page.setContent(cardHtml(BIGGEST, 'outro'), { waitUntil: 'load' });
      const fits = await page.evaluate(() => {
        const main = document.querySelector('main');
        return {
          contentHeight: main.getBoundingClientRect().height,
          padding: parseFloat(getComputedStyle(document.body).paddingTop) || 0,
          clipped: [...document.querySelectorAll('h1, .pc-sub, li')].filter(
            (el) => el.getBoundingClientRect().bottom > window.innerHeight,
          ).length,
          rows: document.querySelectorAll('.pc-row').length,
          done: document.querySelectorAll('.pc-row.pc-done').length,
          total: document.querySelector('.pc-total')?.textContent ?? null,
          // The colour the viewer actually sees, not the one in the stylesheet.
          background: getComputedStyle(document.body).backgroundColor,
          color: getComputedStyle(document.body).color,
          struck: [...document.querySelectorAll('.pc-row.pc-done .pc-text')].every((el) =>
            getComputedStyle(el).textDecorationLine.includes('line-through'),
          ),
        };
      });
      // A card is a whole screen: content that runs past the bottom is content the
      // recording never shows. The check is the one the runner makes out loud, so
      // a card that would warn there fails here first.
      const { contentHeight, padding } = fits;
      assert.equal(
        cardFitWarning({ kind: 'outro', contentHeight, frameHeight: frame.height, padding }),
        null,
        `the largest legal card does not fit ${frame.width}x${frame.height}`,
      );
      assert.equal(fits.clipped, 0, 'nothing on the card hangs below the frame');
      assert.equal(fits.rows, 10);
      assert.equal(fits.done, 10);
      assert.equal(fits.total, '10 / 10');
      assert.ok(fits.struck, 'a finished row is struck through');
      assert.equal(fits.background, 'rgb(10, 14, 20)');
      assert.equal(fits.color, 'rgb(238, 242, 250)');
      await page.close();
    }

    // And the guard is not vacuous: a frame too short for the same card is
    // measured as short, and the runner would say so.
    const short = await browser.newPage({ viewport: { width: 900, height: 380 } });
    await short.setContent(cardHtml(BIGGEST, 'outro'), { waitUntil: 'load' });
    const measured = await short.evaluate(() => ({
      contentHeight: document.querySelector('main').getBoundingClientRect().height,
      padding: parseFloat(getComputedStyle(document.body).paddingTop) || 0,
    }));
    const warning = cardFitWarning({ kind: 'outro', contentHeight: measured.contentHeight, frameHeight: 380, padding: measured.padding });
    assert.match(warning, /^the outro card is \d+px taller than the 380px frame/);
    await short.close();
  } finally {
    await browser.close();
  }
});
