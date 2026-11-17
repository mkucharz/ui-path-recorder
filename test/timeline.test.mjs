/**
 * The timeline, without a browser.
 *
 * A video's defect is invisible in a still, so the spine that makes it reviewable
 * is worth testing on its own: a chapter that seeks to the wrong second, or into
 * the wrong tab's recording, sends a reviewer to a screen the step never showed
 * and looks like a broken video.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { actionOf, createTimeline } from '../lib/timeline.mjs';

const options = (over = {}) => ({
  plan: { tutorial: 'demo' },
  planPath: '/tmp/plans/demo.plan.json',
  seed: 'unit',
  speed: 1,
  humanized: true,
  viewport: { width: 900, height: 700 },
  fps: 25,
  startedAt: 1_000_000,
  ...over,
});

test('the first action key names what a step is', () => {
  assert.equal(actionOf({ name: 'x', click: '#a' }), 'click');
  assert.equal(actionOf({ when: { text: 'y' }, expect: 'z', shot: '01' }), 'expect');
  assert.equal(actionOf({ hold: 200 }), 'hold');
  assert.equal(actionOf({ name: 'nothing' }), 'none');
});

test('opening a step closes the one before it, and drains the delay it scheduled', () => {
  let planned = 0;
  const timeline = createTimeline(options({ planned: () => {
    const value = planned;
    planned = 0;
    return value;
  } }));

  const first = timeline.begin({ index: 1, name: 'one', action: 'click' });
  first.shot('01-one');
  // What step one scheduled while it ran. The delay is drained when the step is
  // *closed*, which is why it is banked here rather than before the begin.
  planned = 120;
  timeline.begin({ index: 2, name: 'two', action: 'fill' });
  planned = 80;
  timeline.close();

  const [stepOne, stepTwo] = timeline.toJSON().steps;
  assert.equal(stepOne.shot.id, '01-one');
  assert.equal(stepOne.plannedMs, 120, 'the delay recorded for a step is the one it scheduled');
  assert.equal(stepTwo.plannedMs, 80, 'and the next step keeps its own');
  assert.ok(stepOne.endMs !== null && stepOne.endMs >= stepOne.startMs);
  assert.ok(stepTwo.endMs !== null, 'close() closes the open step');
});

test('chapters are the named steps that ran, with the tab they ran in', () => {
  const timeline = createTimeline(options({ startedAt: Date.now() - 50 }));
  timeline.begin({ index: 1, name: 'open', action: 'goto' }).page(1);
  const skipped = timeline.begin({ index: 2, name: 'consent', action: 'click' });
  skipped.page(1);
  skipped.skip('when:url');
  timeline.begin({ index: 3, name: null, action: 'setVar' }).page(1);
  timeline.begin({ index: 4, name: 'in the new tab', action: 'expect' }).page(2);
  timeline.close();

  const chapters = timeline.chapters();
  assert.deepEqual(
    chapters.map((c) => c.name),
    ['open', 'in the new tab'],
    'an unnamed step is not a chapter and a skipped one never happened',
  );
  assert.equal(chapters.at(-1).page, 2, 'a chapter seeks into the recording of its own tab');
  for (let i = 1; i < chapters.length; i += 1) assert.ok(chapters[i].atMs >= chapters[i - 1].atMs);
});

test("a chapter in the second tab is timed from that tab's own recording", () => {
  const startedAt = Date.now() - 5_000;
  const pages = new Map([
    [1, startedAt - 400], // recording 1 began before the run did
    [2, startedAt + 4_000], // the second tab opened four seconds in
  ]);
  const timeline = createTimeline(
    options({ startedAt, videoStartedAt: pages.get(1), pageStartedAt: (page) => pages.get(page) ?? null }),
  );
  timeline.begin({ index: 1, name: 'open', action: 'goto' }).page(1);
  timeline.begin({ index: 2, name: 'in the new tab', action: 'click' }).page(2);
  timeline.close();

  const json = timeline.toJSON();
  const [main, second] = timeline.chapters();
  const secondStep = json.steps.find((step) => step.page === 2);

  // Page one adds the recorder's head start; page two subtracts its own, because
  // each tab is written as its own file starting when the tab opened. Without
  // that, a chapter for tab two seeks seconds into a file that is that long.
  assert.equal(main.atMs, Math.max(0, json.steps[0].startMs + 400));
  assert.equal(second.atMs, Math.max(0, secondStep.startMs - 4_000));
  assert.ok(second.atMs < secondStep.startMs, 'tab two is timed from its own zero point');
  assert.equal(json.videos.length, 0);
  timeline.setVideos([
    { file: 'video/01-main.webm', page: 1 },
    { file: 'video/02-tab-2.webm', page: 2 },
  ]);
  assert.deepEqual(
    timeline.toJSON().videos.map((video) => video.recordingStartMs),
    [-400, 4_000],
    'each recording declares where it starts, so the file explains its own chapter times',
  );
});

test('checks are the ticked items, once each, timed like a chapter', () => {
  const startedAt = Date.now() - 50;
  const timeline = createTimeline(options({ startedAt }));
  timeline.begin({ index: 1, action: 'goto', check: 'Open the installer' }).page(1);
  // A step may re-tick an item — the panel keeps one row, so the sheet must too,
  // and the first occurrence is the moment the row was ticked.
  timeline.begin({ index: 2, action: 'click', check: 'Open the installer' }).page(1);
  const skipped = timeline.begin({ index: 3, action: 'click', check: 'Never happened' });
  skipped.skip('when:text');
  timeline.begin({ index: 4, action: 'click', check: 'Sign in' }).page(1);
  timeline.begin({ index: 5, action: 'click' }).page(1);
  timeline.close();

  const checks = timeline.checks();
  assert.deepEqual(
    checks.map((check) => check.item),
    ['Open the installer', 'Sign in'],
    'a repeated item is one row and a skipped step never ticked',
  );
  const [first, second] = checks;
  assert.ok(first.atMs <= second.atMs, 'the rows are in the order they tick');
  const steps = timeline.toJSON().steps;
  assert.equal(first.atMs, Math.max(0, steps[0].startMs - timeline.toJSON().videoOffsetMs));
  assert.equal(timeline.checks().at(-1).page, 1);
});

test('chapter times are relative to the start of the recording, not of the run', () => {
  const startedAt = Date.now();
  // The recorder started 1.5 s before the plan did.
  const timeline = createTimeline(options({ startedAt, videoStartedAt: startedAt - 1_500 }));
  const step = timeline.begin({ index: 1, name: 'after launch', action: 'goto' });
  step.page(1);
  timeline.close();

  const json = timeline.toJSON();
  assert.equal(json.videoOffsetMs, 1_500);
  // Seeking to the step's own time would land a second and a half early.
  const chapter = timeline.chapters()[0];
  assert.ok(chapter.atMs >= 1_500 && chapter.atMs < 1_500 + 1_000, `chapter at ${chapter.atMs}ms`);
});

test('the file it writes is the object it reported', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'timeline-'));
  try {
    const timeline = createTimeline(options({ startedAt: Date.now() - 20 }));
    const step = timeline.begin({ index: 1, name: 'one', action: 'goto' });
    step.shot('01-one');
    timeline.close();
    timeline.setVideos([{ file: 'video/01-main.webm', page: 1 }]);

    const file = await timeline.write(dir);
    assert.equal(path.basename(file), '.timeline.json');
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(onDisk, timeline.toJSON());
    assert.equal(onDisk.humanized, true);
    assert.equal(onDisk.plan, 'demo.plan.json');
    assert.equal(onDisk.videos[0].file, 'video/01-main.webm');
    assert.equal(onDisk.steps[0].shot.cursorHidden, true, 'a humanized run hides the pointer for a figure');
    assert.ok(onDisk.durationMs > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
