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
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { validate } from '../lib/plan.mjs';
import { findMuxFfmpeg, probeOpus, runCommand } from '../lib/narration.mjs';
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
    EXAMPLE('signin-checklist.plan.json'),
    EXAMPLE('signin-walkthrough.plan.json'),
    EXAMPLE('signin-sidebar.plan.json'),
    EXAMPLE('signin-sidebar-left.plan.json'),
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

  // The checklist is a property of the steps, not a list of its own: what the
  // panel draws is recoverable from the timeline alone, in first-appearance
  // order, and each row carries the moment its tick happened.
  const checked = timeline.steps.filter((step) => step.check);
  assert.deepEqual(
    checked.map((step) => step.check),
    ['Open the installer', 'Sign in as the operator', 'Pick the target', 'Copy the generated password'],
  );
  assert.equal(timeline.steps.find((step) => step.name === 'sign in').check, null, 'a step without one ticks nothing');
  // The fixture viewport is under the panel's comfortable width, so the run says
  // the panel's share of it out loud instead of leaving it to the recording.
  assert.match(res.stdout, /checklist: 4 item\(s\)\s+side=right\s+width=260px/);
  assert.match(res.stderr, /warning: viewport is 900px wide; a right checklist takes 260px of it/);

  // The cards are chapters, not padding: the video opens on the title and closes
  // on the recap, and both are seekable like a step. `cardMs` is divided by
  // `--speed` with every other delay, so a fast replay stays fast.
  assert.match(res.stdout, /cards: intro \+ outro\s+50ms each/);
  const cardSteps = timeline.steps.filter((step) => step.action === 'card');
  assert.deepEqual(cardSteps.map((step) => step.name), ['intro', 'outro']);
  assert.equal(timeline.steps[0].name, 'intro', 'the title card is the first thing recorded');
  assert.equal(timeline.steps.at(-1).name, 'outro', 'and the recap is the last');
  assert.equal(cardSteps[1].index, timeline.steps.length - 1, 'the end card is numbered after the last step');
  assert.equal(cardSteps[0].page, 1);
  assert.equal(cardSteps[0].caption, null, 'a card carries no subtitle: it is its own words');
  assert.equal(cardSteps[0].check, null);
  // A card is a whole screen, so it either fits the frame or the run says it does
  // not; a fixture card that warns would be a card the recording cannot show.
  assert.doesNotMatch(res.stderr, /card is \d+px taller/);

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
  // The cards are in the playlist too, so a reviewer can jump to the title and
  // to the recap instead of scrubbing for them.
  assert.match(review, /video\/01-main\.webm#t=[\d.]+">intro<\/a>/);
  assert.match(review, /video\/01-main\.webm#t=[\d.]+">outro<\/a>/);
  assert.match(review, /seed fixture-video-v1/);
  // A chapter must seek the player in place: a reviewer jumps around a recording
  // and needs the figure list it is comparing against to stay on screen. The
  // handler is progressive — the plain `#t=` href still works without it.
  assert.match(review, /ol\.chapters a\[href\*="#t="\]/);
  assert.match(review, /player\.currentTime = Number\(seconds\)/);
  // The checklist in the sheet is the one the panel drew, each row a seek: the
  // only way a reviewer can check that a tick lands on the moment it claims.
  assert.match(review, /<ol class="chapters checks">/);
  assert.match(review, /Open the installer<\/a> <span class=dim>\d+\.\ds<\/span>/);
  assert.match(review, /Copy the generated password<\/a>/);

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

/**
 * A `say` that is not macOS `say`, installed on PATH for one run.
 *
 * The engine, as the pipeline finds it: a binary called `say` that honours the
 * flags and writes the WAV it is asked for. Detection is by binary rather than
 * by `process.platform`, which is what lets a Linux host drive the real
 * pipeline. It writes 1.5 s of tone — a length the test knows, so "did the step
 * wait?" is a comparison rather than an eyeball.
 *
 * @param {string} dir A directory owned by the test.
 * @param {string} ffmpeg The ffmpeg that can write PCM.
 * @returns {Promise<string>} the directory to prepend to PATH.
 */
async function stubSay(dir, ffmpeg) {
  const bin = path.join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, 'say'),
    [
      '#!/bin/sh',
      'out=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      `exec "${ffmpeg}" -loglevel error -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=1.5" -ac 1 -c:a pcm_s16le "$out"`,
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

/**
 * Narration, end to end, with a `say` that is not macOS `say`.
 *
 * A stub on PATH writes a fixed 1.5 s WAV, which makes the pacing arithmetic
 * assertable to the millisecond: every captioned step must stay on screen for at
 * least that line plus the tail, or the next screen arrives mid-sentence. That
 * invariant is what the unit tests cannot check — they can place samples, but
 * only a real run shows whether the *step* waited.
 */
test('--narration paces each step to its own line, and muxes it in', async (t) => {
  const ffmpeg = await findMuxFfmpeg();
  if (!ffmpeg) return t.skip('narration needs a system ffmpeg with libopus');
  if (!(await probeOpus({ ffmpeg }))) return t.skip('the system ffmpeg has no libopus encoder');

  const bin = await stubSay(tmp, ffmpeg);

  const out = path.join(tmp, 'narrated');
  const res = await run([PLAN('fixture-narration.plan.json'), '--out', out, '--video', '--review', '--narration', '--rate', '200'], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    UI_PATH_RECORDER_CACHE_DIR: path.join(tmp, 'narration-cache'),
  });
  assert.equal(res.code, 0, `exit ${res.code}\n${res.stderr}`);

  // The run said what it spoke, and did not warn that a line outran its step —
  // the warning this feature exists to make unnecessary. `console.warn` writes
  // to stderr, so both streams are read: an assertion against the stream the
  // warning never reaches passes no matter what the run did.
  assert.match(res.stdout, /narration: 5 lines, voice system default @ 200 wpm, 400ms tail/);
  assert.equal(/spoke\s+5\/5/.test(res.stdout), true, 'every line was synthesized before the browser opened');
  for (const stream of [res.stdout, res.stderr]) {
    assert.doesNotMatch(stream, /past its step/, 'a step must wait for its own line');
    assert.doesNotMatch(stream, /talk over each other/, 'two lines must never overlap');
  }

  // Both artefacts beside the recording, and the sound really in the file.
  assert.deepEqual((await readdir(path.join(out, 'video'))).sort(), ['01-main.vtt', '01-main.webm']);
  const probe = JSON.parse(
    (
      await runCommand(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name',
        '-of', 'json',
        path.join(out, 'video', '01-main.webm'),
      ])
    ).stdout,
  );
  const kinds = probe.streams.map((stream) => `${stream.codec_type}:${stream.codec_name}`);
  assert.ok(kinds.includes('audio:opus'), `the recording carries the voice (${kinds.join(', ')})`);
  assert.ok(kinds.includes('video:vp9'), `the picture was copied, not re-encoded (${kinds.join(', ')})`);

  // The subtitle transcribes the *speech* — a captions track with the pill's
  // shorter line would be a track nobody can use with the sound off.
  const vtt = await readFile(path.join(out, 'video', '01-main.vtt'), 'utf8');
  assert.match(vtt, /fixture-narration · 5 cue\(s\)/);
  assert.match(vtt, /Type the operator's email address, then continue\./);
  assert.doesNotMatch(vtt, /^Type the email\.$/m, 'the pill keeps the caption; the .vtt follows the voice');

  // The claim, from the file a player reads: every cue is at least as long as
  // the line plus its tail (1.5 s + 0.4 s), give or take a frame of jitter.
  // Longer is allowed — a step that types a value spends time doing it — so the
  // upper bound belongs to the *shared* cue alone, whose two steps have nothing
  // to do but wait: if the second one repeated the line's beat, that cue would
  // sit in dead air for a sentence nobody is saying.
  const windows = [...vtt.matchAll(/(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> (\d\d):(\d\d):(\d\d)\.(\d\d\d)/g)].map((m) => {
    const ms = (h, m2, s, f) => Number(h) * 3_600_000 + Number(m2) * 60_000 + Number(s) * 1_000 + Number(f);
    return ms(m[5], m[6], m[7], m[8]) - ms(m[1], m[2], m[3], m[4]);
  });
  assert.equal(windows.length, 5, 'a caption repeated across steps is one cue');
  for (const window of windows) assert.ok(window >= 1_800, `a cue held ${window}ms of a 1.9s line`);
  assert.ok(windows[4] <= 2_600, `the shared cue held ${windows[4]}ms of a 1.9s line — dead air after the voice`);
  assert.equal(
    vtt.match(/Choose a target next, then deploy\./g).length,
    1,
    'the shared line is written once, so it cannot blink between the two steps',
  );

  // And the run is marked as narrated where a reviewer looks.
  const timeline = JSON.parse(await readFile(path.join(out, '.timeline.json'), 'utf8'));
  assert.equal(timeline.videos[0].narrated, true);
  assert.match(await readFile(path.join(out, 'review.html'), 'utf8'), /· narrated/);
});

/**
 * `fit: "line"` at the runner, not just in the arithmetic.
 *
 * The unit tests can say what a beat *should* be; only a run shows whether the
 * step actually waited for the hold it was told to drop. The same plan is recorded
 * twice with every step asking for a 6 s hold: the default `hold` gives each step
 * `max(6 s, line)`, and `line` gives it only the rest of its own 1.5 s sentence.
 * The difference is measured on the windows in the `.vtt` the two runs wrote.
 *
 * The third step repeats the second one's line on the same tab. That is one cue,
 * not two — a narrated run transcribes the speech, and consecutive steps saying
 * the same thing must not blink — so the only place the repeated step's `hold`
 * can show is the length of the merged cue, which is how this asserts it.
 */
test('fit: "line" drops the step hold that fit: "hold" keeps', async (t) => {
  const ffmpeg = await findMuxFfmpeg();
  if (!ffmpeg) return t.skip('narration needs a system ffmpeg with libopus');
  if (!(await probeOpus({ ffmpeg }))) return t.skip('the system ffmpeg has no libopus encoder');

  const bin = await stubSay(tmp, ffmpeg);
  const HOLD_MS = 6_000;

  const planFor = (fit) => ({
    tutorial: 'fixture-narration-fit',
    baseUrl: '${FIXTURE_URL}',
    locale: 'en-US',
    viewport: { width: 900, height: 700 },
    colorScheme: 'dark',
    // Pinned so the two runs walk the same path: the comparison is between the
    // plans' `fit`, and nothing else may differ.
    humanize: { seed: 'fixture-narration-fit-v1', shotHoldMs: 300 },
    video: { narration: { fit } },
    vars: { password: { env: 'FIXTURE_PASSWORD' } },
    steps: [
      {
        name: 'open the app',
        caption: 'Open the app.',
        say: 'Open the app on its welcome screen.',
        goto: '/',
        hold: HOLD_MS,
      },
      {
        name: 'read the title',
        caption: 'Read the title.',
        say: 'The welcome screen is already showing.',
        waitFor: { text: 'Welcome back' },
        hold: HOLD_MS,
      },
      {
        // The same line again on the same tab — one cue's worth of audio, already
        // spoken, so this step owes the voice nothing. It still owes *itself* the
        // hold it asked for, and that is the shape that used to lose it: a `0` beat
        // is indistinguishable from "the copy asked for no time".
        name: 'read the title again',
        caption: 'The same title, still there.',
        say: 'The welcome screen is already showing.',
        waitFor: { text: 'Welcome back' },
        hold: HOLD_MS,
      },
    ],
  });

  const record = async (fit) => {
    const planPath = path.join(tmp, `narration-fit-${fit}.plan.json`);
    await writeFile(planPath, JSON.stringify(planFor(fit), null, 2));
    const out = path.join(tmp, `narration-fit-${fit}`);
    const res = await run([planPath, '--out', out, '--video', '--narration', '--rate', '200'], {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      UI_PATH_RECORDER_CACHE_DIR: path.join(tmp, 'narration-cache-fit'),
    });
    assert.equal(res.code, 0, `exit ${res.code} under fit: ${fit}\n${res.stderr}`);
    const probe = JSON.parse(
      (
        await runCommand(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'json',
          path.join(out, 'video', '01-main.webm'),
        ])
      ).stdout,
    );
    const vtt = await readFile(path.join(out, 'video', '01-main.vtt'), 'utf8');
    const windows = [...vtt.matchAll(/(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> (\d\d):(\d\d):(\d\d)\.(\d\d\d)/g)].map((match) => {
      const ms = (h, m, s, f) => Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1_000 + Number(f);
      return ms(match[5], match[6], match[7], match[8]) - ms(match[1], match[2], match[3], match[4]);
    });
    return { ms: Math.round(Number(probe.format.duration) * 1000), windows };
  };

  const held = await record('hold');
  const fitLine = await record('line');

  // Steps 1 and 2 hold 6 s rather than 1.9 s, and step 3 holds in both modes
  // because it has no line to fit: about 8.2 s less under `line`. The bounds are
  // wide because a frame of encode rounding is not the claim.
  const saved = held.ms - fitLine.ms;
  assert.ok(saved > 6_000, `fit: "line" saved ${saved}ms — the hold was still applied`);
  assert.ok(saved < 10_000, `fit: "line" saved ${saved}ms — more than the hold it dropped`);
  // Step 3 repeats step 2's line, so those two steps are one cue.
  assert.equal(fitLine.windows.length, 2, 'three steps, two distinct lines — two cues');

  // The whole point: `line` paces step 1 by its 1.5 s sentence, so its cue is
  // short; the merged cue covers step 2 *and* step 3, and step 3 has no line of
  // its own, so it keeps its 6 s hold — which a `0` beat used to take away. Both
  // modes keep every hold, which is what `hold` means.
  assert.ok(fitLine.windows[0] < 3_000, `step 1 kept ${fitLine.windows[0]}ms under fit: "line"`);
  assert.ok(
    fitLine.windows[1] > 5_000,
    `the repeated line's step kept only ${fitLine.windows[1]}ms of its 6 s hold under fit: "line"`,
  );
  for (const window of held.windows) assert.ok(window > 5_000, `fit: "hold" kept ${window}ms of the 6 s hold`);
});

/**
 * A plan that narrates is still a plan you can run for figures.
 *
 * `video.intro`/`video.outro` are ignored without `--video` for the same reason:
 * they describe the recording, and a figure run has none. An explicit
 * `--narration` is a request and is refused; the plan's own block only warns.
 */
test('a figure run of a narrated plan warns and records nothing, rather than failing', async () => {
  const out = path.join(tmp, 'narrated-figures');
  const res = await run([PLAN('fixture-narration.plan.json'), '--out', out, '--speed', '20']);
  assert.equal(res.code, 0, `exit ${res.code}\n${res.stderr}`);
  assert.match(res.stderr, /the plan asks for narration, but this run is not recording it/);
  assert.match(res.stderr, /pass --video to include the voice, or --no-narration to silence the plan/);
  assert.doesNotMatch(res.stdout, /narration:/, 'nothing was synthesized for a run with no recording');
  assert.equal(existsSync(path.join(out, 'video')), false, 'a figure run writes no track');

  // The flag is the difference: asked for explicitly, it stops before a browser
  // opens instead of silently dropping the voice.
  const refused = await run([PLAN('fixture-narration.plan.json'), '--out', path.join(tmp, 'narrated-refused'), '--narration']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /--narration needs --video/);
  assert.equal(existsSync(path.join(tmp, 'narrated-refused')), false);
});

test('--no-narration records a silent copy whose subtitles are the caption', async (t) => {
  // The same plan, recorded without a voice: the `.vtt` must transcribe what is
  // on screen, not a `say` nobody hears. Speed 20 keeps it cheap — narration is
  // off, so there is no beat to scale.
  const out = path.join(tmp, 'silent-copy');
  const res = await run([PLAN('fixture-narration.plan.json'), '--out', out, '--video', '--no-narration', '--speed', '20']);
  if (res.code !== 0 && FFMPEG_HINT.test(res.stderr)) return t.skip('Playwright ffmpeg is not installed here');
  assert.equal(res.code, 0, `exit ${res.code}\n${res.stderr}`);
  assert.doesNotMatch(res.stdout, /narration:/, 'nothing was spoken');

  const vtt = await readFile(path.join(out, 'video', '01-main.vtt'), 'utf8');
  assert.match(vtt, /^Type the email\.$/m);
  assert.doesNotMatch(vtt, /Type the operator's email address/, 'the silent copy has no voice to transcribe');

  // And the file really is silent: the mux never ran, so there is no audio stream.
  const ffmpeg = await findMuxFfmpeg();
  if (ffmpeg) {
    const probe = JSON.parse(
      (
        await runCommand(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), [
          '-v', 'error',
          '-show_entries', 'stream=codec_type',
          '-of', 'json',
          path.join(out, 'video', '01-main.webm'),
        ])
      ).stdout,
    );
    assert.equal(
      probe.streams.some((stream) => stream.codec_type === 'audio'),
      false,
      'a --no-narration recording has no voice track',
    );
  }
  const timeline = JSON.parse(await readFile(path.join(out, '.timeline.json'), 'utf8'));
  assert.notEqual(timeline.videos[0].narrated, true);
});

/**
 * Narration across a `clickNewPage` boundary.
 *
 * Cues merge per *recording* — there is one `.vtt` per tab — so a line repeated
 * on the second tab is a separate cue that has to wait for its own audio. A memo
 * keyed on the line alone ("already spoke this") gives it no beat at all, so the
 * cue is only as long as the step was: the shortest cue a reader can follow
 * (`MIN_CUE_MS`, 1.2 s) instead of the 1.9 s the line needs. The subtitle falls
 * away before the sentence does, and the run warns that the line runs past its
 * step. The memo is per tab for exactly this case, and this plan measures it.
 */
test('a line repeated on a second tab is paced again, not treated as already spoken', async (t) => {
  const ffmpeg = await findMuxFfmpeg();
  if (!ffmpeg) return t.skip('narration needs a system ffmpeg with libopus');
  if (!(await probeOpus({ ffmpeg }))) return t.skip('the system ffmpeg has no libopus encoder');

  const bin = await stubSay(tmp, ffmpeg);
  const out = path.join(tmp, 'narrated-tabs');
  const res = await run([PLAN('fixture-narration-tabs.plan.json'), '--out', out, '--video', '--narration', '--rate', '200'], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    UI_PATH_RECORDER_CACHE_DIR: path.join(tmp, 'narration-cache-tabs'),
  });
  assert.equal(res.code, 0, `exit ${res.code}\n${res.stderr}`);
  // `console.warn` writes to stderr, so both streams are read: a warning that
  // lands in the stream nobody checks is a warning nobody sees. The overrun
  // warning is the one this plan can produce — each recording has a single cue,
  // so `placeCues` has nothing to overlap.
  for (const stream of [res.stdout, res.stderr]) {
    assert.doesNotMatch(stream, /past its step/, 'the second tab waits for its own line');
  }

  // One recording per tab, each with its own subtitle file.
  assert.deepEqual(
    (await readdir(path.join(out, 'video'))).sort(),
    ['01-main.vtt', '01-main.webm', '02-tab-2.vtt', '02-tab-2.webm'],
  );

  const windowsIn = (vtt) =>
    [...vtt.matchAll(/(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> (\d\d):(\d\d):(\d\d)\.(\d\d\d)/g)].map((m) => {
      const ms = (h, m2, s, f) => Number(h) * 3_600_000 + Number(m2) * 60_000 + Number(s) * 1_000 + Number(f);
      return ms(m[5], m[6], m[7], m[8]) - ms(m[1], m[2], m[3], m[4]);
    });

  // The first tab's three steps share the line, so it is one cue spoken once and
  // paced once — the merged-cue rule, unchanged.
  const main = windowsIn(await readFile(path.join(out, 'video', '01-main.vtt'), 'utf8'));
  assert.equal(main.length, 1, 'the three first-tab steps share one cue');

  // The second tab repeats the same words, but in its own file and its own cue:
  // it has to wait for its own audio, or the sentence is cut off mid-word.
  const tab = windowsIn(await readFile(path.join(out, 'video', '02-tab-2.vtt'), 'utf8'));
  assert.ok(tab.length >= 1, 'the second tab subtitled its own steps');
  assert.ok(tab[0] >= 1_800, `the repeated line held ${tab[0]}ms on the second tab, not a beat`);
  assert.ok(tab[0] <= 2_600, `the repeated line held ${tab[0]}ms — dead air after the voice`);

  const timeline = JSON.parse(await readFile(path.join(out, '.timeline.json'), 'utf8'));
  assert.equal(timeline.videos.length, 2, 'the new tab is a second recording');
  assert.ok(timeline.videos.every((video) => video.narrated === true), 'both files carry the voice');
});

/**
 * A stand-in for the ElevenLabs API, for the end-to-end test.
 *
 * Answers every synthesis with raw PCM (`output_format=pcm_48000`) of a length
 * the test knows, and keeps the requests so the flag can be followed from the
 * command line to the body that was sent.
 */
async function stubElevenLabs({ ms = 1_500 } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ url: request.url, headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'audio/pcm' });
      response.end(Buffer.alloc(Math.round((ms / 1_000) * 48_000) * 2));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * The same pipeline with the other engine.
 *
 * The engine is a choice, not an environment sniff: this plan carries no
 * `video.narration.engine`, so `--narration-engine elevenlabs` is what makes the
 * run speak through the API — and `--narration-model` has to reach the body, not
 * just the log line. No `say` is involved at any point, which is the property a
 * Linux host and CI depend on.
 */
test('--narration-engine elevenlabs speaks, paces and muxes through the API', async (t) => {
  const ffmpeg = await findMuxFfmpeg();
  if (!ffmpeg) return t.skip('narration needs a system ffmpeg with libopus');
  if (!(await probeOpus({ ffmpeg }))) return t.skip('the system ffmpeg has no libopus encoder');

  const api = await stubElevenLabs({ ms: 1_500 });
  t.after(() => api.close());

  const out = path.join(tmp, 'narrated-elevenlabs');
  const res = await run(
    [
      PLAN('fixture-narration.plan.json'),
      '--out', out,
      '--video',
      '--narration',
      '--narration-engine', 'elevenlabs',
      '--narration-model', 'eleven_turbo_v2_5',
      '--voice', 'pNInz6obpgDQGcFmaJgB',
    ],
    {
      ELEVENLABS_API_KEY: 'test-key',
      ELEVENLABS_API_URL: api.url,
      UI_PATH_RECORDER_CACHE_DIR: path.join(tmp, 'narration-cache-elevenlabs'),
    },
  );
  assert.equal(res.code, 0, `exit ${res.code}\n${res.stderr}`);
  assert.match(
    res.stdout,
    /narration: 5 lines, engine elevenlabs \(eleven_turbo_v2_5\), voice pNInz6obpgDQGcFmaJgB @ 180 wpm \(speed 1\)/,
  );
  for (const stream of [res.stdout, res.stderr]) {
    assert.doesNotMatch(stream, /past its step/, 'a step must still wait for its line');
  }

  // Five distinct lines, one request each, all at the format the reader expects
  // and with the model the flag named.
  assert.equal(api.requests.length, 5);
  for (const request of api.requests) {
    assert.match(request.url, /^\/v1\/text-to-speech\/pNInz6obpgDQGcFmaJgB\?output_format=pcm_48000$/);
    assert.equal(request.headers['xi-api-key'], 'test-key');
    assert.equal(JSON.parse(request.body).model_id, 'eleven_turbo_v2_5');
    assert.equal(JSON.parse(request.body).voice_settings.speed, 1);
  }

  // The same artefacts as a `say` run: the voice is a track in the file, the
  // picture is copied, and the subtitles transcribe the speech.
  const probe = JSON.parse(
    (
      await runCommand(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name',
        '-of', 'json',
        path.join(out, 'video', '01-main.webm'),
      ])
    ).stdout,
  );
  const kinds = probe.streams.map((stream) => `${stream.codec_type}:${stream.codec_name}`);
  assert.ok(kinds.includes('audio:opus'), `the recording carries the voice (${kinds.join(', ')})`);
  assert.ok(kinds.includes('video:vp9'), `the picture was copied (${kinds.join(', ')})`);

  const vtt = await readFile(path.join(out, 'video', '01-main.vtt'), 'utf8');
  assert.match(vtt, /fixture-narration · 5 cue\(s\)/);
  assert.match(vtt, /Type the operator's email address, then continue\./);

  const timeline = JSON.parse(await readFile(path.join(out, '.timeline.json'), 'utf8'));
  assert.equal(timeline.videos[0].narrated, true);
});

test('--narration-engine refuses a name that is not an engine, before anything runs', async () => {
  const bad = await run([PLAN('fixture-narration.plan.json'), '--out', path.join(tmp, 'bad-engine'), '--video', '--narration', '--narration-engine', 'gpt-voice']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--narration-engine must be one of say, elevenlabs/);
  assert.equal(existsSync(path.join(tmp, 'bad-engine')), false);
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
  // A raw cut installs no overlay, so the checklist the plan describes is not in
  // the picture either — said once, not discovered in the finished file.
  assert.match(res.stderr, /4 step\(s\) carry a check; --no-humanize draws no checklist/);
  // The cards survive it, because they are page content rather than an overlay
  // drawing: the raw cut opens on the title and still ends on the recap.
  assert.match(res.stdout, /card: intro/);
  assert.match(res.stdout, /card: outro/);
  assert.deepEqual(
    timeline.steps.filter((step) => step.action === 'card').map((step) => step.name),
    ['intro', 'outro'],
  );
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
