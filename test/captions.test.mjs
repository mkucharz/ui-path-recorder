/**
 * Subtitles, without a browser.
 *
 * A caption is two artefacts from one string: a pill drawn into the recording
 * and a `.vtt` beside it. Both are timed by the timeline, and the failure that
 * matters is invisible in either file alone — a cue that starts a second early
 * reads as a subtitle describing the wrong screen, and one that overlaps its
 * neighbour shows two sentences at once. So the cue builder and the writer are
 * checked here against a hand-written timeline, and the end-to-end proof (a
 * caption in the picture, a `.vtt` on disk, figures unchanged) is in
 * fixture.test.mjs because it needs a real browser.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVtt, cuesForRecording, formatTimestamp, MAX_CAPTION_CHARS, MIN_CUE_MS, vttFor } from '../lib/captions.mjs';
import { validate } from '../lib/plan.mjs';

/** A run of steps on one tab, timed from the run's start. */
const timeline = (steps, over = {}) => ({
  tutorial: 'demo',
  seed: 'unit',
  steps,
  videos: [{ file: 'video/01-main.webm', page: 1, recordingStartMs: 0 }],
  ...over,
});

test('a timestamp is always HH:MM:SS.mmm, which every player parses', () => {
  assert.equal(formatTimestamp(0), '00:00:00.000');
  assert.equal(formatTimestamp(1_234), '00:00:01.234');
  assert.equal(formatTimestamp(61_500), '00:01:01.500');
  assert.equal(formatTimestamp(3_723_004), '01:02:03.004');
  // Rounded to the millisecond, and never negative: a cue cannot start before
  // the file it is written for.
  assert.equal(formatTimestamp(999.6), '00:00:01.000');
  assert.equal(formatTimestamp(-500), '00:00:00.000');
  assert.equal(formatTimestamp(Number.NaN), '00:00:00.000');
});

test('the captions file is the recording file beside it', () => {
  assert.equal(vttFor('video/01-main.webm'), 'video/01-main.vtt');
  assert.equal(vttFor('02-tab-2.webm'), '02-tab-2.vtt');
});

test('a cue starts and ends with its step', () => {
  const cues = cuesForRecording(
    timeline([
      { index: 1, page: 1, startMs: 0, endMs: 900, caption: 'Open the sign-in page.' },
      { index: 2, page: 1, startMs: 900, endMs: 2_400, caption: 'Type the email address.' },
    ]),
    { page: 1, recordingStartMs: 0 },
  );
  assert.deepEqual(cues, [
    { startMs: 0, endMs: 900, text: 'Open the sign-in page.' },
    { startMs: 900, endMs: 2_400, text: 'Type the email address.' },
  ]);
});

test('steps without a caption, and steps that were skipped, say nothing', () => {
  const cues = cuesForRecording(
    timeline([
      { index: 1, page: 1, startMs: 0, endMs: 500, caption: 'One.' },
      { index: 2, page: 1, startMs: 500, endMs: 1_200, caption: null },
      { index: 3, page: 1, startMs: 1_200, endMs: 1_400, caption: 'never ran', skipped: true },
      { index: 4, page: 1, startMs: 1_400, endMs: 2_000, caption: '   ' },
      { index: 5, page: 1, startMs: 2_000, endMs: 3_000, caption: 'Five.' },
    ]),
    { page: 1 },
  );
  assert.deepEqual(
    cues.map((cue) => cue.text),
    ['One.', 'Five.'],
    'a cleared caption must not survive the step that cleared it',
  );
  // A cleared step is a gap, not a reason to stretch the cue before it: the
  // overlay stops drawing at the step boundary, so the file has to stop too.
  assert.equal(cues[0].endMs, 500);
});

test('a caption repeated across steps is one cue, not a blink', () => {
  const cues = cuesForRecording(
    timeline([
      { index: 1, page: 1, startMs: 0, endMs: 1_000, caption: 'Same words.' },
      { index: 2, page: 1, startMs: 1_000, endMs: 2_000, caption: 'Same words.' },
      { index: 3, page: 1, startMs: 2_000, endMs: 3_600, caption: 'Other.' },
    ]),
    { page: 1 },
  );
  assert.deepEqual(cues, [
    { startMs: 0, endMs: 2_000, text: 'Same words.' },
    { startMs: 2_000, endMs: 3_600, text: 'Other.' },
  ]);
});

test('a short step is extended far enough to read, but never over the next one', () => {
  const cues = cuesForRecording(
    timeline([
      { index: 1, page: 1, startMs: 0, endMs: 120, caption: 'A click that swaps the screen.' },
      { index: 2, page: 1, startMs: 400, endMs: 3_000, caption: 'The screen it swapped to.' },
    ]),
    { page: 1 },
  );
  assert.ok(cues[0].endMs - cues[0].startMs >= 300, 'the unreadable cue was lengthened');
  assert.ok(cues[0].endMs <= cues[1].startMs, 'and it stops before the next subtitle starts');
  assert.equal(cues[0].endMs, 400, 'it fills the gap rather than leaving the screen silent');
  assert.equal(cues[1].startMs, 400);

  // With no cue after it, the floor applies directly.
  const last = cuesForRecording(
    timeline([{ index: 1, page: 1, startMs: 5_000, endMs: 5_050, caption: 'The last one.' }]),
    { page: 1 },
  );
  assert.equal(last[0].endMs - last[0].startMs, MIN_CUE_MS);
});

