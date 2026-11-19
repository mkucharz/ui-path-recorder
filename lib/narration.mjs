/**
 * Voice narration.
 *
 * A `caption` is text a viewer reads; narration is the same walkthrough spoken
 * aloud. The engine is macOS `say`, which needs no install, no key and no
 * network — the voice belongs to the operating system the recording host
 * already is.
 *
 * Three things make this a library rather than a flag:
 *
 *   - **Synthesis is a separate pass.** A spoken sentence is 3–7 s and a step is
 *     1–5 s, so the runner has to know how long each line takes *before* it
 *     records. Text is known from the plan, so every line is spoken before the
 *     browser opens and the pacing then rides the step's own `hold`.
 *   - **The audio is placed by cue, not by step.** A cue's window is a step (or a
 *     run of steps that share one line), which is the same object the `.vtt` is
 *     built from — so the voice and the subtitles cannot drift.
 *   - **The mux is a second pass.** Playwright's bundled ffmpeg ships video-only
 *     builds (`ffmpeg-1011` and `ffmpeg-1013` on this rig expose nothing but
 *     `png`, `libvpx` and `libvpx-vp9`), so the Opus track is added by the
 *     system ffmpeg with `-c:v copy`. A narration-off run never touches that
 *     path, and its output stays byte-identical to what it was.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** `say` is asked for this, and everything downstream assumes it. */
export const SAMPLE_RATE = 48_000;

/**
 * A spoken line, in characters. Long enough for two sentences (what a step that
 * needs explaining actually takes) and short enough that a typo cannot turn a
 * walkthrough into an audiobook.
 */
export const MAX_SAY_CHARS = 400;

/** Silence after a line, so the next screen does not appear on the last word. */
export const DEFAULT_TAIL_MS = 400;

/** `say -r`, words per minute. 180 is conversational; the tool's default is 175. */
export const DEFAULT_RATE = 180;

export class NarrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NarrationError';
  }
}

export const SAY_HINT = [
  'narration needs macOS `say`, which is not on PATH.',
  '',
  '  `say` ships with macOS, so record a narrated walkthrough on a Mac — the same',
  '  machine that already has to have a display for the browser. On Linux the',
  '  whole pipeline still runs: point PATH at a `say` that writes a 48 kHz 16-bit',
  '  mono WAV (`say -f <text> -o <out> --data-format=LEI16@48000`).',
].join('\n');

export const NARRATION_FFMPEG_HINT = [
  'narration needs a system ffmpeg with libopus: the bundled one Playwright',
  'downloads is video-only (it encodes png and vp9 and has no audio codec at all).',
  '',
  '  macOS: brew install ffmpeg      Linux: apt-get install ffmpeg',
].join('\n');

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

/**
 * What a step says out loud.
 *
 * `say` is the spoken line and defaults to `caption` — one text doing both jobs
 * is the property the README already claims for the pill and the `.vtt`, and a
 * separate default would let the voice describe a sentence nobody can read.
 * An explicit `say` overrides it: then the subtitles transcribe the speech (what
 * captions are for) while the pill keeps the short on-screen line.
 *
 * @param {any} step
 * @returns {string|null} the normalized line, or null when the step is silent
 */
export function narrationText(step) {
  const raw = typeof step?.say === 'string' && step.say.trim() ? step.say : step?.caption;
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text || null;
}

/**
 * The run's narration settings: flags win, then the plan's `video.narration`,
 * then the defaults. Presence of `video.narration` is the plan asking for
 * narration; `--no-narration` is the way out of it without editing the file.
 */
export function resolveNarration({ enabled = null, voice = null, rate = null, tailMs = null, plan = null } = {}) {
  const fromPlan = plan?.video?.narration ?? {};
  return {
    enabled: enabled ?? Boolean(plan?.video?.narration),
    voice: voice ?? fromPlan.voice ?? null,
    rate: rate ?? fromPlan.rate ?? DEFAULT_RATE,
    tailMs: tailMs ?? fromPlan.tailMs ?? DEFAULT_TAIL_MS,
  };
}

/**
 * Why narration cannot run as asked, or null.
 *
 * Both refusals are about the same thing: the voice is placed against the
 * recording's clock, and anything that stretches or removes that clock without
 * stretching the audio with it desynchronises the two. Refusing is better than
 * a video whose words lag the picture by a fifth.
 */
