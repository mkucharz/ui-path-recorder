/**
 * The review sheet's two views of the same figures.
 *
 * The contact sheet answers "is this the right picture"; the slideshow answers
 * "does the path read in order". Both are built from the run's own shots, so the
 * failure worth testing is not cosmetic: a slideshow that could show a figure the
 * run did not take, or one that disagrees with the tiles under it, is a second
 * description of the run rather than a second view of it.
 *
 * The navigation needs a document to be wrong in, so the last test drives a real
 * browser — the arrows, the wrap-around, a thumbnail, and the two places the
 * arrows must *not* move the slide: a recording that has the focus.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { writeReview } from '../lib/review.mjs';

/** 1×1 transparent PNG: a slide needs a file, not a picture, to be navigable. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const SHOTS = [
  { id: '01-signin', file: '01-signin.png', step: 2, expect: ['#signin-card', '#email'], width: 952, height: 956 },
  { id: '02-workspace', file: '02-workspace.png', step: 7, expect: [], width: 1505, height: 541 },
  { id: '03-done', file: '03-done.png', step: 9, expect: ['element #done'], width: 900, height: 700 },
];

let tmp;
let runs = 0;

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'path-review-'));
});

after(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

/**
 * Render a review sheet and return its HTML. Every call gets its own directory,
 * because the slideshow is driven from relative file names and two runs sharing
 * a directory is how a test starts reading another test's figures.
 */
async function render(over = {}) {
  const outDir = path.join(tmp, `run-${runs++}`);
  await mkdir(outDir, { recursive: true });
  const shots = over.shots ?? SHOTS;
  if (shots) for (const shot of shots) await writeFile(path.join(outDir, shot.file), PNG);
  const file = await writeReview({
    plan: { tutorial: 'demo', baseUrl: 'http://app.test', locale: 'en-US', viewport: { width: 1600, height: 900 } },
    planPath: '/plans/demo.plan.json',
    shots,
    scale: 2,
    outDir,
    baseUrl: 'http://app.test',
    elapsed: 12_000,
    viewport: { width: 1600, height: 900 },
    ...over,
  });
  return { html: await readFile(file, 'utf8'), outDir };
}

/** The slides the page carries, as the script reads them. */
function slides(html) {
  const json = /<script type="application\/json" id="deck-data">([\s\S]*?)<\/script>/.exec(html);
  return json ? JSON.parse(json[1]) : null;
}

/* ------------------------------------------------------------------ *
 * What the slideshow is
 * ------------------------------------------------------------------ */

test('the slideshow walks the figures the run took, in order', async () => {
  const { html } = await render();
  assert.match(html, /<section class="deck" id="deck">/);

  // Slide one is rendered as markup, so the section is not empty for a reader
  // whose browser does not run the script.
  assert.match(html, /<img id="deck-img" src="01-signin\.png" alt="01-signin" width="952" height="956">/);
  assert.match(html, /<span class="deck-count" id="deck-count" aria-live="polite"><b>1<\/b> \/ 3<\/span>/);

  // One thumbnail per figure, in the run's order, and the current one is marked
  // for a screen reader rather than by colour alone.
  const thumbs = [...html.matchAll(/<a href="([^"]+)" data-index="(\d+)"( aria-current="true")?><img src="[^"]+" alt="" loading="lazy"><span>([^<]+)<\/span><\/a>/g)];
  assert.deepEqual(
    thumbs.map(([, file, index, current, id]) => ({ file, index, current: Boolean(current), id })),
    SHOTS.map((shot, index) => ({ file: shot.file, index: String(index), current: index === 0, id: shot.id })),
  );

  // And the data the script navigates by is the same list: same ids, same files,
  // same sizes.
  assert.deepEqual(
    slides(html).map(({ file, id, width, height }) => ({ file, id, width, height })),
    SHOTS.map(({ file, id, width, height }) => ({ file, id, width, height })),
  );
});

test('one figure is a figure, not a slideshow', async () => {
  const { html } = await render({ shots: SHOTS.slice(0, 1) });
  assert.doesNotMatch(html, /id="deck"/);
  assert.doesNotMatch(html, /id="deck-data"/);
  assert.equal(slides(html), null);
  // The contact sheet is unchanged: a single figure is still reviewable.
  assert.match(html, /<div class="grid">/);
  assert.match(html, /01-signin\.png/);
});

