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
import { startFixtureServer } from './serve.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'path-shots.mjs');
const PLAN = (name) => path.join(ROOT, 'test', 'plans', name);

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
function run(args) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd: tmp,
        env: { ...process.env, FIXTURE_URL: base(), FIXTURE_PASSWORD: 'correct-horse-battery' },
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr, ms: Date.now() - started }),
    );
  });
}

/** PNG dimensions straight off IHDR: no dependency needed. */
function pngSize(file) {
  return readFile(file).then((b) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) }));
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
    PLAN('fixture-stale.plan.json'),
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

  // One deterministic file per page, named for the review sheet.
  const videos = await readdir(path.join(out, 'video'));
  assert.deepEqual(videos, ['01-main.webm']);
  assert.ok((await stat(path.join(out, 'video', '01-main.webm'))).size > 10_000, 'the recording is not empty');

  // The timeline is what makes the video reviewable: chapters with times, and a
  // record that the pointer was hidden for every figure.
  const timeline = JSON.parse(await readFile(path.join(out, '.timeline.json'), 'utf8'));
  assert.equal(timeline.humanized, true);
  assert.equal(timeline.seed, 'fixture-video-v1');
  assert.equal(timeline.fps, 25);
  assert.equal(timeline.videos[0].file, 'video/01-main.webm');
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

  const review = await readFile(path.join(out, 'review.html'), 'utf8');
  assert.match(review, /<video/);
  assert.match(review, /video\/01-main\.webm/);
  assert.match(review, /#t=\d/);
  assert.match(review, /seed fixture-video-v1/);

  // The figures are unchanged by any of it.
  assert.equal((await pngSize(shotFile('video', '01-welcome'))).width, 784);
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
