/**
 * The self-test: runs the real CLI against the fixture app, so CI proves the
 * runner works — capture, guards, evidence, review sheet — without a network,
 * an account, or a real product to install.
 *
 * The fixture is deliberately hostile in the three ways real apps are: a cookie
 * banner, a control painted before its script hides it, and a second screen that
 * replaces the first without changing the URL.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { validate } from '../lib/plan.mjs';
import { startStaticServer } from '../lib/serve.mjs';
import { startFixtureServer } from './serve.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'path-shots.mjs');
const PLAN = (name) => path.join(ROOT, 'test', 'plans', name);
const EXAMPLE = (name) => path.join(ROOT, 'plans', 'examples', name);
const SIGNIN_ROOT = path.join(ROOT, 'examples', 'signin');

let server;
let tmp;
const base = () => server.url;

before(async () => {
  server = await startFixtureServer();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'path-shots-'));
});

after(async () => {
  await server?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

/** Run the CLI the way a user would. */
function run(args, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd: tmp,
        env: {
          ...process.env,
          FIXTURE_URL: base(),
          FIXTURE_PASSWORD: 'correct-horse-battery',
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr, ms: Date.now() - started }),
    );
  });
}

/**
 * Serve the shipped sign-in example as one of its builds. The variant belongs to
 * the app, never to the plan: the same plan file is pointed at a different build.
 */
async function withVariant(variant, fn) {
  const example = await startStaticServer({
    root: SIGNIN_ROOT,
    transform: (html) => html.replaceAll('__VARIANT__', variant),
  });
  try {
    return await fn(example.url);
  } finally {
    await example.close();
  }
}


/** PNG dimensions straight off IHDR: no dependency needed. */
function pngSize(file) {
  return readFile(file).then((b) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) }));
}

/**
 * WebM dimensions straight off the container — the same hand-parsing the PNG
 * check above does, for the other format the runner writes. `--video-size` is
 * only worth a flag if the *file* has that shape: the console line is a report,
 * and Playwright silently pads a canvas it cannot fill.
 *
 * An element is an ID, a size, then its payload; the TrackEntry carries
 * PixelWidth (0xB0) and PixelHeight (0xBA). Clusters are skipped whole, because
 * descending into every frame is how this stops being a fast test.
 */
function webmSize(buffer) {
  const MASTERS = new Set([
    0x18538067 /* Segment */,
    0x1654ae6b /* Tracks */,
    0xae /* TrackEntry */,
    0xe0 /* Video — PixelWidth/Height live here, not in the entry */,
  ]);
  const readVint = (at) => {
    const first = buffer[at];
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
    let value = first & (0xff >> length);
    for (let i = 1; i < length; i += 1) value = value * 256 + buffer[at + i];
    return { value, length, unknown: value === 2 ** (7 * length) - 1 };
  };
  const readId = (at) => {
    const first = buffer[at];
    let length = 1;
    while (length <= 4 && !(first & (0x80 >> (length - 1)))) length += 1;
    let id = 0;
    for (let i = 0; i < length; i += 1) id = id * 256 + buffer[at + i];
    return { id, length };
  };
  const found = {};
  const walk = (at, end) => {
    while (at < end) {
      const id = readId(at);
      const size = readVint(at + id.length);
      const start = at + id.length + size.length;
      const stop = size.unknown ? end : Math.min(end, start + size.value);
      if (id.id === 0xb0 || id.id === 0xba) {
        let value = 0;
        for (let i = 0; i < size.value; i += 1) value = value * 256 + buffer[start + i];
        found[id.id === 0xb0 ? 'width' : 'height'] = value;
        if (found.width && found.height) return;
      } else if (MASTERS.has(id.id) && (!size.unknown || id.id === 0x18538067)) {
        // A live-muxed file writes the Segment with an unknown size; its children
        // still have theirs.
        walk(start, stop);
        if (found.width && found.height) return;
      }
      at = stop;
    }
  };
  walk(0, buffer.length);
  return found;
}

const shotFile = (dir, id) => path.join(tmp, dir, `${id}.png`);