test('a slide carries the figure’s own record, escaped', async () => {
  const { html } = await render();
  // The caption is the tile's caption: what the plan asserted on that screen is
  // the difference between a stale figure and a current one. Slide one is in the
  // markup; the rest exist only in the data the script navigates by.
  assert.match(html, /<b>01-signin<\/b> <span class=dim>952×956px · 476css · step 2 · expected: <code>#signin-card<\/code> <code>#email<\/code><\/span>/);
  const [, second, third] = slides(html).map((slide) => slide.cap);
  assert.equal(second, '<b>02-workspace</b> <span class=dim>1505×541px · 753css · step 7</span>');
  assert.equal(third, '<b>03-done</b> <span class=dim>900×700px · 450css · step 9 · expected: <code>element #done</code></span>');

  // A plan's `expect` is a selector, and a selector may contain anything. A
  // caption that closed its own script tag would be a broken page at best.
  const nasty = [
    { id: '09-</script><b>bold', file: '09-nasty.png', step: 3, expect: ['</script><i>x</i>'], width: 20, height: 10 },
    SHOTS[1],
  ];
  const escaped = await render({ shots: nasty });
  const data = /<script type="application\/json" id="deck-data">([\s\S]*?)<\/script>/.exec(escaped.html);
  assert.ok(data, 'the slide data is still a single script element');
  assert.doesNotMatch(data[1], /<\/script>/);
  // It survives the round trip as text, not as markup.
  const [slide] = JSON.parse(data[1]);
  assert.equal(slide.id, '09-</script><b>bold');
  assert.match(slide.cap, /&lt;\/script&gt;/);
  assert.doesNotMatch(slide.cap, /<i>x<\/i>/);
});

test('the controls arrive only once they work', async () => {
  const { html } = await render();
  // Hidden by default: a button that does nothing is worse than no button, and
  // the section is still a list of links to the full images without the script.
  assert.match(html, /\.deck \.nav, \.deck \.deck-count \{ display: none \}/);
  assert.match(html, /deck\.classList\.add\('live'\)/);
  // Stepping through slides is not history: the back button belongs to the page.
  assert.match(html, /history\.replaceState/);
  // And the player keeps its arrows while it has them.
  assert.match(html, /closest\('video, input, textarea, select'\)/);
});

test('the slideshow sits with the figures, after the walkthrough', async () => {
  const withVideo = await render({ videos: [{ file: 'video/01-main.webm', page: 1 }] });
  const deck = withVideo.html.indexOf('id="deck"');
  const reel = withVideo.html.indexOf('class="reelwrap"');
  const grid = withVideo.html.indexOf('<div class="grid">');
  assert.ok(reel > 0 && deck > reel, 'the video is the context a reviewer gets first');
  assert.ok(grid > deck, 'the contact sheet is the exhaustive view, under the walkthrough');
});

/* ------------------------------------------------------------------ *
 * The slideshow in a real browser
 * ------------------------------------------------------------------ */

/** The bundled browser, or one the host already has — CI installs the former. */
async function launch() {
  const candidates = process.env.CHROME
    ? [{ executablePath: process.env.CHROME }]
    : [{}, { executablePath: '/usr/local/bin/chromium' }, { executablePath: '/usr/bin/chromium' }];
  for (const options of candidates) {
    try {
      return await chromium.launch(options);
    } catch {
      /* try the next one */
    }
  }
  return null;
}

test('arrow keys, thumbnails and the counter move together', async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no Chromium on this host; set CHROME to one');
  const { outDir } = await render({ videos: [{ file: 'video/01-main.webm', page: 1 }] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`file://${path.join(outDir, 'review.html')}`);

    const state = () =>
      page.evaluate(() => ({
        src: document.querySelector('#deck-img').getAttribute('src'),
        alt: document.querySelector('#deck-img').alt,
        count: document.querySelector('#deck-count').textContent.trim(),
        cap: document.querySelector('#deck-cap').textContent.trim(),
        current: [...document.querySelectorAll('#deck-strip a')].map((a) => a.getAttribute('aria-current')),
        width: Number(document.querySelector('#deck-img').getAttribute('width')),
      }));

    const first = await state();
    assert.equal(first.src, '01-signin.png');
    assert.equal(first.count, '1 / 3');
    assert.deepEqual(first.current, ['true', 'false', 'false']);
    // The slide is sized before its file is swapped, so the stage does not jump
    // between a portrait crop and a wide frame.
    assert.equal(first.width, 952);

    const history = await page.evaluate(() => history.length);

    await page.keyboard.press('ArrowRight');
    const second = await state();
    assert.equal(second.src, '02-workspace.png');
    assert.equal(second.count, '2 / 3');
    assert.equal(second.alt, '02-workspace');
    assert.equal(second.width, 1505);
    assert.deepEqual(second.current, ['false', 'true', 'false']);
    assert.match(second.cap, /^02-workspace 1505×541px · 753css · step 7$/);
    assert.equal(await page.evaluate(() => location.hash), '#fig-2');

    // The ends wrap rather than dead-ending: a slideshow is a loop.
    await page.keyboard.press('ArrowRight');
    assert.equal((await state()).count, '3 / 3');
    await page.keyboard.press('ArrowRight');
    assert.equal((await state()).count, '1 / 3');
    await page.keyboard.press('ArrowLeft');
    assert.equal((await state()).count, '3 / 3');

    await page.keyboard.press('Home');
    assert.equal((await state()).count, '1 / 3');
    await page.keyboard.press('End');
    assert.equal((await state()).count, '3 / 3');

    // A thumbnail is a jump, and a jump is not a trip to the raw file.
    await page.click('#deck-strip a[data-index="1"]');
    const jumped = await state();
    assert.equal(jumped.count, '2 / 3');
    assert.equal(jumped.src, '02-workspace.png');
    assert.match(page.url(), /review\.html(#fig-2)?$/);

    // The arrows belong to the recording while it has the focus: a reviewer
    // scrubbing the video is not asking to change the slide.
    await page.focus('figure.reel video');
    const before = await state();
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await state(), before);

    // Every slide was a real navigation of one page, not nine of them.
    assert.equal(await page.evaluate(() => history.length), history);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('presenter mode advances on a click in the figure', async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no Chromium on this host; set CHROME to one');
  const { outDir } = await render();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`file://${path.join(outDir, 'review.html')}`);
    await page.click('#deck-present');
    await page.waitForTimeout(200);
    const fullscreen = await page.evaluate(() => Boolean(document.fullscreenElement));
    if (!fullscreen) return t.skip('this browser denied fullscreen; the button is wired but untestable here');

    const count = () => page.evaluate(() => document.querySelector('#deck-count').textContent.trim());
    assert.equal(await count(), '1 / 3');
    // The figure is the remote: clicking the picture advances, which is the one
    // place where clicking a picture is not "open it larger".
    await page.mouse.click(640, 450);
    await page.waitForTimeout(100);
    assert.equal(await count(), '2 / 3');
    // The arrows still work while presented.
    await page.keyboard.press('ArrowRight');
    assert.equal(await count(), '3 / 3');
    await page.close();
  } finally {
    await browser.close();
  }
});