export function narrationRefusal({ enabled, video, humanized, speed }) {
  if (!enabled) return null;
  if (!video) {
    return '--narration needs --video: the voice is a track inside the recording, so a run with no recording has nothing to narrate';
  }
  if (!humanized) {
    return "--narration needs the humanizer, which --no-humanize turns off: the voice is paced by each step's hold, and the raw machine-speed cut has none";
  }
  if (Number(speed) !== 1) {
    return `--narration needs --speed 1 (got ${speed}): the hold is scaled by the speed but the recorded voice is not, so any other speed drifts the two apart`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Running a command
 * ------------------------------------------------------------------ */

/**
 * One process, its stdout and stderr collected, a non-zero exit as an error.
 *
 * Injected everywhere below so the whole pipeline is testable without `say`,
 * without a Mac and without recording anything.
 */
export function runCommand(command, args, { cwd = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-65_536);
    });
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
    proc.once('error', (error) => {
      reject(Object.assign(new NarrationError(`${path.basename(command)} could not be started: ${error.message}`), { command, cause: error }));
    });
    proc.once('close', (code) => {
      if (code === 0) return resolve({ code, stdout, stderr });
      reject(
        Object.assign(new NarrationError(`${path.basename(command)} exited ${code}: ${(stderr || stdout).trim() || 'no output'}`), {
          command,
          code,
          stdout,
          stderr,
        }),
      );
    });
  });
}

/** The first executable with this name on PATH, or null. */
export async function whichOnPath(name, { env = process.env } = {}) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) continue;
    const ok = await access(full, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (ok) return full;
  }
  return null;
}

/**
 * The voice engine: `say` on PATH.
 *
 * Detected by the binary rather than by `process.platform`, so a Linux host can
 * drive the real pipeline with a stub that writes the same WAV — which is how
 * the tests exercise everything except the speech itself.
 */
export function findSay({ env = process.env } = {}) {
  return whichOnPath('say', { env });
}

/** The ffmpeg that adds the track. Must be a system one: see the file header. */
export function findMuxFfmpeg({ env = process.env } = {}) {
  return whichOnPath('ffmpeg', { env });
}

/** Does this ffmpeg have the Opus encoder? Asked once, before the recording. */
export async function probeOpus({ ffmpeg, run = runCommand }) {
  const { stdout, stderr } = await run(ffmpeg, ['-hide_banner', '-encoders']);
  return /(^|\s)libopus(\s|$)/m.test(`${stdout}\n${stderr}`);
}

/* ------------------------------------------------------------------ *
 * Synthesis
 * ------------------------------------------------------------------ */

/**
 * `say`'s invocation.
 *
 * The text goes through a file (`-f`) rather than argv: a caption can carry an
 * apostrophe, a quote or a `$`, and a command line is the wrong place to find
 * that out. `--data-format=LEI16@48000` asks for the exact thing `readWav`
 * accepts, so nothing has to resample afterwards.
 */
export function sayArgs({ textFile, outFile, voice = null, rate = null }) {
  const args = ['-f', textFile, '-o', outFile, '--data-format=LEI16@48000'];
  if (voice) args.push('-v', voice);
  if (rate) args.push('-r', String(rate));
  return args;
}

/** Where spoken lines are kept between runs, so editing one step re-speaks one. */
export function defaultCacheDir(env = process.env) {
  if (env.UI_PATH_RECORDER_CACHE_DIR) return env.UI_PATH_RECORDER_CACHE_DIR;
  const home = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(home, 'ui-path-recorder', 'narration');
}

/** The cache key: same voice, same speed, same words → same audio. */
export function narrationKey({ text, voice = null, rate = null }) {
  return createHash('sha256').update(`${voice ?? ''}\u0000${rate ?? ''}\u0000${text}`).digest('hex');
}

/**
 * Speak one line and return its samples.
 *
 * The result is cached under the content hash: a re-record after a caption edit
 * re-speaks the step that changed and nothing else. The cache is deliberately
 * keyed on the words, the voice and the rate only — `say`'s audio is not
 * byte-reproducible across macOS releases, so a cached line is the *same*
 * recording rather than a promise that a fresh one would match it.
 *
 * @returns {Promise<{pcm: Buffer, ms: number, sampleRate: number, channels: number, cached: boolean}>}
 */
