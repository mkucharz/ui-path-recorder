/**
 * Voice narration, without a Mac.
 *
 * The engine (`say`) and the mux (`ffmpeg`) are processes, so the pipeline is
 * built around an injectable `run`. Almost everything here drives that seam: the
 * text a step speaks, the pacing arithmetic that makes the picture wait, the
 * sample offsets the audio is spliced at, and the mux invocation itself.
 *
 * Two tests go further, on purpose, because a green unit suite that cannot speak
 * is the failure this feature invites:
 *
 *   - a real `say` — a shell script on PATH that writes the same 48 kHz WAV — is
 *     detected by `findSay` and spoken through the real `runCommand`, which is
 *     the whole reason the engine is detected by binary rather than by platform;
 *   - a real ffmpeg muxes an Opus track into a real VP9 webm, and ffprobe proves
 *     the video was copied rather than truncated to the audio's length.
 *
 * The one thing no test here can prove is that macOS `say` sounds right. That
 * needs the Mac, and the README says so.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cuesForRecording } from '../lib/captions.mjs';
import { validate } from '../lib/plan.mjs';
import {
  DEFAULT_RATE,
  DEFAULT_TAIL_MS,
  NARRATION_FFMPEG_HINT,
  NarrationError,
  SAMPLE_RATE,
  SAY_HINT,
  defaultCacheDir,
  findMuxFfmpeg,
  findSay,
  muxArgs,
  muxNarration,
  narrationKey,
  narrationCopyWarnings,
  narrationRefusal,
  narrationText,
  pcmMs,
  placeCues,
  probeOpus,
  readWav,
  resolveNarration,
  runCommand,
  sayArgs,
  synthesizeSay,
  whichOnPath,
  writeWav,
} from '../lib/narration.mjs';

const tempDirs = [];
const temp = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'upr-narration-'));
  tempDirs.push(dir);
  return dir;
};
process.on('exit', () => {
  for (const dir of tempDirs) rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** Constant-value 16-bit samples: easy to find a splice point in, and audible if played. */
const samples = (ms, value = 0, { sampleRate = SAMPLE_RATE, channels = 1 } = {}) => {
  const frames = Math.round((ms / 1_000) * sampleRate);
  const buffer = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(value, (frame * channels + channel) * 2);
    }
  }
  return buffer;
};

/** A WAV byte string with a hand-built header, so a wrong header is testable. */
const wavBytes = ({ pcm, sampleRate = SAMPLE_RATE, channels = 1, bits = 16, format = 1 }) => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

/* ------------------------------------------------------------------ *
 * The text a step speaks
 * ------------------------------------------------------------------ */

test('a step speaks its caption unless it says otherwise', () => {
  assert.equal(narrationText({ caption: 'Open the sign-in page.' }), 'Open the sign-in page.');
  assert.equal(narrationText({ caption: 'Short.', say: 'A much longer spoken line.' }), 'A much longer spoken line.');
  // An empty `say` is not a way to mute a step silently; it falls back.
  assert.equal(narrationText({ caption: 'Keep me.', say: '   ' }), 'Keep me.');
  assert.equal(narrationText({ say: 'Only spoken.' }), 'Only spoken.');
  assert.equal(narrationText({ name: 'no text at all' }), null);
  assert.equal(narrationText({ caption: '   ' }), null);
  assert.equal(narrationText(null), null);
});

test('the spoken line is one line, because it is synthesized to one utterance', () => {
  assert.equal(narrationText({ caption: '  spread\n  over\tlines  ' }), 'spread over lines');
});