test('captures the whole path, with the slide guards applied', async () => {
  const out = path.join(tmp, 'happy');
  const res = await run([PLAN('fixture.plan.json'), '--out', out, '--review']);
  assert.equal(res.code, 0, `exit ${res.code}\n${res.stderr}`);

  // Three figures, in plan order.
  assert.deepEqual(
    (await readdir(out)).filter((f) => f.endsWith('.png')).sort(),
    ['01-welcome.png', '02-step2.png', '03-echo.png'],
  );

  // A selector clip is exact: the card is 360 CSS px wide, padded 16 either
  // side, captured at 2x — so a re-shot figure is byte-comparable in size and a
  // drifting crop shows up as a diff rather than a surprise.
  const welcome = await pngSize(shotFile('happy', '01-welcome'));
  assert.equal(welcome.width, 784);
  assert.ok(welcome.height > 0);
  assert.equal((await pngSize(shotFile('happy', '03-echo'))).width, 784);

  // ...and a full-frame figure is trimmed to its content, so it is smaller than
  // the viewport it was captured in.
  const full = await pngSize(shotFile('happy', '02-step2'));
  assert.ok(full.width < 1800, `trimmed full frame is ${full.width}px, expected under 1800`);

  // The capture scale travels beside the pictures: without it a page cannot tell
  // the figure's real on-screen size from its pixel size.
  const meta = JSON.parse(await readFile(path.join(out, '.shots.json'), 'utf8'));
  assert.equal(meta['01-welcome'].scale, 2);
  assert.equal(meta['01-welcome'].width, 784);

  // A scraped value is kept (mode 600) so a failed run does not lose it, and it
  // reached the later step through `${token}`.
  const vars = path.join(out, '.vars.json');
  assert.equal((await stat(vars)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(vars, 'utf8')).token, 't0ken-fixture-4f9a2c');

  // The review sheet is what a human signs off on: ids, sizes and the asserted text.
  const review = await readFile(path.join(out, 'review.html'), 'utf8');
  assert.match(review, /01-welcome/);
  assert.match(review, /784×\d+px · 392css/);
  assert.match(review, /Welcome back/);
  assert.match(review, /Signed in with/);
});

test('--no-trim keeps the frame the browser actually painted', async () => {
  const out = path.join(tmp, 'notrim');
  const res = await run([PLAN('fixture.plan.json'), '--only', '02-step2', '--out', out, '--no-trim']);
  assert.equal(res.code, 0, `exit ${res.code}\n${res.stderr}`);
  assert.deepEqual(await pngSize(shotFile('notrim', '02-step2')), { width: 1800, height: 1400 });
});

