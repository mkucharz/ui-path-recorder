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
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
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

test('--only names a figure that exists', async () => {
  const res = await run([PLAN('fixture.plan.json'), '--only', '99-nope', '--out', path.join(tmp, 'only')]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /no shot named "99-nope"/);
  // The message lists what it could have been, so a rename is a one-line fix.
  assert.match(res.stderr, /01-welcome, 02-step2, 03-echo/);
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
