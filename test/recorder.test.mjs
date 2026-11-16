/**
 * The recording pipeline without a browser.
 *
 * These tests exist because the artefact they protect is invisible: a video with
 * one padded frame looks like a video. The policy that decides what is encodable
 * is pure, so it is checked here rather than by watching a file.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFramePump, ffmpegArgs, jpegSize } from '../lib/recorder.mjs';

/** A JPEG header just real enough: SOI, an APP0, an SOF0, then payload and EOI. */
function jpeg(width, height, padding = 0) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  for (let component = 0; component < 3; component += 1) {
    sof[10 + component * 3] = component + 1;
    sof[11 + component * 3] = 0x11;
    sof[12 + component * 3] = 0;
  }
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(padding), Buffer.from([0xff, 0xd9])]);
}

/** Frames carry wall-clock milliseconds, so the fixture does too. */
const T0 = 1_700_000_000_000;

const frame = (width, height, at, viewport = { width, height }) => ({
  data: jpeg(width, height),
  timestamp: T0 + at,
  viewportWidth: viewport.width,
  viewportHeight: viewport.height,
});

/** A pump that records what it was asked to write, so the file is not needed. */
function recording(fps = 25, tailMs = 1_000) {
  const writes = [];
  const pump = createFramePump({ fps, tailMs, write: (data, count) => writes.push({ data, count }) });
  return { pump, writes, frames: () => writes.reduce((sum, write) => sum + write.count, 0) };
}

test('jpegSize reads the dimensions out of a frame', () => {
  assert.deepEqual(jpegSize(jpeg(1600, 900)), { width: 1600, height: 900 });
  assert.deepEqual(jpegSize(jpeg(500, 1972, 512)), { width: 500, height: 1972 });
  assert.throws(() => jpegSize(Buffer.from('not a jpeg')), /not a JPEG frame/);
  // A JPEG with no SOF is not a picture we can size, so it is an error rather
  // than a frame that silently keeps whatever size came before it.
  assert.throws(() => jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9])), /no SOF/);
});

test('a frame of another size is dropped, and the frame before it holds', () => {
  const { pump, writes } = recording();
  pump.push(frame(1600, 900, 1_000));
  pump.push(frame(1600, 900, 1_040));
  assert.equal(writes.length, 1);
  // The shape of the artefact: `page.screenshot()` leaves the surface laid out
  // for a phone for exactly one frame.
  pump.push(frame(500, 1972, 1_080));
  assert.equal(pump.dropped, 1, 'the odd frame is dropped');
  assert.equal(pump.frames, 3);
  assert.equal(writes.length, 1, 'nothing is written for it');

  pump.push(frame(1600, 900, 1_120));
  assert.equal(writes.length, 2);
  // 80 ms of the picture before the artefact, at 25 fps: two output frames.
  assert.equal(writes[1].count, 2);
  assert.ok(writes[1].data.equals(jpeg(1600, 900)), 'the held frame is the last good one');
  assert.equal(pump.dropped, 1, 'the good frame is not counted as dropped');
});

test('a frame laid out for another viewport is dropped even at the same size', () => {
  const { pump, writes } = recording();
  pump.push(frame(1600, 900, 0, { width: 1600, height: 900 }));
  pump.push(frame(1600, 900, 40, { width: 1600, height: 900 }));
  const before = writes.length;
  // Same JPEG dimensions, but the page was laid out for a 500-px-wide surface:
  // this is the second shape the artefact takes.
  pump.push(frame(1600, 900, 80, { width: 500, height: 1972 }));
  assert.equal(pump.dropped, 1);
  assert.equal(writes.length, before);
});

test('a frame is written once per output period it was on screen', () => {
  const { pump, writes, frames } = recording(25); // 40 ms per output frame
  pump.push(frame(1600, 900, 0));
  pump.push(frame(1600, 900, 200));
  pump.push(frame(1600, 900, 600));
  pump.finish(T0 + 620);
  assert.deepEqual(
    writes.map((write) => write.count),
    [5, 10, 25],
    'a 200 ms still is five frames, a 400 ms one is ten, and the tail is a second',
  );
  assert.equal(frames(), 40);
});

test('a screencast that outruns the frame rate is resampled, not stretched', () => {
  // A humanized pointer redraws far faster than 25 fps; writing every frame once
  // would make a 4-second recording into 10.
  const { pump, frames } = recording(25);
  const total = 4_000;
  for (let at = 0; at <= total; at += 16) pump.push(frame(1600, 900, at));
  const written = frames();
  assert.ok(Math.abs(written - total / 40) <= 2, `wrote ${written} frames for ${total} ms, expected about 100`);
});

test('a recording that begins during a figure adopts the shape it settles on', () => {
  const { pump } = recording();
  pump.push(frame(500, 1972, 0)); // the one frame nobody should see
  pump.push(frame(1600, 900, 40));
  pump.push(frame(1600, 900, 80));
  pump.push(frame(1600, 900, 120));
  assert.deepEqual(pump.shape.size, { width: 1600, height: 900 });
  pump.push(frame(1600, 900, 160));
  assert.equal(pump.dropped, 0, 'once adopted, the settled shape is simply the recording');
});

test('an idle page is not truncated: the tail covers the time that passed', () => {
  const { pump, writes } = recording(25, 1_000);
  pump.push(frame(1600, 900, 0));
  // Ten seconds pass with no repaint, then the page closes.
  pump.finish(T0 + 10_000);
  assert.equal(writes.at(-1).count, 250, 'the last picture is held for the real gap, not one second of it');
});

test('finish on a page that never painted writes nothing', () => {
  const { pump, writes } = recording();
  assert.equal(pump.finish(T0 + 5_000), 0);
  assert.equal(writes.length, 0);
});

test('the encoder is fed a pipe and pad/crops to exactly the canvas', () => {
  const args = ffmpegArgs({ file: '/tmp/x.webm', size: { width: 1920, height: 1080 }, fps: 25 });
  assert.equal(args.at(-1), '/tmp/x.webm');
  assert.equal(args[args.indexOf('-f') + 1], 'image2pipe');
  assert.equal(args[args.indexOf('-vcodec') + 1], 'mjpeg');
  assert.equal(args[args.indexOf('-framerate') + 1], '25');
  assert.ok(args.includes('pad=1920:1080:0:0:gray,crop=1920:1080:0:0'), 'the pad is a backstop, and it matches the canvas');
  assert.equal(args[args.indexOf('-c:v') + 1], 'libvpx-vp9');
});
