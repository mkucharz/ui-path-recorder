/**
 * Voice narration.
 *
 * A `caption` is text a viewer reads; narration is the same walkthrough spoken
 * aloud. Two engines speak it: macOS `say` by default — no install, no key, no
 * network — or ElevenLabs over HTTPS, when the plan or a flag asks for it. The
 * engine only turns text into samples; placement, pacing and the mux are shared,
 * so a line sounds like the voice and is timed like every other line.
 *
 * Three things make this a library rather than a flag:
 *
 *   - **Synthesis is a separate pass.** A spoken sentence is two to five
 *     seconds and a step is often shorter, so the runner has to know how long
 *     each line takes *before* it records. Text is known from the plan, so
 *     every line is spoken before the browser opens and the pacing then rides
 *     the step's own `hold`.
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

/** The engines a plan or flag may name. `say` is the default: no key, no network. */
export const ENGINES = ['say', 'elevenlabs'];

/**
 * ElevenLabs defaults.
 *
 * `eleven_multilingual_v2` is the model that reads a two-sentence line naturally
 * in every locale the recorder supports; `pcm_48000` is what makes a line need
 * no decoder and no resampling — the API writes the exact shape `say` writes.
 * The voice is a *premade* one on purpose: library voices answer
 * `402 paid_plan_required` on a free workspace, and a default that fails on the
 * cheapest plan is a default nobody can try.
 */
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_multilingual_v2';
export const ELEVENLABS_DEFAULT_VOICE = { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' };
export const ELEVENLABS_OUTPUT_FORMAT = 'pcm_48000';
export const ELEVENLABS_API_URL = 'https://api.elevenlabs.io';

/** `voice_settings.speed` bounds. A rate outside them is clamped, not refused. */
export const ELEVENLABS_SPEED_RANGE = { min: 0.7, max: 1.2 };

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

export const ELEVENLABS_KEY_HINT = [
  'narration with --narration-engine elevenlabs needs an API key.',
  '',
  '  export ELEVENLABS_API_KEY=...   (elevenlabs.io → profile → API keys)',
  '',
  '  The key needs the text-to-speech permission. A key that cannot list voices',
  '  still works when the voice is an id: --voice pNInz6obpgDQGcFmaJgB',
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
 *
 * `engine` defaults to `say` rather than being inferred from the environment:
 * a plan that records the same way on a Mac and on a CI box should not switch
 * voices because a key happened to be exported. The model is the engine's own
 * default when unset, which is why it stays null here.
 */
export function resolveNarration({ enabled = null, engine = null, model = null, voice = null, rate = null, tailMs = null, plan = null } = {}) {
  const fromPlan = plan?.video?.narration ?? {};
  return {
    enabled: enabled ?? Boolean(plan?.video?.narration),
    engine: engine ?? fromPlan.engine ?? 'say',
    model: model ?? fromPlan.model ?? null,
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
 *
 * The `--video` branch is only reached when `--narration` asked explicitly (a
 * plan's own `video.narration` is skipped with a warning, so a figure run of a
 * narrated plan still works); `speed` may come from `--speed` *or* from the
 * plan's `humanize.speed`, which is why the message names both.
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
    return (
      `narration needs --speed 1 (this run is at ${speed}×, from --speed or the plan's humanize.speed): the hold is scaled ` +
      'by the speed but the recorded voice is not, so any other speed drifts the two apart'
    );
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
  // The container is named rather than inferred from the `.wav` extension: the
  // reader below parses PCM, and a `say` that wrote AIFF because of a future
  // default would fail with a message about a "not a WAV" file instead of
  // anything that points at `say`.
  const args = ['-f', textFile, '-o', outFile, '--file-format=WAVE', '--data-format=LEI16@48000'];
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

/**
 * The cache key: same engine, same voice, same speed, same words → same audio.
 *
 * The `say` key is unchanged (`voice|rate|text`) so an existing cache keeps
 * working; another engine adds its own name and model, because the same words in
 * two engines are two different recordings.
 */
export function narrationKey({ text, voice = null, rate = null, engine = null, model = null }) {
  const parts =
    !engine || engine === 'say'
      ? [voice ?? '', rate ?? '', text]
      : [engine, model ?? '', voice ?? '', rate ?? '', text];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
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
 * ElevenLabs
 * ------------------------------------------------------------------ */

/**
 * Words per minute → ElevenLabs' `voice_settings.speed`.
 *
 * The API's range is 0.7–1.2 and it answers **400** outside it, so a rate is
 * clamped here with the caller told, rather than a run that fails on its 5th
 * line for a reason that names neither the rate nor the range. 180 wpm is 1.0 —
 * the engine's own idea of conversational, which is also `say`'s default.
 *
 * @returns {{speed: number, wanted: number, clamped: boolean}}
 */
export function elevenLabsSpeed(rate) {
  const wanted = Math.round((Number(rate) / DEFAULT_RATE) * 100) / 100;
  const speed = Math.min(ELEVENLABS_SPEED_RANGE.max, Math.max(ELEVENLABS_SPEED_RANGE.min, wanted));
  return { speed: Math.round(speed * 100) / 100, wanted, clamped: Math.abs(speed - wanted) > 0.005 };
}

/**
 * Does this look like a voice id rather than a name?
 *
 * ElevenLabs ids are 20 alphanumerics (`pNInz6obpgDQGcFmaJgB`); names are human
 * words with spaces. Looking at the shape is what lets a key with only the
 * text-to-speech permission work: resolving a *name* needs `voices_read`, which
 * a scoped key often does not have.
 */
export function looksLikeVoiceId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{15,}$/.test(value.trim());
}

/**
 * The voice to speak this run with.
 *
 * Precedence: the plan/flag, then `ELEVENLABS_VOICE_ID`, then a premade default.
 * A plan that never names a voice still narrates — that is the same promise
 * `say`'s "system default" makes — and the name is resolved once, before any
 * line is spoken, so a typo fails before the browser opens.
 *
 * @returns {Promise<{id: string, name: string|null, source: 'plan'|'env'|'default'|'name'}>}
 */
export async function resolveElevenLabsVoice({ voice = null, env = process.env, apiUrl = ELEVENLABS_API_URL, fetchImpl = fetch } = {}) {
  const fromFlag = typeof voice === 'string' && voice.trim() ? voice.trim() : null;
  const fromEnv = typeof env.ELEVENLABS_VOICE_ID === 'string' && env.ELEVENLABS_VOICE_ID.trim() ? env.ELEVENLABS_VOICE_ID.trim() : null;
  const wanted = fromFlag ?? fromEnv;

  if (!wanted) {
    return { ...ELEVENLABS_DEFAULT_VOICE, source: 'default' };
  }
  if (looksLikeVoiceId(wanted)) {
    return { id: wanted, name: null, source: fromFlag ? 'plan' : 'env' };
  }

  const base = apiUrl.replace(/\/+$/, '');
  let response;
  try {
    response = await fetchImpl(`${base}/v1/voices`, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY ?? '' } });
  } catch (error) {
    throw new NarrationError(`cannot reach ElevenLabs at ${apiUrl}: ${error.message}`);
  }
  if (!response.ok) throw await elevenLabsFailure(response);
  const list = await response.json().catch(() => null);
  const voices = Array.isArray(list?.voices) ? list.voices : [];
  const found = voices.find((entry) => String(entry?.name ?? '').toLowerCase() === wanted.toLowerCase());
  if (!found) {
    const known = voices.map((entry) => entry?.name).filter(Boolean).slice(0, 8);
    throw new NarrationError(
      `no ElevenLabs voice is named ${JSON.stringify(wanted)}` +
        (known.length ? ` (this key sees: ${known.join(', ')})` : '') +
        '. Pass a voice id instead — a name needs the `voices_read` permission',
    );
  }
  return { id: found.voice_id, name: found.name ?? null, source: 'name' };
}

/**
 * The request for one line, as data.
 *
 * Separated from the fetch so a test can assert the URL, the key header and the
 * body without a server, and so the body has exactly one author: `text`,
 * `model_id`, and the speed that the rate became.
 */
export function elevenLabsRequest({ apiUrl = ELEVENLABS_API_URL, voiceId, key, text, model = ELEVENLABS_DEFAULT_MODEL, speed = 1 }) {
  const base = apiUrl.replace(/\/+$/, '');
  return {
    url: `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
    init: {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'content-type': 'application/json',
        accept: 'audio/pcm',
      },
      body: JSON.stringify({ text, model_id: model, voice_settings: { speed } }),
    },
  };
}

/**
 * Turn an error response into the sentence a user can act on.
 *
 * The API's own message is kept (it is usually right about what is wrong) and a
 * sentence is added only where the status alone does not say what to do — a
 * scoped key that cannot list voices, a free workspace sent at a library voice,
 * a rate-limited run.
 */
async function elevenLabsFailure(response, { voiceId = null } = {}) {
  const body = await response.text().catch(() => '');
  let detail = null;
  try {
    detail = JSON.parse(body)?.detail ?? null;
  } catch {
    // Not JSON: the body itself is the message.
  }
  const message = String(detail?.message ?? body ?? '').trim().slice(0, 300);
  const code = detail?.code ?? detail?.type ?? '';
  let hint = '';
  if (response.status === 401) {
    hint = /voices_read/.test(message)
      ? ' A voice *name* needs the `voices_read` permission: pass a voice id instead (`--voice <id>`).'
      : ' Check ELEVENLABS_API_KEY. A key with only the text-to-speech permission works when --voice is an id.';
  } else if (response.status === 402 || code === 'paid_plan_required') {
    hint =
      ' Free workspaces cannot use library voices through the API: pass a premade voice id' +
      ` (${ELEVENLABS_DEFAULT_VOICE.name} is ${ELEVENLABS_DEFAULT_VOICE.id}) or upgrade the workspace.`;
  } else if (response.status === 429) {
    hint = ' Rate limited: wait a moment, or record fewer lines in one run.';
  } else if (response.status === 404 && voiceId) {
    hint = ` ElevenLabs has no voice with id ${voiceId}.`;
  } else if (response.status === 400) {
    hint = hint || ' The request was refused: check `model` and that the rate is inside 0.7–1.2.';
  }
  return new NarrationError(
    `ElevenLabs returned HTTP ${response.status}${code ? ` (${code})` : ''}: ${message || 'no message'}${hint}`,
  );
}

/**
 * Speak one line with ElevenLabs and return its samples.
 *
 * Same contract as `synthesizeSay` — 48 kHz 16-bit mono, content-addressed cache,
 * a failure that leaves nothing behind — because everything downstream (pacing,
 * `.vtt`, mux) must not know which engine spoke.
 *
 * `output_format=pcm_48000` means the response is raw little-endian samples, not
 * a container: the header is added here, which is also the only place that can
 * tell a truncated response from a quiet one. The content type is checked
 * strictly, because compressed bytes read as PCM are noise that sounds like a
 * bug in the mux.
 */
export async function synthesizeElevenLabs({
  apiUrl = ELEVENLABS_API_URL,
  key,
  voiceId,
  model = ELEVENLABS_DEFAULT_MODEL,
  speed = 1,
  text,
  dir,
  fetchImpl = fetch,
}) {
  if (!key) throw new NarrationError('ElevenLabs needs an API key: set ELEVENLABS_API_KEY');

  const cacheKey = narrationKey({ text, voice: voiceId, rate: speed, engine: 'elevenlabs', model });
  const wav = path.join(dir, `${cacheKey}.wav`);
  const cached = await readFile(wav).catch(() => null);
  if (cached) {
    const audio = readWav(cached);
    return { ...audio, ms: pcmMs(audio.pcm, audio.sampleRate), cached: true };
  }

  await mkdir(dir, { recursive: true });
  const { url, init } = elevenLabsRequest({ apiUrl, voiceId, key, text, model, speed });
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new NarrationError(`cannot reach ElevenLabs at ${apiUrl}: ${error.message}`);
  }
  if (!response.ok) throw await elevenLabsFailure(response, { voiceId });

  const type = String(response.headers?.get?.('content-type') ?? '');
  if (!/^audio\/pcm\b/i.test(type)) {
    throw new NarrationError(
      `ElevenLabs answered ${type || 'with no content type'}, not audio/pcm — ` +
        `output_format=${ELEVENLABS_OUTPUT_FORMAT} was not honoured`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  // A 16-bit sample is two bytes; an odd byte is a truncated last sample, not
  // something to pad into a click.
  const pcm = bytes.length % 2 ? bytes.subarray(0, bytes.length - 1) : bytes;
  if (!pcm.length) {
    throw new NarrationError(`ElevenLabs returned no audio for ${JSON.stringify(text.slice(0, 48))}`);
  }

  // Written beside the target and renamed, like `say`'s line: a killed process
  // must not leave a short WAV that the next run reads as a cached line.
  const part = `${wav}.part.wav`;
  await writeFile(part, writeWav(pcm));
  await rename(part, wav);
  return { sampleRate: SAMPLE_RATE, channels: 1, pcm, ms: pcmMs(pcm, SAMPLE_RATE), cached: false };
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