export async function synthesizeSay({ say, text, voice = null, rate = null, dir, run = runCommand }) {
  const key = narrationKey({ text, voice, rate });
  const wav = path.join(dir, `${key}.wav`);
  const cached = await readFile(wav).catch(() => null);
  if (cached) {
    const audio = readWav(cached);
    return { ...audio, ms: pcmMs(audio.pcm, audio.sampleRate), cached: true };
  }

  await mkdir(dir, { recursive: true });
  const textFile = path.join(dir, `${key}.txt`);
  const part = path.join(dir, `${key}.part.wav`);
  await writeFile(textFile, `${text}\n`);
  try {
    await run(say, sayArgs({ textFile, outFile: part, voice, rate }));
  } finally {
    await rm(textFile, { force: true });
  }

  const written = await readFile(part).catch(() => null);
  if (!written) {
    throw new NarrationError(`say reported success but wrote no file for ${JSON.stringify(text.slice(0, 48))}`);
  }
  let audio;
  try {
    audio = readWav(written);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  await rename(part, wav);
  return { ...audio, ms: pcmMs(audio.pcm, audio.sampleRate), cached: false };
}

/* ------------------------------------------------------------------ *
 * WAV
 * ------------------------------------------------------------------ */

/** Uncompressed 16-bit samples at 48 kHz, mono — what `say` is asked for. */
export function readWav(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new NarrationError('not a RIFF/WAVE file, so this reader cannot take its samples');
  }
  let at = 12;
  let fmt = null;
  let data = null;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('ascii', at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(buffer.length, body + size));
    }
    // Chunks are word-aligned: an odd-sized one is followed by a pad byte.
    at = body + size + (size % 2);
  }
  if (!fmt || !data) throw new NarrationError('the WAV has no fmt and data chunk');
  if (fmt.format !== 1) {
    throw new NarrationError(
      `the WAV is format ${fmt.format}, not uncompressed PCM — say ignored --data-format=LEI16@48000`,
    );
  }
  if (fmt.bitsPerSample !== 16) {
    throw new NarrationError(`the WAV is ${fmt.bitsPerSample}-bit, not 16-bit — say ignored --data-format=LEI16@48000`);
  }
  if (fmt.sampleRate !== SAMPLE_RATE) {
    throw new NarrationError(`the WAV is ${fmt.sampleRate} Hz, not ${SAMPLE_RATE} Hz — say ignored --data-format=LEI16@48000`);
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, pcm: toMono(data, fmt.channels) };
}

/** Channel zero and nothing else: a voice is one stream, and Opus carries one. */
function toMono(pcm, channels) {
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.length / (2 * channels));
  const out = Buffer.allocUnsafe(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    pcm.copy(out, frame * 2, frame * 2 * channels, frame * 2 * channels + 2);
  }
  return out;
}

/** How long these samples last. 96 bytes is one millisecond at 48 kHz mono. */
export function pcmMs(pcm, sampleRate = SAMPLE_RATE) {
  return Math.round((pcm.length / 2 / sampleRate) * 1_000);
}

/** A RIFF header around raw 16-bit mono samples. Deterministic, so it can be asserted. */
export function writeWav(pcm, { sampleRate = SAMPLE_RATE, channels = 1 } = {}) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

/**
 * One continuous track for a recording: silence everywhere, each cue's audio at
 * its own start.
 *
 * The failure this catches is two lines talking over each other. Pacing should
 * make that impossible, but a cue that merged several steps, or a step skipped
 * by `when`, can shorten a window under a line — and a voice that is cut off
 * mid-word is the kind of thing a reviewer hears and cannot find.
 *
 * @param {Array<{startMs: number, endMs?: number, pcm: Buffer}>} cues
 * @param {{sampleRate?: number, label?: string}} [options]
 */
export function placeCues(cues, { sampleRate = SAMPLE_RATE, label = 'the recording' } = {}) {
  const out = Buffer.alloc(
    Math.ceil(
      (cues.reduce(
        (longest, cue) =>
          Math.max(longest, Math.max(0, Number(cue.startMs) || 0) + pcmMs(cue.pcm ?? Buffer.alloc(0), sampleRate)),
        0,
      ) /
        1_000) *
        sampleRate,
    ) * 2,
  );

  const warnings = [];
  const ordered = [...cues].sort((a, b) => (Number(a.startMs) || 0) - (Number(b.startMs) || 0));
  let previousEndMs = null;
  for (const cue of ordered) {
    const pcm = cue.pcm ?? Buffer.alloc(0);
    if (!pcm.length) continue;
    const startMs = Math.max(0, Number(cue.startMs) || 0);
    if (previousEndMs !== null && startMs < previousEndMs) {
      warnings.push(
        `the line at ${(startMs / 1000).toFixed(2)}s starts ${((previousEndMs - startMs) / 1000).toFixed(2)}s ` +
          `before the one before it ends, in ${label} — they will talk over each other`,
      );
    }
    const atByte = Math.round((startMs / 1_000) * sampleRate) * 2;
    const room = Math.min(pcm.length, out.length - atByte);
    pcm.copy(out, atByte, 0, room);
    previousEndMs = startMs + pcmMs(pcm, sampleRate);
  }
  return { pcm: out, warnings };
}

/**
 * The mux.
 *
 * The video is copied, never re-encoded: this pass only adds a track. `apad`
 * makes the audio infinite and `-shortest` then ends the output with the video,
 * so a recording longer than its last line gets silence rather than being
 * truncated to the audio.
 */
export function muxArgs({ video, audio, out, bitrate = '96k' }) {
  return [
    '-loglevel', 'error',
    '-y',
    '-i', video,
    '-i', audio,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'libopus',
    '-b:a', bitrate,
    '-ar', String(SAMPLE_RATE),
    '-ac', '1',
    '-af', 'apad',
    '-shortest',
    out,
  ];
}

/** Write it, then hand the file over. A failure leaves the original untouched. */
export async function muxNarration({ ffmpeg, video, audio, out, run = runCommand }) {
  await run(ffmpeg, muxArgs({ video, audio, out }));
  return out;
}