test('the plan turns narration on, and the flags win over it', () => {
  const plan = { video: { narration: { voice: 'Ava', rate: 200, tailMs: 250 } } };
  // Delivery settings are `null` until something sets them: "the engine's own
  // default" and "0.5" are different statements, and only the engine knows its
  // default.
  const noDelivery = { stability: null, similarityBoost: null, style: null, speakerBoost: null };
  assert.deepEqual(resolveNarration({ plan }), {
    enabled: true,
    engine: 'say',
    model: null,
    voice: 'Ava',
    rate: 200,
    tailMs: 250,
    fit: 'hold',
    voiceSettings: noDelivery,
  });

  // No block, no narration — the feature is never on by surprise.
  const off = {
    enabled: false,
    engine: 'say',
    model: null,
    voice: null,
    rate: DEFAULT_RATE,
    tailMs: DEFAULT_TAIL_MS,
    fit: 'hold',
    voiceSettings: noDelivery,
  };
  assert.deepEqual(resolveNarration({ plan: { video: {} } }), off);
  assert.deepEqual(resolveNarration({ plan: null }), off);

  // `--no-narration` beats the plan, which is how a silent copy is made from a
  // narrated plan without editing it.
  assert.equal(resolveNarration({ enabled: false, plan }).enabled, false);
  // And a flag overrides the block it duplicates.
  const overridden = resolveNarration({ plan, voice: 'Daniel', rate: 160, tailMs: 0 });
  assert.deepEqual(overridden, {
    enabled: true,
    engine: 'say',
    model: null,
    voice: 'Daniel',
    rate: 160,
    tailMs: 0,
    fit: 'hold',
    voiceSettings: noDelivery,
  });

  // The engine is chosen, never sniffed: a plan that names none gets `say`, and
  // a flag naming another one wins over the plan. An unset model is `null` —
  // each engine's own default is applied where the engine is, not here.
  const eleven = { video: { narration: { engine: 'elevenlabs', model: 'eleven_turbo_v2_5' } } };
  assert.equal(resolveNarration({ plan: eleven }).engine, 'elevenlabs');
  assert.equal(resolveNarration({ plan: eleven }).model, 'eleven_turbo_v2_5');
  assert.equal(resolveNarration({ plan: eleven, engine: 'say' }).engine, 'say');
  assert.equal(resolveNarration({ plan: { video: { narration: { engine: 'elevenlabs' } } } }).model, null);
});

test('pacing and delivery are plan settings, read from the same block as the voice', () => {
  const plan = {
    video: {
      narration: {
        engine: 'elevenlabs',
        fit: 'line',
        stability: 0.35,
        similarityBoost: 0.6,
        style: 0.15,
        speakerBoost: false,
      },
    },
  };
  const resolved = resolveNarration({ plan });
  assert.equal(resolved.fit, 'line');
  assert.deepEqual(resolved.voiceSettings, {
    stability: 0.35,
    similarityBoost: 0.6,
    style: 0.15,
    speakerBoost: false,
  });

  // `false` is a value: a plan that turns the speaker boost off must not fall
  // back to the engine default through a `||`.
  assert.equal(resolveNarration({ plan: { video: { narration: { speakerBoost: false } } } }).voiceSettings.speakerBoost, false);
  assert.equal(resolveNarration({ plan: null }).fit, 'hold');
});

test('narration refuses the runs that would put the voice out of step', () => {
  const ok = { enabled: true, video: true, humanized: true, speed: 1 };
  assert.equal(narrationRefusal(ok), null);
  assert.equal(narrationRefusal({ ...ok, enabled: false, video: false }), null, 'off is never refused');

  assert.match(narrationRefusal({ ...ok, video: false }), /--video/);
  assert.match(narrationRefusal({ ...ok, humanized: false }), /--no-humanize/);
  // The hold is scaled but the recording is not: any speed but 1 drifts.
  assert.match(narrationRefusal({ ...ok, speed: 2 }), /--speed 1/);
  assert.match(narrationRefusal({ ...ok, speed: 1.5 }), /1\.5/);
  assert.match(SAY_HINT, /macOS/);
  assert.match(NARRATION_FFMPEG_HINT, /libopus/);
});

/* ------------------------------------------------------------------ *
 * The plan contract
 * ------------------------------------------------------------------ */

