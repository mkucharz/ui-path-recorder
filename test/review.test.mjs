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
import zlib from 'node:zlib';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { writeReview } from '../lib/review.mjs';

/**
 * A real PNG of the size a shot claims to be.
 *
 * The slideshow's job is to fit a picture of *its* proportions inside a frame of
 * the player's, so the fixture has to carry those proportions: a 1×1 stand-in
 * would let a stage that does not contain a portrait figure pass.
 */
function png(width, height) {
  const row = Buffer.alloc(1 + width * 3); // filter byte + RGB triplets
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}

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
  if (shots) for (const shot of shots) await writeFile(path.join(outDir, shot.file), png(shot.width, shot.height));
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

test('every slide plays in the same 16:9 frame', async () => {
  const { html } = await render();
  // The player is a box, not a picture: a portrait crop and a wide frame cannot
  // be allowed to resize it, because then the page jumps on every step.
  assert.match(html, /\.deck-stage \{[^}]*aspect-ratio: 16 \/ 9/);
  assert.match(html, /\.deck-stage \{[^}]*max-width: 1120px/);
  // The old stage grew with its image, which is the behaviour this replaced.
  assert.doesNotMatch(html, /min-height: 160px/);
  // The figure is fitted inside the frame and never enlarged past its pixels.
  // It is positioned against the stage's own box: a percentage `max-height`
  // inside a grid area sized by the image is indefinite and resolves to `none`,
  // which lets a portrait figure overflow the frame instead of fitting it.
  assert.match(html, /\.deck-stage img \{[^}]*position: absolute/);
  // Measured against the stage's padding box, so the letterbox gap is taken off
  // the percentages: `max-height: 100%` would let a full-height figure sit flush
  // against the border the inset was meant to keep clear.
  assert.match(html, /\.deck-stage img \{[^}]*max-width: calc\(100% - 2rem\)/);
  assert.match(html, /\.deck-stage img \{[^}]*max-height: calc\(100% - 2rem\)/);
  assert.doesNotMatch(html, /object-fit: (cover|fill)/);
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
      page.evaluate(() => {
        const stage = document.querySelector('#deck-stage').getBoundingClientRect();
        const img = document.querySelector('#deck-img').getBoundingClientRect();
        return {
          src: document.querySelector('#deck-img').getAttribute('src'),
          alt: document.querySelector('#deck-img').alt,
          count: document.querySelector('#deck-count').textContent.trim(),
          cap: document.querySelector('#deck-cap').textContent.trim(),
          current: [...document.querySelectorAll('#deck-strip a')].map((a) => a.getAttribute('aria-current')),
          width: Number(document.querySelector('#deck-img').getAttribute('width')),
          stage: { width: Math.round(stage.width), height: Math.round(stage.height) },
          img: { width: Math.round(img.width), height: Math.round(img.height) },
        };
      });

    const first = await state();
    assert.equal(first.src, '01-signin.png');
    assert.equal(first.count, '1 / 3');
    assert.deepEqual(first.current, ['true', 'false', 'false']);
    // The slide is sized before its file is swapped, so the stage does not jump
    // between a portrait crop and a wide frame.
    assert.equal(first.width, 952);
    // The frame is the player's, not the picture's: 16:9 whatever the slide is.
    assert.ok(Math.abs(first.stage.height - (first.stage.width * 9) / 16) <= 1, `the frame is 16:9 (${first.stage.width}x${first.stage.height})`);
    // And the figure is contained in it rather than cropped — a portrait crop
    // uses the frame's height, it does not run past it, and it keeps the
    // letterbox gap the inset asks for instead of sitting on the border.
    assert.ok(first.img.height <= first.stage.height && first.img.width <= first.stage.width, 'the figure fits the frame');
    assert.ok(first.img.height >= first.stage.height - 40, `the portrait figure uses the frame's height (${first.img.height} of ${first.stage.height})`);
    assert.ok(first.img.height <= first.stage.height - 30, `and keeps the letterbox gap (${first.img.height} of ${first.stage.height})`);

    const history = await page.evaluate(() => history.length);

    await page.keyboard.press('ArrowRight');
    const second = await state();
    assert.equal(second.src, '02-workspace.png');
    assert.equal(second.count, '2 / 3');
    assert.equal(second.alt, '02-workspace');
    assert.equal(second.width, 1505);
    assert.deepEqual(second.current, ['false', 'true', 'false']);
    assert.deepEqual(second.stage, first.stage, 'the frame does not move between slides');
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