test('a stale assertion fails the run and leaves evidence', async () => {
  const out = path.join(tmp, 'stale');
  const res = await run([PLAN('fixture-stale.plan.json'), '--out', out, '--review']);
  assert.equal(res.code, 1, 'a stale plan must not report success');

  const failures = await readdir(path.join(out, 'failures'));
  assert.equal(failures.filter((f) => f.endsWith('.png')).length, 1);
  assert.equal(failures.filter((f) => f.endsWith('.html')).length, 1);
  const notes = await readFile(path.join(out, 'failures', failures.find((f) => f.endsWith('.txt'))), 'utf8');
  assert.match(notes, /expected page text "Set up two-factor authentication"/);
  // The useful part: what was actually on screen, so the plan can be fixed from
  // evidence instead of someone's description of the page.
  assert.match(notes, /on screen:/);
  assert.match(notes, /button #submit :: Sign in/);

  // The figure banked before the failure is still reviewable.
  assert.ok(existsSync(path.join(out, '01-welcome.png')));
  assert.ok(existsSync(path.join(out, 'review.html')));
});

test('a selector guard passes, and the review names the element it required', async () => {
  const out = path.join(tmp, 'selector');
  const res = await run([PLAN('fixture-selector.plan.json'), '--out', out, '--review']);
  assert.equal(res.code, 0, `exit ${res.code}\n${res.stderr}`);

  // The review sheet carries the guard, so a reviewer sees what the screen had
  // to prove without reading the plan.
  const review = await readFile(path.join(out, 'review.html'), 'utf8');
  assert.match(review, /element #card/);
  assert.match(review, /element #submit/);
});

test('a required element that is missing stops the run and leaves evidence', async () => {
  const out = path.join(tmp, 'selector-missing');
  const res = await run([PLAN('fixture-selector-missing.plan.json'), '--out', out]);
  assert.equal(res.code, 1, 'a missing control must not report success');
  assert.match(res.stderr, /expected element "#magic-link" on screen/);

  const failures = await readdir(path.join(out, 'failures'));
  const notes = await readFile(path.join(out, 'failures', failures.find((f) => f.endsWith('.txt'))), 'utf8');
  assert.match(notes, /on screen:/);
});

test('a malformed guard is refused before a browser opens', async () => {
  const out = path.join(tmp, 'invalid-expect');
  const res = await run([PLAN('invalid-expect.plan.json'), '--out', out]);
  assert.equal(res.code, 2, `exit ${res.code}\n${res.stderr}`);
  assert.match(res.stderr, /"expect" has unknown key "sel"/);
  assert.match(res.stderr, /allowed: "selector"/);
  assert.ok(!existsSync(out), 'nothing may be written for a plan that was never run');
});

test('validate names the guard problems that do not need a browser', () => {
  const withGuard = (expect) => ({ baseUrl: 'http://127.0.0.1:1', steps: [{ goto: '/', expect }] });
  assert.throws(() => validate(withGuard({ selector: [] })), /"expect\.selector" needs/);
  assert.throws(() => validate(withGuard({})), /"expect\.selector" needs/);
  assert.throws(() => validate(withGuard([''])), /non-empty string/);
  assert.throws(() => validate(withGuard(null)), /must be page text/);
  assert.doesNotThrow(() => validate(withGuard({ selector: '#card' })));
  assert.doesNotThrow(() => validate(withGuard({ selector: ['#card', '#email'] })));
});

test('the same plan against the changed copy refreshes the figure and passes', async () => {
  // The copy-only build: the sentences and the button changed, no id did. The
  // guard has nothing to object to, so the run is green and the figures are new
  // — the "screenshots just refresh" case.
  const first = path.join(tmp, 'signin-current');
  const second = path.join(tmp, 'signin-refreshed');

  const before = await withVariant('current', (url) =>
    run([EXAMPLE('signin.plan.json'), '--out', first], { SIGNIN_URL: url }),
  );
  assert.equal(before.code, 0, `exit ${before.code}\n${before.stderr}`);

  const after = await withVariant('refreshed', (url) =>
    run([EXAMPLE('signin.plan.json'), '--out', second], { SIGNIN_URL: url }),
  );
  assert.equal(after.code, 0, `exit ${after.code}\n${after.stderr}`);

  const a = await readFile(path.join(first, '01-signin.png'));
  const b = await readFile(path.join(second, '01-signin.png'));
  assert.notDeepEqual(a, b, 'a copy change must produce a new figure, not the old one');
});

test('a removed password field fails the run, after the card was banked', async () => {
  const out = path.join(tmp, 'signin-broken');
  const res = await withVariant('broken', (url) =>
    run([EXAMPLE('signin.plan.json'), '--out', out, '--review'], { SIGNIN_URL: url }),
  );
  assert.equal(res.code, 1, 'a plan that requires #password must not pass a passwordless screen');
  assert.match(res.stderr, /expected element "#password" on screen/);

  // The card from the previous step is still reviewable, and the evidence names
  // the control that replaced the one the plan required.
  assert.ok(existsSync(path.join(out, '01-signin.png')));
  assert.ok(existsSync(path.join(out, 'review.html')));
  const failures = await readdir(path.join(out, 'failures'));
  const notes = await readFile(path.join(out, 'failures', failures.find((f) => f.endsWith('.txt'))), 'utf8');
  assert.match(notes, /button #magic-link/);
});

test('the Norwegian plan is the same path with no translated assertion', async () => {
  const out = path.join(tmp, 'signin-nb');
  const res = await withVariant('current', (url) =>
    run([EXAMPLE('signin-nb.plan.json'), '--out', out, '--review'], { SIGNIN_URL: url }),
  );
  assert.equal(res.code, 0, `exit ${res.code}\n${res.stderr}`);

  const review = await readFile(path.join(out, 'review.html'), 'utf8');
  assert.match(review, /nb-NO/);

  // If a label ever creeps into the plan, "same path, another language" quietly
  // stops being true.
  const plan = JSON.parse(await readFile(EXAMPLE('signin-nb.plan.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(plan), /Velkommen|Logg inn|Passord/);
});

test('forgetting the locale in the Norwegian plan is caught, not shipped', async () => {
  const plan = JSON.parse(await readFile(EXAMPLE('signin-nb.plan.json'), 'utf8'));
  plan.tutorial = 'signin-nb-forgot-locale';
  plan.locale = 'en-US';
  const file = path.join(tmp, 'signin-forgot-locale.plan.json');
  await writeFile(file, JSON.stringify(plan, null, 2));

  const res = await withVariant('current', (url) =>
    run([file, '--out', path.join(tmp, 'forgot-locale')], { SIGNIN_URL: url }),
  );
  assert.equal(res.code, 1);
  assert.match(res.stderr, /page rendered lang="nb", plan pins "en-US"/);
});

test('a page rendering another language is refused, not captured', async () => {
  const out = path.join(tmp, 'locale');
  const res = await run([PLAN('fixture-locale.plan.json'), '--out', out]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /would ship the operator's locale/);
  assert.ok(!existsSync(shotFile('locale', '01-welcome')), 'no figure may be written');
});

test('a theme that has not settled is refused, not captured', async () => {
  const out = path.join(tmp, 'theme');
  const res = await run([PLAN('fixture-light.plan.json'), '--out', out]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /light background/);
});

test('a mistyped step key is refused before a browser opens', async () => {
  const out = path.join(tmp, 'invalid');
  const res = await run([PLAN('invalid.plan.json'), '--out', out]);
  assert.equal(res.code, 2, `exit ${res.code}\n${res.stderr}`);
  assert.match(res.stderr, /unknown key "clickk"/);
  assert.match(res.stderr, /allowed:/);
  assert.ok(!existsSync(out), 'nothing may be written for a plan that was never run');
  assert.ok(res.ms < 10_000, `refusing took ${res.ms}ms — it should not wait on a browser`);
});

test('--only and --poster name a figure that exists', async () => {
  const res = await run([PLAN('fixture.plan.json'), '--only', '99-nope', '--out', path.join(tmp, 'only')]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--only names no figure "99-nope"/);
  // The message lists what it could have been, so a rename is a one-line fix.
  assert.match(res.stderr, /01-welcome, 02-step2, 03-echo/);

  // A mistyped poster is a player showing a broken image, so it is refused the
  // same way rather than rendering an empty frame.
  const poster = await run([PLAN('fixture.plan.json'), '--poster', '99-nope', '--out', path.join(tmp, 'poster')]);
  assert.equal(poster.code, 2);
  assert.match(poster.stderr, /--poster names no figure "99-nope"/);
});

test('a var with no value says which environment variable to set', async () => {
  const res = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, PLAN('fixture.plan.json'), '--out', path.join(tmp, 'novar')],
      // FIXTURE_PASSWORD deliberately absent: the plan declares it as an env var.
      { cwd: tmp, env: { ...process.env, FIXTURE_URL: base(), FIXTURE_PASSWORD: '' } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /plan var "password" needs env FIXTURE_PASSWORD/);
});

test('the shipped example plans validate', async () => {
  const files = [
    PLAN('fixture.plan.json'),
    PLAN('fixture-video.plan.json'),
    PLAN('fixture-video-wide.plan.json'),
    PLAN('fixture-stale.plan.json'),
    PLAN('fixture-selector.plan.json'),
    PLAN('fixture-selector-missing.plan.json'),
    EXAMPLE('signin.plan.json'),
    EXAMPLE('signin-nb.plan.json'),
    EXAMPLE('signin-captions.plan.json'),
    path.join(ROOT, 'plans', 'examples', 'railway-installer.plan.json'),
  ];
  for (const file of files) {
    const plan = JSON.parse(await readFile(file, 'utf8'));
    assert.doesNotThrow(() => validate(plan), `${path.basename(file)} must satisfy the plan contract`);
  }
  const schema = JSON.parse(await readFile(path.join(ROOT, 'plans', 'schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

/**
 * Video is the artefact with the least obvious failure mode: a recording that
 * exists and contains nothing looks like success. These tests therefore read the
 * run's own timeline and compare pictures, instead of trusting the file size.
 */
const FFMPEG_HINT = /needs Playwright's ffmpeg/;

test('--video records a walkthrough a reviewer can follow', async (t) => {
  const out = path.join(tmp, 'video');
  const res = await run([PLAN('fixture-video.plan.json'), '--out', out, '--video', '--review', '--speed', '20']);
  if (res.code !== 0 && FFMPEG_HINT.test(res.stderr)) return t.skip('Playwright ffmpeg is not installed here');
  assert.equal(res.code, 0, `exit ${res.code}\n${res.stderr}`);

  // One deterministic file per page, named for the review sheet — plus the
  // subtitles the plan's `caption`s produce.
  const videos = await readdir(path.join(out, 'video'));
  assert.deepEqual(videos, ['01-main.vtt', '01-main.webm']);
  assert.ok((await stat(path.join(out, 'video', '01-main.webm'))).size > 10_000, 'the recording is not empty');

  // The timeline is what makes the video reviewable: chapters with times, and a
  // record that the pointer was hidden for every figure.
  const timeline = JSON.parse(await readFile(path.join(out, '.timeline.json'), 'utf8'));
  assert.equal(timeline.humanized, true);
  assert.equal(timeline.seed, 'fixture-video-v1');
  assert.equal(timeline.fps, 25);
  // The canvas is what a viewer sees: the plan's viewport here, because a 900×700
  // page recorded onto a 16:9 canvas would be a stripe beside a page.
  assert.deepEqual(timeline.videoSize, { width: 900, height: 700 });
  assert.equal(timeline.videos[0].file, 'video/01-main.webm');
  // The record names its sidecar, so the two files travel together.
  assert.equal(timeline.videos[0].captionsFile, 'video/01-main.vtt');
  const shotSteps = timeline.steps.filter((step) => step.shot);
  assert.deepEqual(shotSteps.map((step) => step.shot.id), ['01-welcome', '02-step2', '03-echo']);
  for (const step of shotSteps) assert.equal(step.shot.cursorHidden, true, `${step.shot.id} was captured with the pointer hidden`);
  // Pacing is recorded, not inferred: the recorded delays are what a re-run has
  // to reproduce.
  assert.ok(timeline.steps.reduce((sum, step) => sum + step.plannedMs, 0) > 0, 'the run scheduled human delays');
  for (const step of shotSteps) assert.ok(step.plannedMs > 0, `the shot at ${step.shot.id} held its frame`);
  // Times only ever move forward, or a chapter seek lands somewhere else.
  for (let i = 1; i < timeline.steps.length; i += 1) {
    assert.ok(timeline.steps[i].startMs >= timeline.steps[i - 1].startMs, `step ${i + 1} starts before the one before it`);
  }

  // The subtitles are part of the run's record, not a post-processing step: each
  // captioned step keeps its words, so a `.vtt` can be rebuilt without the plan.
  const captioned = timeline.steps.filter((step) => step.caption);
  assert.deepEqual(
    captioned.map((step) => step.caption),
    ["Open the app.", "The card asks for the operator's email.", 'Four services will be created.', 'A value read off the page comes back.'],
  );
  assert.equal(timeline.steps.find((step) => step.name === 'sign in').caption, null, 'a step without one clears the subtitle');

  // The sidecar is what a player, a docs page or a video host actually reads.
  const vtt = await readFile(path.join(out, 'video', '01-main.vtt'), 'utf8');
  assert.ok(vtt.startsWith('WEBVTT\n\n'), 'a WebVTT file starts with its header');
  assert.match(vtt, /^NOTE\nfixture-video · \d+ cue\(s\) · seed fixture-video-v1$/m);
  const cues = vtt.match(/\d\d:\d\d:\d\d\.\d\d\d --> \d\d:\d\d:\d\d\.\d\d\d/g) ?? [];
  assert.equal(cues.length, captioned.length, 'one cue per captioned step, none merged away or invented');
  assert.match(vtt, /Open the app\./);
  // A cue cannot describe a frame before the recording exists, and its window is
  // the step's own: the first cue starts at (or after) zero and every cue ends
  // after it starts.
  for (const cue of cues) {
    const [from, to] = cue.split(' --> ');
    assert.ok(to > from, `cue ${cue} ends before it starts`);
    assert.ok(from >= '00:00:00.000', 'a cue never starts before the file does');
  }

  const review = await readFile(path.join(out, 'review.html'), 'utf8');
  assert.match(review, /<video/);
  assert.match(review, /video\/01-main\.webm/);
  // The player carries the subtitles as a track (so they can be turned off and
  // are searchable) *and* the recorder drew them in, which is what a viewer who
  // never opens the review sheet sees.
  assert.match(review, /<track kind="captions" src="video\/01-main\.vtt" srclang="en" label="Captions">/);
  assert.ok(!/label="Captions" default>/.test(review), 'the track cannot be on by default: it would paint over the drawn-in pill');
  assert.match(review, /#t=\d/);
  assert.match(review, /seed fixture-video-v1/);
  // A chapter must seek the player in place: a reviewer jumps around a recording
  // and needs the figure list it is comparing against to stay on screen. The
  // handler is progressive — the plain `#t=` href still works without it.
  assert.match(review, /ol\.chapters a\[href\*="#t="\]/);
  assert.match(review, /player\.currentTime = Number\(seconds\)/);

  // The figures are unchanged by any of it. This is the claim that matters most
  // for a *recording*: the pointer is drawn into the very page the figure is
  // taken from, so "hidden before the capture" has to be proven, not asserted.
  // The fixture paints no transitions, so the same plan without `--video` — and
  // therefore without a humanizer at all — must produce the same bytes.
  const plain = path.join(tmp, 'video-plain');
  const baseline = await run([PLAN('fixture-video.plan.json'), '--out', plain]);
  assert.equal(baseline.code, 0, baseline.stderr);
  for (const id of ['01-welcome', '02-step2', '03-echo']) {
    const [recorded, without] = await Promise.all([readFile(shotFile('video', id)), readFile(shotFile('video-plain', id))]);
    assert.ok(recorded.equals(without), `${id} differs between a recorded run and a plain one — the pointer reached the figure`);
  }
  // Still the same picture it always was: a clipped card, not a viewport frame.
  assert.equal((await pngSize(shotFile('video', '01-welcome'))).width, 784);
});

test('--video-size shrinks the canvas, and refuses one it cannot fill', async (t) => {
  // A 1440p plan recorded onto a 1080p canvas: the same walkthrough, a lighter
  // file. Playwright never scales a recording *up* and pads what the frame does
  // not cover, so the canvas has to be the viewport's shape and no larger —
  // which is why the assertion reads the file's own header, not the log line.
  const wide = path.join(tmp, 'video-wide');
  const res = await run([
    PLAN('fixture-video-wide.plan.json'),
    '--out', wide,
    '--video', '--video-size', '1920x1080', '--speed', '20',
  ]);
  if (res.code !== 0 && FFMPEG_HINT.test(res.stderr)) return t.skip('Playwright ffmpeg is not installed here');
  assert.equal(res.code, 0, `exit ${res.code}\n${res.stderr}`);

  const timeline = JSON.parse(await readFile(path.join(wide, '.timeline.json'), 'utf8'));
  assert.deepEqual(timeline.viewport, { width: 2560, height: 1440 });
  assert.deepEqual(timeline.videoSize, { width: 1920, height: 1080 });
  assert.deepEqual(webmSize(await readFile(path.join(wide, 'video', '01-main.webm'))), { width: 1920, height: 1080 });

  // A 700 px-tall viewport cannot fill a 16:9 canvas: the run would be a grey
  // stripe beside a page. Refused before a browser opens, naming both fixes.
  const banded = path.join(tmp, 'video-banded');
  const refused = await run([PLAN('fixture-video.plan.json'), '--out', banded, '--video', '--video-size', '1920x1080']);
  assert.equal(refused.code, 2, 'a mismatched canvas is a usage error, not a run');
  assert.match(refused.stderr, /1920x1080 is 1\.778:1/);
  assert.match(refused.stderr, /viewport is 900x700/);
  assert.match(refused.stderr, /--video-size 900x700/);
  assert.equal(existsSync(banded), false, 'a refused run writes nothing at all');

  // Right shape, wrong direction: a 16:9 canvas bigger than a 16:9 viewport is
  // still a band — the page would sit in the corner of it.
  const bigger = path.join(tmp, 'video-bigger');
  const grown = await run([
    PLAN('fixture-video-wide.plan.json'),
    '--out', bigger,
    '--video', '--video-size', '3840x2160',
  ]);
  assert.equal(grown.code, 2);
  assert.match(grown.stderr, /larger than the 2560x1440 viewport/);
  assert.match(grown.stderr, /does not scale a recording up/);
  assert.equal(existsSync(bigger), false);
});

test('--video-size is validated before anything else runs', async () => {
  const bad = await run([PLAN('fixture-video.plan.json'), '--out', path.join(tmp, 'video-bad-size'), '--video', '--video-size', '1080p']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--video-size must be <width>x<height>/);
});

test('humanizing changes the pacing, not the picture — and replays the same path', async (t) => {
  const plain = path.join(tmp, 'pace-plain');
  const humanA = path.join(tmp, 'pace-human-a');
  const humanB = path.join(tmp, 'pace-human-b');
  const base = [PLAN('fixture.plan.json'), '--speed', '20'];

  const first = await run([...base, '--out', plain]);
  const second = await run([...base, '--out', humanA, '--humanize', '--seed', 'offline-test']);
  const third = await run([...base, '--out', humanB, '--humanize', '--seed', 'offline-test']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(third.code, 0, third.stderr);

  // A pointer inside a picture is the one thing a viewer would notice. The
  // strongest proof available: the bytes are the same as without a pointer.
  for (const id of ['01-welcome', '02-step2', '03-echo']) {
    const [without, withHuman] = await Promise.all([readFile(shotFile('pace-plain', id)), readFile(shotFile('pace-human-a', id))]);
    assert.ok(without.equals(withHuman), `${id} differs between a plain run and a humanized one — the pointer reached the figure`);
  }

  // Same seed, same scheduled delays: a video can be re-recorded, not guessed at.
  const planned = async (dir) => JSON.parse(await readFile(path.join(dir, '.timeline.json'), 'utf8')).steps.map((step) => step.plannedMs);
  assert.deepEqual(await planned(humanA), await planned(humanB));
});

test('--no-humanize records the raw machine-speed cut', async (t) => {
  const out = path.join(tmp, 'video-raw');
  const res = await run([PLAN('fixture-video.plan.json'), '--out', out, '--video', '--no-humanize', '--speed', '20']);
  if (res.code !== 0 && FFMPEG_HINT.test(res.stderr)) return t.skip('Playwright ffmpeg is not installed here');
  assert.equal(res.code, 0, `exit ${res.code}\n${res.stderr}`);
  const timeline = JSON.parse(await readFile(path.join(out, '.timeline.json'), 'utf8'));
  assert.equal(timeline.humanized, false);
  const shotSteps = timeline.steps.filter((step) => step.shot);
  assert.equal(shotSteps.length, 3);
  assert.ok(shotSteps.every((step) => step.shot.cursorHidden === false), 'nothing was hidden, because nothing was drawn');
});

test('a humanize block with a bad knob is refused before a browser opens', async () => {
  const bad = (humanize) => ({ tutorial: 'bad-humanize', baseUrl: 'http://127.0.0.1:1', humanize, steps: [{ goto: '/' }] });
  const cases = [
    [{ speed: 0 }, /"humanize.speed" must be a positive number/],
    [{ humanzie: true }, /unknown "humanize" key "humanzie"/],
    [{ typing: { minMs: 200, maxMs: 100 } }, /typing.maxMs" must be >=/],
  ];
  for (const [humanize, expected] of cases) {
    const file = path.join(tmp, `bad-${Object.keys(humanize)[0]}.plan.json`);
    await writeFile(file, JSON.stringify(bad(humanize)));
    const res = await run([file, '--out', path.join(tmp, 'never')]);
    assert.equal(res.code, 2, `exit ${res.code}\n${res.stderr}`);
    assert.match(res.stderr, expected);
    assert.ok(res.ms < 10_000, `refusing took ${res.ms}ms — it should not wait on a browser`);
  }
});