test('a plan may carry a spoken line and a narration block', () => {
  const plan = (over = {}) => ({ baseUrl: 'https://example.test', steps: [{ click: '#go', caption: 'Tap Go.' }], ...over });

  assert.doesNotThrow(() => validate(plan()));
  // A `say`-only step is a spoken beat: the previous screen stays up while the
  // voice finishes, which is a legitimate step in a narrated walkthrough.
  assert.doesNotThrow(
    () => validate(plan({ steps: [{ click: '#go', caption: 'Tap Go.' }, { say: 'Wait for the dashboard to load.' }] })),
    'a step may exist just to say something',
  );
  assert.doesNotThrow(() => validate(plan({ video: { narration: { voice: 'Ava', rate: 190, tailMs: 200 } } })));
  // An empty block is the plan asking for narration with every default.
  assert.doesNotThrow(() => validate(plan({ video: { narration: {} } })));

  // A mistyped key is refused, like everywhere else in the plan.
  assert.throws(() => validate(plan({ video: { narration: { rate2: 190 } } })), /video\.narration/);
  assert.throws(() => validate(plan({ video: { narration: { voice: '' } } })), /voice/);
  assert.throws(() => validate(plan({ video: { narration: { rate: 0 } } })), /rate/);
  assert.throws(() => validate(plan({ video: { narration: { tailMs: -1 } } })), /tailMs/);
});

test('the delivery and pacing keys are validated, and the ones `say` cannot use are flagged', () => {
  const plan = (narration, over = {}) => ({
    baseUrl: 'https://example.test',
    video: { narration },
    steps: [{ click: '#go', caption: 'Tap Go.' }],
    ...over,
  });

  assert.doesNotThrow(() =>
    validate(
      plan({
        engine: 'elevenlabs',
        fit: 'line',
        stability: 0.4,
        style: 0,
        similarityBoost: 1,
        speakerBoost: false,
      }),
    ),
  );

  assert.throws(() => validate(plan({ fit: 'sentence' })), /"video\.narration\.fit" must be one of hold, line/);
  assert.throws(() => validate(plan({ stability: 1.5 })), /stability.*0 to 1/);
  assert.throws(() => validate(plan({ style: -0.1 })), /style.*0 to 1/);
  assert.throws(() => validate(plan({ similarityBoost: 'high' })), /similarityBoost/);
  assert.throws(() => validate(plan({ speakerBoost: 'yes' })), /speakerBoost.*true or false/);

  // A delivery knob on a `say` plan is inert. Warning, not refusal: the plan is
  // valid, it just does nothing, and saying nothing is what makes it confusing.
  const { warnings } = validate(plan({ stability: 0.4 }));
  assert.ok(
    warnings.some((warning) => /stability.*only the elevenlabs engine reads/.test(warning)),
    `expected a delivery warning, got ${JSON.stringify(warnings)}`,
  );
  const withEngine = validate(plan({ engine: 'elevenlabs', stability: 0.4 }));
  assert.equal(
    withEngine.warnings.some((warning) => /only the elevenlabs engine reads/.test(warning)),
    false,
    'naming the engine is the fix, so it must silence the warning',
  );
});

