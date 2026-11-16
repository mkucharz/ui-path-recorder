/**
 * The recording.
 *
 * Playwright's own `recordVideo` cannot be used here, and the reason is a single
 * frame. `page.screenshot()` — which every figure needs — transiently changes the
 * surface Chromium is screencasting, and the screencast shares one stream, so one
 * frame in a few hundred arrives with the page laid out for a different viewport
 * (a 500-px-wide phone layout, or the whole page shrunk into the corner). The
 * recorder pads such a frame with `pad=W:H:0:0:gray`, and a viewer sees a grey
 * field with a flash of the page in it.
 *
 * So the frames come to us instead. `page.screencast` hands over the JPEGs and
 * their timestamps, the pump below decides what is encodable, and Playwright's
 * own ffmpeg invocation does the encoding: a frame whose size differs from the
 * recording's is a frame the page never rendered, so it is dropped and the frame
 * before it is held across the gap. The recording is then only ever made of
 * pictures the page actually painted.
 *
 * The screencast is variable rate (an idle page emits nothing) while the file is
 * constant rate, so the pump resamples: a frame is written once per output frame
 * period it was on screen, which is what ffmpeg's `-r` would have done with a
 * timestamped input.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const FFMPEG_HINT = "--video needs Playwright's ffmpeg:   npx playwright install ffmpeg";

/**
 * The dimensions in a JPEG's SOF marker. The screencast delivers JPEGs, and the
 * only question worth asking about one is how big it is: everything else is
 * opaque bytes we hand to ffmpeg.
 */