test('cue times are relative to the recording, not to the run', () => {
  // A second tab is written as its own file, starting when the tab opened. A
  // cue timed from the run's zero would land seconds into a two-second file.
  const cues = cuesForRecording(
    timeline(
      [
        { index: 1, page: 1, startMs: 0, endMs: 1_000, caption: 'In the first tab.' },
        { index: 2, page: 2, startMs: 5_000, endMs: 6_000, caption: 'In the second tab.' },
      ],
      { videos: [{ file: 'video/02-tab-2.webm', page: 2, recordingStartMs: 4_500 }] },
    ),
    { page: 2, recordingStartMs: 4_500 },
    { minMs: 0 },
  );
  assert.deepEqual(cues, [{ startMs: 500, endMs: 1_500, text: 'In the second tab.' }]);

  // The writer holds the raw file list, not the timeline's computed videos, so
  // the offset is also looked up by file name — a cue must not depend on which of
  // the two objects the caller happened to pass.
  const byFile = cuesForRecording(
    timeline(
      [{ index: 1, page: 2, startMs: 5_000, endMs: 6_000, caption: 'In the second tab.' }],
      { videos: [{ file: 'video/02-tab-2.webm', page: 2, recordingStartMs: 4_500 }] },
    ),
    { file: 'video/02-tab-2.webm', page: 2 },
    { minMs: 0 },
  );
  assert.deepEqual(byFile, [{ startMs: 500, endMs: 1_500, text: 'In the second tab.' }]);
});

test('cue text is one line, and cannot break the file it is written into', () => {
  const cues = cuesForRecording(
    timeline([{ index: 1, page: 1, startMs: 0, endMs: 2_000, caption: 'Tom & Jerry <b>bold</b>\nand a --> arrow' }]),
    { page: 1 },
  );
  assert.equal(cues[0].text, 'Tom &amp; Jerry &lt;b&gt;bold&lt;/b&gt; and a → arrow');
  assert.ok(!cues[0].text.includes('\n'), 'a cue is a line, not a block');
});

test('the WebVTT file starts with its header, carries the cues, and names the run', () => {
  const cues = [
    { startMs: 0, endMs: 1_500, text: 'Open the sign-in page.' },
    { startMs: 1_500, endMs: 4_250, text: 'Type the email address.' },
  ];
  const vtt = buildVtt(cues, { note: 'signin-captions · 2 cues · seed signin-captions-v1' });

  assert.ok(vtt.startsWith('WEBVTT\n\n'), 'the header is the first line, followed by a blank line');
  assert.match(vtt, /^NOTE\nsignin-captions · 2 cues · seed signin-captions-v1$/m);
  assert.equal(vtt.match(/-->/g).length, 2, 'one timing line per cue');
  assert.match(vtt, /00:00:00\.000 --> 00:00:01\.500\nOpen the sign-in page\./);
  assert.match(vtt, /00:00:01\.500 --> 00:00:04\.250\nType the email address\./);
  // Blocks are separated by one blank line, and the file ends with a newline:
  // a player reading a trailing half-cue is the kind of bug nobody reports.
  assert.ok(vtt.endsWith('Type the email address.\n'));
  assert.ok(!/\n\n\n/.test(vtt));

  // No note, no NOTE block — an empty caption list is still a valid file.
  assert.equal(buildVtt([]), 'WEBVTT\n');
});

test('the plan contract accepts a caption and refuses one that is not a subtitle', () => {
  const plan = (step) => ({ baseUrl: 'https://example.test', steps: [{ name: 'open', goto: '/' }, step] });

  assert.doesNotThrow(() => validate(plan({ caption: 'Open the sign-in page.', goto: '/' })));

  // A caption alone does nothing on the page: it is not an action.
  assert.throws(() => validate(plan({ caption: 'A step that only talks.' })), /does nothing/);
  assert.throws(() => validate(plan({ caption: '', goto: '/' })), /must be a non-empty string/);
  assert.throws(() => validate(plan({ caption: '   ', goto: '/' })), /must be a non-empty string/);
  assert.throws(() => validate(plan({ caption: 42, goto: '/' })), /must be a non-empty string/);
  assert.throws(() => validate(plan({ caption: 'two\nlines', goto: '/' })), /single line/);
  assert.throws(
    () => validate(plan({ caption: 'x'.repeat(MAX_CAPTION_CHARS + 1), goto: '/' })),
    /keep it under 160/,
  );
});