test('copy that reads like a caption is warned about, never refused', () => {
  const steps = [
    { click: '#a', caption: 'Choose Sign in.' },
    { click: '#b', caption: 'Select the account you signed up with.' },
    { click: '#c', caption: "Press Sign in when you're ready and the workspace opens." },
    { click: '#d', caption: 'And you land in your workspace, signed in.' },
  ];
  const warnings = narrationCopyWarnings(steps);

  // Two shapes: a label, and a bare instruction to a control.
  assert.ok(warnings.some((warning) => /step #1 .*a label, not a sentence/.test(warning)), warnings.join('\n'));
  assert.ok(warnings.some((warning) => /step #2 .*instruction to a control/.test(warning)), warnings.join('\n'));
  // A line with room for a reason is left alone.
  assert.equal(warnings.some((warning) => /step #3/.test(warning)), false);
  // So is a long one that already has a connective.
  assert.equal(warnings.some((warning) => /step #4/.test(warning)), false);

  // Delivery tags are directions to the model, not words: `[warmly] Go.` is still
  // a two-word line.
  assert.match(narrationCopyWarnings([{ caption: '[warmly] Go.' }])[0], /a label/);
  assert.deepEqual(narrationCopyWarnings([{ caption: 'You land in your workspace, already signed in.' }]), []);
  // A verb-plus-clause is a spoken sentence, not an instruction: this is the copy
  // the example plan uses, and it must not be flagged.
  assert.deepEqual(narrationCopyWarnings([{ caption: "Press Sign in when you're ready." }]), []);
});

test('an over-long spoken line is refused, and a narrated step with no caption is flagged', () => {
  assert.throws(
    () => validate({ baseUrl: 'https://example.test', steps: [{ click: '#go', say: 'x'.repeat(401) }] }),
    /"say" is 401 characters/,
  );
  assert.throws(
    () => validate({ baseUrl: 'https://example.test', steps: [{ click: '#go', say: 'two\nlines' }] }),
    /single line/,
  );

  const { warnings } = validate({
    baseUrl: 'https://example.test',
    video: { narration: {} },
    steps: [
      { click: '#a', caption: 'First.' },
      { click: '#b', say: 'Spoken but not shown.' },
      { click: '#c', caption: 'Third.' },
    ],
  });
  assert.ok(
    warnings.some((warning) => /narrated with no "caption"/.test(warning)),
    'the pill blanks for the whole line, which the plan should know about',
  );
});

/* ------------------------------------------------------------------ *
 * WAV
 * ------------------------------------------------------------------ */

test('a WAV reads back as mono 16-bit samples at 48 kHz', () => {
  const pcm = samples(250, 1_234);
  const audio = readWav(writeWav(pcm));
  assert.equal(audio.sampleRate, SAMPLE_RATE);
  assert.equal(audio.channels, 1);
  assert.equal(audio.pcm.length, pcm.length);
  assert.equal(audio.pcm.readInt16LE(0), 1_234);
  assert.equal(pcmMs(audio.pcm), 250);
  assert.equal(pcmMs(Buffer.alloc(96)), 1, '96 bytes is one millisecond at 48 kHz mono');
});

test('a stereo WAV is downmixed to channel zero, not averaged', () => {
  // Left channel 100, right channel -100: an average would be silence.
  const stereo = Buffer.alloc(4 * 2);
  stereo.writeInt16LE(100, 0);
  stereo.writeInt16LE(-100, 2);
  stereo.writeInt16LE(200, 4);
  stereo.writeInt16LE(-200, 6);
  const audio = readWav(wavBytes({ pcm: stereo, channels: 2 }));
  assert.equal(audio.channels, 2);
  assert.equal(audio.pcm.length, 4);
  assert.equal(audio.pcm.readInt16LE(0), 100);
  assert.equal(audio.pcm.readInt16LE(2), 200);
});

test('a WAV in the wrong shape says what is wrong, because say may ignore the request', () => {
  const pcm = samples(10);
  assert.throws(() => readWav(Buffer.from('not a wav at all, honestly')), NarrationError);
  assert.throws(() => readWav(wavBytes({ pcm, sampleRate: 22_050 })), /22050 Hz, not 48000 Hz/);
  assert.throws(() => readWav(wavBytes({ pcm, bits: 8 })), /8-bit, not 16-bit/);
  assert.throws(() => readWav(wavBytes({ pcm, format: 3 })), /format 3, not uncompressed PCM/);
});

test('the WAV this writes is a RIFF header and nothing that changes between runs', () => {
  const pcm = samples(5, 42);
  const first = writeWav(pcm);
  const second = writeWav(pcm);
  assert.deepEqual(first, second, 'no timestamps, no padding, no randomness');

  // Header fields a muxer reads.
  assert.equal(first.toString('ascii', 0, 4), 'RIFF');
  assert.equal(first.toString('ascii', 8, 12), 'WAVE');
  assert.equal(first.readUInt32LE(4), first.length - 8, 'RIFF size excludes the RIFF tag itself');
  assert.equal(first.readUInt16LE(22), 1, 'mono');
  assert.equal(first.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(first.readUInt32LE(28), SAMPLE_RATE * 2, 'byte rate');
  assert.equal(first.readUInt32LE(40), pcm.length);
});

/* ------------------------------------------------------------------ *
 * Pacing
 * ------------------------------------------------------------------ */

test('each line is placed at its cue start, with silence around it', () => {
  const one = samples(500, 1_000);
  const two = samples(250, 2_000);
  const { pcm, warnings } = placeCues([
    { startMs: 1_000, pcm: one },
    { startMs: 3_000, pcm: two },
  ]);
  assert.deepEqual(warnings, []);
  const frames = pcm.length / 2;
  assert.equal(frames, Math.ceil((3_250 / 1_000) * SAMPLE_RATE), 'the track is as long as the last line ends');

  const at = (ms) => pcm.readInt16LE(Math.round((ms / 1_000) * SAMPLE_RATE) * 2);
  assert.equal(at(0), 0, 'before the first line is silence');
  assert.equal(at(999), 0);
  assert.equal(at(1_000), 1_000, 'the sample at the cue start is the first sample of the line');
  assert.equal(at(1_499), 1_000);
  assert.equal(at(1_500), 0, 'the line stops where it ends, not at the next one');
  assert.equal(at(2_999), 0);
  assert.equal(at(3_000), 2_000);
  assert.equal(at(3_249), 2_000);
});

test('a line that would run past the track is cut and reported', () => {
  const { pcm, warnings } = placeCues([
    { startMs: 0, pcm: samples(1_000, 7) },
    { startMs: 400, pcm: samples(200, 9) },
  ]);
  assert.equal(pcm.length, samples(1_000).length, 'the track is as long as the longest cue ends');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /starts 0\.60s before the one before it ends/);
  assert.match(warnings[0], /talk over each other/);
  // The later line wins the overlap: the splice is a plain copy, in order.
  assert.equal(pcm.readInt16LE(Math.round(0.4 * SAMPLE_RATE) * 2), 9);
});

test('a cue list in the wrong order is composed by start, not by array position', () => {
  const { pcm } = placeCues([
    { startMs: 1_000, pcm: samples(200, 2_000) },
    { startMs: 0, pcm: samples(200, 1_000) },
  ]);
  assert.equal(pcm.readInt16LE(0), 1_000);
  assert.equal(pcm.readInt16LE(SAMPLE_RATE * 2), 2_000, 'the 1s cue landed at 1s');
});

/* ------------------------------------------------------------------ *
 * Synthesis
 * ------------------------------------------------------------------ */

test('say is invoked with the text in a file, so no caption can be a shell problem', () => {
  const args = sayArgs({ textFile: '/tmp/t.txt', outFile: '/tmp/o.wav', voice: 'Ava', rate: 190 });
  assert.deepEqual(args, [
    '-f', '/tmp/t.txt',
    '-o', '/tmp/o.wav',
    // The container is named: the reader parses PCM, so it must not depend on
    // `say` inferring WAVE from the extension.
    '--file-format=WAVE',
    '--data-format=LEI16@48000',
    '-v', 'Ava',
    '-r', '190',
  ]);
  // No voice pinned means the system default: `-v ""` would be an error.
  assert.deepEqual(sayArgs({ textFile: 't', outFile: 'o' }), ['-f', 't', '-o', 'o', '--file-format=WAVE', '--data-format=LEI16@48000']);
});

test('synthesis writes a WAV, caches it by content, and reports its length', async () => {
  const dir = await temp();
  const cache = path.join(dir, 'cache');
  const spoken = [];
  const run = async (command, args) => {
    spoken.push({ command, args });
    const out = args[args.indexOf('-o') + 1];
    await writeFile(out, writeWav(samples(750, 500)));
    return { code: 0, stdout: '', stderr: '' };
  };

  const first = await synthesizeSay({ say: '/usr/bin/say', text: 'Hello there.', voice: 'Ava', rate: 180, dir: cache, run });
  assert.equal(first.cached, false);
  assert.equal(first.ms, 750);
  assert.equal(first.pcm.readInt16LE(0), 500);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].command, '/usr/bin/say');
  // The text went to a file, and the file was cleaned up.
  const textFile = spoken[0].args[spoken[0].args.indexOf('-f') + 1];
  assert.deepEqual((await readFile(textFile).catch(() => null)), null, 'the scratch text file is removed');

  const second = await synthesizeSay({ say: '/usr/bin/say', text: 'Hello there.', voice: 'Ava', rate: 180, dir: cache, run });
  assert.equal(second.cached, true);
  assert.equal(spoken.length, 1, 'a cache hit spawns nothing');
  assert.equal(second.ms, 750);

  // The key covers all three things that change the audio.
  assert.notEqual(narrationKey({ text: 'Hello there.', voice: 'Ava', rate: 180 }), narrationKey({ text: 'Hello there.', voice: 'Daniel', rate: 180 }));
  assert.notEqual(narrationKey({ text: 'Hello there.', voice: 'Ava', rate: 180 }), narrationKey({ text: 'Hello there.', voice: 'Ava', rate: 200 }));
  assert.notEqual(narrationKey({ text: 'Hello there.', voice: 'Ava', rate: 180 }), narrationKey({ text: 'Hello, there.', voice: 'Ava', rate: 180 }));
});

test('a say that reports success but writes nothing is an error, not silence', async () => {
  const dir = await temp();
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  await assert.rejects(
    () => synthesizeSay({ say: 'say', text: 'Hello', dir: path.join(dir, 'c'), run }),
    /wrote no file/,
  );
});

test('a say that writes something that is not a WAV leaves no half-file in the cache', async () => {
  const dir = await temp();
  const cache = path.join(dir, 'c');
  const run = async (command, args) => {
    await writeFile(args[args.indexOf('-o') + 1], 'garbage');
    return { code: 0, stdout: '', stderr: '' };
  };
  await assert.rejects(() => synthesizeSay({ say: 'say', text: 'Hi', dir: cache, run }), NarrationError);
  const { readdir } = await import('node:fs/promises');
  const left = await readdir(cache).catch(() => []);
  assert.deepEqual(left.filter((name) => name.endsWith('.wav')), [], 'nothing cached that would be read back next time');
});

test('a say that fails is reported with its own output', async () => {
  const dir = await temp();
  const run = async () => {
    throw new NarrationError('say exited 1: voice "Nope" not found');
  };
  await assert.rejects(
    () => synthesizeSay({ say: 'say', text: 'Hello', voice: 'Nope', dir: path.join(dir, 'c'), run }),
    /voice "Nope" not found/,
  );
});

test('the cache directory honours the environment, so a test never writes to the real one', () => {
  assert.equal(defaultCacheDir({ UI_PATH_RECORDER_CACHE_DIR: '/tmp/x' }), '/tmp/x');
  assert.equal(defaultCacheDir({ XDG_CACHE_HOME: '/tmp/cache' }), path.join('/tmp/cache', 'ui-path-recorder', 'narration'));
  assert.match(defaultCacheDir({}), /ui-path-recorder[\\/]narration$/);
});

/* ------------------------------------------------------------------ *
 * Finding the tools
 * ------------------------------------------------------------------ */

test('the engine is found on PATH, not by platform', async () => {
  const dir = await temp();
  const say = path.join(dir, 'say');
  await writeFile(say, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // A directory called `say` is not an engine.
  await mkdir(path.join(dir, 'fdirectory'));
  assert.equal(await whichOnPath('say', { env: { PATH: dir } }), say);
  assert.equal(await findSay({ env: { PATH: `${dir}${path.delimiter}/nonexistent` } }), say);
  assert.equal(await findSay({ env: { PATH: '/nonexistent' } }), null);
  assert.equal(await findSay({ env: {} }), null);
});

test('a stub say on PATH drives the real pipeline, end to end', async () => {
  const ffmpeg = await findMuxFfmpeg();
  if (!ffmpeg) return; // The stub needs ffmpeg to write a WAV; the mux test below explains it.
  const dir = await temp();
  const say = path.join(dir, 'say');
  // Not macOS `say`: a script that obeys the same contract, which is the point of
  // detecting the binary rather than `process.platform`.
  await writeFile(
    say,
    [
      '#!/bin/sh',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out="$2"; shift 2 ;;',
      '    -f|-v|-r) shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      `exec "${ffmpeg}" -loglevel error -y -f lavfi -i anullsrc=r=48000:cl=mono -t 0.5 -c:a pcm_s16le "$out"`,
    ].join('\n'),
    { mode: 0o755 },
  );

  const found = await findSay({ env: { PATH: `${dir}${path.delimiter}${process.env.PATH}` } });
  assert.equal(found, say);

  const line = await synthesizeSay({ say: found, text: 'Spoken by a stub.', dir: path.join(dir, 'cache') });
  assert.equal(line.cached, false);
  assert.ok(line.ms >= 450 && line.ms <= 560, `half a second of audio, got ${line.ms}ms`);

  // Second call: cached, so the stub may vanish without breaking anything.
  await rm(say);
  const again = await synthesizeSay({ say: found, text: 'Spoken by a stub.', dir: path.join(dir, 'cache') });
  assert.equal(again.cached, true);
  assert.equal(again.ms, line.ms);
});

/* ------------------------------------------------------------------ *
 * The mux
 * ------------------------------------------------------------------ */

test('the mux copies the video and pads the audio, so a short line cannot cut the picture', () => {
  const args = muxArgs({ video: 'in.webm', audio: 'voice.wav', out: 'out.webm' });
  const at = (name) => args[args.indexOf(name) + 1];
  assert.equal(at('-c:v'), 'copy', 'the picture is never re-encoded by the mux');
  assert.equal(at('-c:a'), 'libopus');
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '0:v:0', '-map', '1:a:0']);
  // `apad` makes the audio infinite; `-shortest` then ends the output with the
  // video. Without the pad, a 1 s line over a 5 s recording would truncate it.
  assert.ok(args.includes('apad'));
  assert.ok(args.includes('-shortest'));
  assert.ok(args.indexOf('-shortest') > args.indexOf('apad'));
  assert.equal(args.at(-1), 'out.webm');
});

test('a real ffmpeg muxes an Opus track into a VP9 webm and keeps the video length', async () => {
  const ffmpeg = await findMuxFfmpeg();
  if (!ffmpeg) return; // Hosts without a system ffmpeg: the hint above says why this is required.
  assert.ok(await probeOpus({ ffmpeg }), 'the system ffmpeg has libopus');

  const dir = await temp();
  const video = path.join(dir, 'in.webm');
  const audio = path.join(dir, 'voice.wav');
  const out = path.join(dir, 'out.webm');

  // Two seconds of video, one second of voice: `apad` + `-shortest` must keep
  // the two-second picture rather than ending it when the voice stops.
  await runCommand(ffmpeg, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10',
    '-t', '2', '-c:v', 'libvpx-vp9', '-b:v', '50k',
    video,
  ]);
  await writeFile(audio, writeWav(samples(1_000, 900)));

  await muxNarration({ ffmpeg, video, audio, out });

  const probe = JSON.parse(
    (
      await runCommand(ffprobePath(), [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name:format=duration',
        '-of', 'json',
        out,
      ])
    ).stdout,
  );
  const kinds = probe.streams.map((stream) => `${stream.codec_type}:${stream.codec_name}`);
  assert.ok(kinds.includes('video:vp9'), `the video stream is copied, not re-encoded (${kinds.join(', ')})`);
  assert.ok(kinds.includes('audio:opus'), `the audio stream is Opus (${kinds.join(', ')})`);
  const duration = Number(probe.format.duration);
  assert.ok(duration > 1.7 && duration < 2.4, `the picture still ends where it did, not at the voice (${duration}s)`);

  // And the original is untouched: the mux wrote beside it.
  assert.ok((await readFile(video)).length > 0);
});

test('a failing mux leaves the original file alone', async () => {
  const dir = await temp();
  const video = path.join(dir, 'in.webm');
  const out = path.join(dir, 'out.webm');
  await writeFile(video, 'pretend this is a webm');
  await writeFile(out, 'half-written');
  await assert.rejects(
    () => muxNarration({ ffmpeg: '/bin/false', video, audio: 'x', out, run: async () => { throw new NarrationError('boom'); } }),
    /boom/,
  );
  assert.equal(await readFile(video, 'utf8'), 'pretend this is a webm');
});

/** ffprobe beside the ffmpeg that was found, so a Homebrew pair stays a pair. */
function ffprobePath() {
  const ffmpeg = process.env.FFMPEG_PATH;
  if (ffmpeg) return path.join(path.dirname(ffmpeg), 'ffprobe');
  return 'ffprobe';
}

/* ------------------------------------------------------------------ *
 * The captions follow the voice
 * ------------------------------------------------------------------ */

test('a narrated step subtitles the speech, and leaves the pill its own caption', () => {
  const timeline = {
    tutorial: 'demo',
    seed: 'unit',
    steps: [
      { index: 1, page: 1, startMs: 0, endMs: 4_000, caption: 'Sign in.', say: 'Sign in with the account you already have.' },
      { index: 2, page: 1, startMs: 4_000, endMs: 8_000, caption: 'Check the box & continue.' },
    ],
    videos: [{ file: 'video/01-main.webm', page: 1, recordingStartMs: 0 }],
  };
  const cues = cuesForRecording(timeline, { page: 1, recordingStartMs: 0 });

  // The subtitle transcribes the voice, so it is usable with the sound off…
  assert.equal(cues[0].text, 'Sign in with the account you already have.');
  assert.equal(cues[0].spoken, 'Sign in with the account you already have.');
  // …while the pill, drawn by the humanizer from `caption`, is never touched here.
  assert.equal(timeline.steps[0].caption, 'Sign in.');

  // A step with no `say` is unchanged: the cue is its caption, escaped.
  assert.equal(cues[1].text, 'Check the box &amp; continue.');
  assert.equal(cues[1].spoken, 'Check the box & continue.');
});

test('a silent copy subtitles the caption, not a line nobody says', () => {
  const timeline = {
    tutorial: 'demo',
    seed: 'unit',
    steps: [
      { index: 1, page: 1, startMs: 0, endMs: 4_000, caption: 'Sign in.', say: 'Sign in with the account you already have.' },
      { index: 2, page: 1, startMs: 4_000, endMs: 8_000, caption: 'Check the box & continue.' },
    ],
    videos: [{ file: 'video/01-main.webm', page: 1, recordingStartMs: 0 }],
  };
  // `--no-narration` produces a silent recording, so its captions have to be the
  // text on screen: a `.vtt` transcribing a `say` that was never spoken is a
  // track that lies about the audio.
  const cues = cuesForRecording(timeline, { page: 1, recordingStartMs: 0 }, { narrated: false });
  assert.equal(cues[0].text, 'Sign in.');
  assert.equal(cues[0].spoken, null);
  assert.equal(cues[1].text, 'Check the box &amp; continue.');
  // The narrated reading of the same timeline is still the voice, so the two
  // modes are a flag apart rather than two code paths.
  assert.equal(cuesForRecording(timeline, { page: 1, recordingStartMs: 0 })[0].text, 'Sign in with the account you already have.');
});

test('the shipped schema allows a `say`-only step, like the validator does', async () => {
  // The two descriptions of the plan are read by different tools: the runtime
  // accepts a step whose only job is to speak, and an editor validating against
  // `plans/schema.json` must not call that same plan invalid.
  const schema = JSON.parse(await readFile(new URL('../plans/schema.json', import.meta.url), 'utf8'));
  const required = schema.$defs.step.anyOf.map((branch) => branch.required?.[0]);
  assert.ok(required.includes('say'), `the step anyOf lists action keys, and "say" is missing: ${required.join(', ')}`);
  // Both descriptions must also agree that `caption` alone is not an action.
  assert.equal(required.includes('caption'), false);
});