export function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('not a JPEG frame');
  let at = 2;
  while (at + 9 < buffer.length) {
    if (buffer[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = buffer[at + 1];
    // Standalone markers carry no length: SOI, TEM, and the restart markers.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = buffer.readUInt16BE(at + 2);
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) return { height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
    if (length < 2) throw new Error('malformed JPEG frame');
    at += 2 + length;
  }
  throw new Error('JPEG frame with no SOF marker');
}

/** Two shapes agree when every value both of them report agrees. */
function sameShape(a, b) {
  return (
    a.size.width === b.size.width &&
    a.size.height === b.size.height &&
    (a.viewport.width === null || b.viewport.width === null || a.viewport.width === b.viewport.width) &&
    (a.viewport.height === null || b.viewport.height === null || a.viewport.height === b.viewport.height)
  );
}

const shapeOf = ({ data, viewportWidth, viewportHeight }) => ({
  size: jpegSize(data),
  viewport: {
    width: Number.isFinite(viewportWidth) ? viewportWidth : null,
    height: Number.isFinite(viewportHeight) ? viewportHeight : null,
  },
});

/**
 * What to encode, and for how long.
 *
 * A frame is the shape of the recording unless the page told us otherwise: a
 * different JPEG size is the grey-band artefact described at the top, and a
 * different reported viewport is the same frame before Chromium scaled it. Both
 * mean the page was not the page, so the frame is dropped and the one before it
 * covers the gap.
 *
 * Pure and callback-driven, so the policy is testable without a browser.
 */
export function createFramePump({ fps, write, tailMs = 1_000 }) {
  const period = 1_000 / fps;
  let shape = null;
  let rejected = null;
  let held = null;
  let heldAt = 0;
  let owed = 0;
  let dropped = 0;
  let frames = 0;
  let written = 0;

  /** Take this picture as the one on screen, writing what it replaced. */
  const hold = (frame) => {
    const at = Number.isFinite(frame.timestamp) ? frame.timestamp : Date.now();
    if (held) {
      owed += Math.max(0, at - heldAt);
      const count = Math.round(owed / period);
      if (count > 0) {
        write(held, count);
        written += count;
        owed -= count * period;
      }
    }
    held = frame.data;
    heldAt = at;
  };

  return {
    get dropped() {
      return dropped;
    },
    get frames() {
      return frames;
    },
    get written() {
      return written;
    },
    get shape() {
      return shape;
    },
    push(frame) {
      frames += 1;
      const candidate = shapeOf(frame);
      if (!shape) {
        shape = candidate;
        hold(frame);
        return;
      }
      if (sameShape(candidate, shape)) {
        if (rejected) {
          dropped += rejected.count;
          rejected = null;
        }
        hold(frame);
        return;
      }
      // A recording that begins *during* a figure would otherwise lock onto the
      // one frame that is wrong and hold it for the whole video. Nothing has
      // been written yet, so three frames of one other shape outvote a first
      // frame that was the odd one out; nothing is lost either way, because
      // nothing had been written.
      if (written === 0) {
        if (rejected && sameShape(candidate, rejected.shape)) rejected.count += 1;
        else rejected = { shape: candidate, count: 1 };
        if (rejected.count >= 3) {
          shape = rejected.shape;
          rejected = null;
        }
        return;
      }
      dropped += 1;
    },
    /**
     * The tail. Playwright gives the last frame `max(time since it appeared, 1s)`
     * on screen, so a video does not stop on the frame after the last change;
     * this does the same, now that the file has no timestamps of its own.
     */
    finish(now = Date.now()) {
      if (!held) return 0;
      owed += Math.max(0, now - heldAt);
      const count = Math.max(1, Math.round(Math.max(owed, tailMs) / period));
      write(held, count);
      written += count;
      owed = 0;
      return count;
    },
  };
}

/**
 * Playwright's ffmpeg, wherever the browser this run will use came from.
 *
 * `recordVideo` finds it through Playwright's registry; here the browser may be
 * a system Chromium (`--browser`), whose executable path says nothing about
 * where the download lives, so the browsers directory is searched directly.
 */
export async function findFfmpeg() {
  const roots = new Set();
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.add(process.env.PLAYWRIGHT_BROWSERS_PATH);
  roots.add(path.join(os.homedir(), '.cache', 'ms-playwright'));
  let dir = path.dirname(chromium.executablePath());
  for (let up = 0; up < 6; up += 1) {
    roots.add(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const root of roots) {
    const entries = await readdir(root).catch(() => []);
    const revisions = entries.filter((name) => name.startsWith('ffmpeg-')).sort().reverse();
    for (const revision of revisions) {
      const inner = await readdir(path.join(root, revision)).catch(() => []);
      const exe = inner.find((name) => name.startsWith('ffmpeg'));
      if (!exe) continue;
      const full = path.join(root, revision, exe);
      const ok = await access(full).then(
        () => true,
        () => false,
      );
      if (ok) return full;
    }
  }
  return null;
}

/**
 * Playwright's encoder invocation, fed from an image pipe instead of a matroska
 * stream. The pad/crop is kept as a backstop: it is what makes a frame of the
 * wrong size a band rather than a crash of the whole encode, even though the
 * pump should have dropped it.
 */
export function ffmpegArgs({ file, size, fps }) {
  const { width, height } = size;
  const pixelRateScale = Math.max(1, (width * height * fps) / (800 * 450 * 25));
  const bitrate = Math.round(pixelRateScale * 1_000);
  const threads = Math.min(8, Math.ceil(pixelRateScale / 4));
  const tileColumns = Math.ceil(Math.log2(threads));
  return [
    '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0',
    '-y', '-an',
    '-r', String(fps),
    '-c:v', 'libvpx-vp9',
    '-qmin', '0', '-qmax', '50', '-crf', '8',
    '-deadline', 'realtime', '-cpu-used', '8', '-lag-in-frames', '0',
    '-b:v', `${bitrate}k`,
    '-threads', String(threads), '-tile-columns', String(tileColumns), '-row-mt', '1',
    '-vf', `pad=${width}:${height}:0:0:gray,crop=${width}:${height}:0:0`,
    '-metadata', `creation_time=${new Date().toISOString()}`,
    file,
  ];
}

/** Writes are serialized, and a full pipe is waited on rather than buffered. */
export function openEncoder(ffmpegPath, args) {
  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  const exited = new Promise((resolve) => proc.on('close', (code) => resolve(code)));
  const spawned = new Promise((resolve, reject) => {
    proc.once('spawn', resolve);
    proc.once('error', (error) => reject(Object.assign(error, { ffmpegMissing: error.code === 'ENOENT' })));
  });
  let chain = Promise.resolve();

  const once = (buffer) =>
    new Promise((resolve) => {
      if (proc.stdin.destroyed) return resolve();
      if (proc.stdin.write(buffer)) return resolve();
      const done = () => {
        proc.stdin.off('drain', done);
        proc.stdin.off('error', done);
        resolve();
      };
      proc.stdin.once('drain', done);
      proc.stdin.once('error', done);
    });

  return {
    spawned,
    write(buffer, count) {
      for (let i = 0; i < count; i += 1) chain = chain.then(() => once(buffer));
    },
    async close() {
      await chain;
      proc.stdin.end();
      const code = await exited;
      return { code, stderr };
    },
  };
}

/**
 * Records one page to `file`.
 *
 * `stop()` resolves with `{ file, dropped, frames }`, or `null` when the page
 * never painted (which is not an error, and leaves no file).
 */
export async function createRecorder({ page, file, size, fps = 25, quality = 90, tailMs = 1_000 }) {
  if (typeof page.screencast?.start !== 'function') {
    throw new Error(
      'the recorder needs `page.screencast`, which is Playwright 1.59 or newer — upgrade playwright-core',
    );
  }
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) throw Object.assign(new Error(FFMPEG_HINT), { ffmpegMissing: true });
  await mkdir(path.dirname(file), { recursive: true });

  const encoder = openEncoder(ffmpegPath, ffmpegArgs({ file, size, fps }));
  await encoder.spawned;

  const pump = createFramePump({ fps, write: (buffer, count) => encoder.write(buffer, count), tailMs });
  await page.screencast.start({ size, quality, onFrame: (frame) => pump.push(frame) });

  let stopped = null;
  return {
    file,
    get dropped() {
      return pump.dropped;
    },
    get frames() {
      return pump.frames;
    },
    stop() {
      stopped ??= (async () => {
        // Stop the capture first: `finish()` writes the picture the page ended
        // on, which is only available while the page is still open.
        await page.screencast.stop().catch(() => {});
        pump.finish();
        const { code, stderr } = await encoder.close();
        if (pump.frames === 0 || code !== 0) {
          await rm(file, { force: true });
          if (code !== 0 && stderr.trim()) {
            throw new Error(`ffmpeg failed (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
          }
          return null;
        }
        return { file, dropped: pump.dropped, frames: pump.frames };
      })();
      return stopped;
    },
  };
}
