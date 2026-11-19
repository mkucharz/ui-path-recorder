/**
 * The ElevenLabs engine, without an account.
 *
 * Everything here drives the two seams the engine has: the request it builds and
 * the HTTP response it parses. A local server answers with the same bytes the
 * real API sends (`output_format=pcm_48000` is raw 16-bit mono at 48 kHz), so
 * the pipeline can be asserted to the millisecond without a key, a network or a
 * cent of credit — and the error mapping can be exercised for the statuses a
 * real key produces at least once (a scoped key, a free workspace, a rate limit).
 *
 * What no test here can prove is that the voice sounds right. That needs the
 * real service, and the README says so.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_DEFAULT_VOICE,
  NarrationError,
  SAMPLE_RATE,
  elevenLabsRequest,
  elevenLabsSpeed,
  elevenLabsSupportsStitching,
  elevenLabsVoiceSettings,
  loadDotEnv,
  looksLikeVoiceId,
  narrationKey,
  pcmMs,
  resolveElevenLabsVoice,
  synthesizeElevenLabs,
} from '../lib/narration.mjs';

/** Raw PCM, as `output_format=pcm_48000` returns it: 16-bit mono, no header. */
const pcm = (ms) => Buffer.alloc(Math.round((ms / 1_000) * SAMPLE_RATE) * 2);

/**
 * A stand-in for the ElevenLabs API.
 *
 * `handler` gets the request, its parsed body and the recorded list, and writes
 * the response itself; every call is kept so a test can assert what was sent as
 * well as what came back.
 */
async function startApi(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const entry = { method: request.method, url: request.url, headers: request.headers, body };
      requests.push(entry);
      handler({ request, response, entry, requests });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const temp = () => mkdtemp(path.join(os.tmpdir(), 'narration-elevenlabs-'));

test('a rate becomes the speed the API accepts, clamped and reported', () => {
  assert.deepEqual(elevenLabsSpeed(180), { speed: 1, wanted: 1, clamped: false });
  assert.deepEqual(elevenLabsSpeed(216), { speed: 1.2, wanted: 1.2, clamped: false });
  assert.deepEqual(elevenLabsSpeed(100), { speed: 0.7, wanted: 0.56, clamped: true });
  assert.deepEqual(elevenLabsSpeed(300), { speed: 1.2, wanted: 1.67, clamped: true });
  // 0.7 and 1.2 are inclusive: a boundary is not "clamped" rounding noise.
  assert.equal(elevenLabsSpeed(126).clamped, false);
  assert.equal(elevenLabsSpeed(126).speed, 0.7);
});

test('a voice id is recognised by its shape, so a scoped key needs no listing', () => {
  assert.equal(looksLikeVoiceId(ELEVENLABS_DEFAULT_VOICE.id), true);
  assert.equal(looksLikeVoiceId('EXAVITQu4vr4xnSDxMaL'), true);
  assert.equal(looksLikeVoiceId('Adam'), false);
  assert.equal(looksLikeVoiceId('Ava (Premium)'), false);
  assert.equal(looksLikeVoiceId(''), false);
  assert.equal(looksLikeVoiceId(null), false);
});

test('the request carries the text, the model, the delivery and the neighbours', () => {
  const { url, init } = elevenLabsRequest({
    apiUrl: 'https://api.example.test/',
    voiceId: 'pNInz6obpgDQGcFmaJgB',
    key: 'test-key',
    text: 'Open the sign-in page.',
    model: ELEVENLABS_DEFAULT_MODEL,
    speed: 1.1,
    voiceSettings: { stability: 0.35 },
    previousText: 'Press Sign in when you are ready.',
    nextText: 'Type your email address.',
  });
  assert.equal(url, 'https://api.example.test/v1/text-to-speech/pNInz6obpgDQGcFmaJgB?output_format=pcm_48000');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['xi-api-key'], 'test-key');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers.accept, 'audio/pcm');
  assert.deepEqual(JSON.parse(init.body), {
    text: 'Open the sign-in page.',
    model_id: ELEVENLABS_DEFAULT_MODEL,
    apply_text_normalization: 'on',
    previous_text: 'Press Sign in when you are ready.',
    next_text: 'Type your email address.',
    voice_settings: {
      stability: 0.35,
      similarity_boost: 0.75,
      style: 0,
      use_speaker_boost: true,
      speed: 1.1,
    },
  });
});

test('a dialogue model is sent no neighbours, because it answers 400 for them', () => {
  const { init } = elevenLabsRequest({
    voiceId: 'v'.repeat(20),
    key: 'k',
    text: 'Hello.',
    model: 'eleven_v3',
    previousText: 'Before.',
    nextText: 'After.',
  });
  const body = JSON.parse(init.body);
  assert.equal(body.previous_text, undefined, 'eleven_v3 does not take previous_text');
  assert.equal(body.next_text, undefined, 'eleven_v3 does not take next_text');
  // Everything else still applies: only the continuity is lost, not the delivery.
  assert.equal(body.apply_text_normalization, 'on');
  assert.equal(body.voice_settings.stability, 0.5);
});

test('stitching is per model: the eleven_v3 family refuses neighbours, eleven_v4 does not', () => {
  assert.equal(elevenLabsSupportsStitching('eleven_multilingual_v2'), true);
  assert.equal(elevenLabsSupportsStitching('eleven_turbo_v2_5'), true);
  // The dialogue models answer 400 with `unsupported_model` — verified against the
  // live API for all three of these, not inferred from the name.
  assert.equal(elevenLabsSupportsStitching('eleven_v3'), false);
  assert.equal(elevenLabsSupportsStitching('eleven_v3_conversational'), false);
  assert.equal(elevenLabsSupportsStitching('eleven_v3_directorial'), false);
  // eleven_v4 takes them (200 with both set), so a "v3 or v4" match would drop
  // continuity the API is happy to use.
  assert.equal(elevenLabsSupportsStitching('eleven_v4'), true);
  assert.equal(elevenLabsSupportsStitching(null), true, 'the default model stitches');
  // A model nobody has shipped yet is assumed to stitch: the fallback is a warning
  // and a poorer cadence, not a failed run.
  assert.equal(elevenLabsSupportsStitching('eleven_v3_turbo'), false);
  assert.equal(elevenLabsSupportsStitching('eleven_v5'), true);
});

test('the delivery settings default to the service defaults, fully spelled out', () => {
  assert.deepEqual(elevenLabsVoiceSettings({ speed: 1 }), {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0,
    use_speaker_boost: true,
    speed: 1,
  });
  assert.deepEqual(elevenLabsVoiceSettings({ speed: 0.9, stability: 0.3, speakerBoost: false }), {
    stability: 0.3,
    similarity_boost: 0.75,
    style: 0,
    use_speaker_boost: false,
    speed: 0.9,
  });
  // The plan's spelling is camelCase; the body's is the API's.
  assert.equal(elevenLabsVoiceSettings({ similarityBoost: 0.4 }).similarity_boost, 0.4);
});

test('a line is fetched once, stored as a WAV, and served from the cache after', async (t) => {
  const api = await startApi(({ response }) => {
    response.writeHead(200, { 'content-type': 'audio/pcm' });
    response.end(pcm(1_500));
  });
  t.after(() => api.close());
  const dir = await temp();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await synthesizeElevenLabs({
    apiUrl: api.url,
    key: 'test-key',
    voiceId: 'pNInz6obpgDQGcFmaJgB',
    text: 'Type the email address.',
    dir,
  });
  assert.equal(first.cached, false);
  assert.equal(first.sampleRate, SAMPLE_RATE);
  assert.equal(first.channels, 1);
  assert.equal(first.ms, 1_500);
  assert.equal(pcmMs(first.pcm), 1_500);
  assert.match(api.requests[0].url, /output_format=pcm_48000$/);

  const second = await synthesizeElevenLabs({
    apiUrl: api.url,
    key: 'test-key',
    voiceId: 'pNInz6obpgDQGcFmaJgB',
    text: 'Type the email address.',
    dir,
  });
  assert.equal(second.cached, true);
  assert.equal(second.ms, 1_500);
  assert.equal(api.requests.length, 1, 'a cached line is not paid for twice');
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.wav')).length, 1);
  assert.equal((await readdir(dir)).some((name) => name.includes('.part')), false, 'no half-written line is left');
});

test('the same words in two engines are two recordings, not one cache hit', () => {
  const say = narrationKey({ text: 'Hello.', voice: 'Ava', rate: 180 });
  const eleven = narrationKey({ text: 'Hello.', voice: 'Ava', rate: 180, engine: 'elevenlabs', model: 'm1' });
  const otherModel = narrationKey({ text: 'Hello.', voice: 'Ava', rate: 180, engine: 'elevenlabs', model: 'm2' });
  assert.notEqual(say, eleven);
  assert.notEqual(eleven, otherModel);
  // The say key is untouched, so an existing cache survives the upgrade.
  assert.equal(say, narrationKey({ text: 'Hello.', voice: 'Ava', rate: 180, engine: 'say' }));
});

/**
 * Delivery and neighbours are part of what comes back, so they are part of the
 * key. Without this a plan that lowers `stability` replays yesterday's audio and
 * reports it as a cache hit — a setting that silently does nothing.
 */
test('a delivery change or a neighbouring sentence is a different recording', () => {
  const base = { text: 'Hello.', voice: 'v'.repeat(20), rate: 1, engine: 'elevenlabs', model: 'm1' };
  const quiet = narrationKey({ ...base, settings: { stability: 0.3 } });
  const steady = narrationKey({ ...base, settings: { stability: 0.6 } });
  assert.notEqual(quiet, steady);
  assert.equal(quiet, narrationKey({ ...base, settings: { stability: 0.3 } }), 'the same settings are the same key');

  const first = narrationKey({ ...base, context: [null, 'Second.'] });
  const after = narrationKey({ ...base, context: ['Before.', 'Second.'] });
  assert.notEqual(first, after, 'the sentence before this one changes the reading');
  assert.notEqual(narrationKey({ ...base, context: ['Before.', null] }), first);
});

test('a truncated last sample is dropped, not padded into a click', async (t) => {
  const api = await startApi(({ response }) => {
    const bytes = pcm(100);
    response.writeHead(200, { 'content-type': 'audio/pcm' });
    response.end(Buffer.concat([bytes, Buffer.from([0x7f])]));
  });
  t.after(() => api.close());
  const dir = await temp();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const line = await synthesizeElevenLabs({ apiUrl: api.url, key: 'k', voiceId: 'v'.repeat(20), text: 'Hi.', dir });
  assert.equal(line.pcm.length % 2, 0);
  assert.equal(line.ms, 100);
});

test('an empty answer is an error, not a silent line', async (t) => {
  const api = await startApi(({ response }) => {
    response.writeHead(200, { 'content-type': 'audio/pcm' });
    response.end(Buffer.alloc(0));
  });
  t.after(() => api.close());
  const dir = await temp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    synthesizeElevenLabs({ apiUrl: api.url, key: 'k', voiceId: 'v'.repeat(20), text: 'Hi.', dir }),
    /returned no audio/,
  );
  assert.deepEqual(await readdir(dir), [], 'nothing is cached for a line that never came back');
});

test('a response that is not audio/pcm is refused, because compressed bytes read as PCM are noise', async (t) => {
  const api = await startApi(({ response }) => {
    response.writeHead(200, { 'content-type': 'audio/mpeg' });
    response.end(Buffer.alloc(128));
  });
  t.after(() => api.close());
  const dir = await temp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    synthesizeElevenLabs({ apiUrl: api.url, key: 'k', voiceId: 'v'.repeat(20), text: 'Hi.', dir }),
    /not audio\/pcm/,
  );
});

test('a free workspace sent at a library voice is told what to do instead', async (t) => {
  const api = await startApi(({ response }) => {
    json(response, 402, {
      detail: {
        type: 'payment_required',
        code: 'paid_plan_required',
        message: 'Free users cannot use library voices via the API. Please upgrade your subscription to use this voice.',
      },
    });
  });
  t.after(() => api.close());
  const dir = await temp();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    synthesizeElevenLabs({ apiUrl: api.url, key: 'k', voiceId: '21m00Tcm4TlvDq8ikWAM', text: 'Hi.', dir }),
    (error) => {
      assert.ok(error instanceof NarrationError);
      assert.match(error.message, /HTTP 402 \(paid_plan_required\)/);
      assert.match(error.message, /cannot use library voices/);
      assert.match(error.message, new RegExp(ELEVENLABS_DEFAULT_VOICE.id), 'names a voice that does work');
      return true;
    },
  );
});

test('a key without voices_read is told to pass an id, not to retry a name', async (t) => {
  const api = await startApi(({ response }) => {
    json(response, 401, {
      detail: {
        type: 'authentication_error',
        code: 'unauthorized',
        message: 'The API key you used is missing the permission voices_read to execute this operation.',
      },
    });
  });
  t.after(() => api.close());

  await assert.rejects(
    resolveElevenLabsVoice({ voice: 'Adam', env: { ELEVENLABS_API_KEY: 'k' }, apiUrl: api.url }),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /pass a voice id instead/, 'names the way out');
      return true;
    },
  );
});

test('a rate limit and an unreachable host are reported as themselves', async (t) => {
  const api = await startApi(({ response }) => json(response, 429, { detail: { type: 'too_many_requests', message: 'slow down' } }));
  t.after(() => api.close());
  const dir = await temp();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    synthesizeElevenLabs({ apiUrl: api.url, key: 'k', voiceId: 'v'.repeat(20), text: 'Hi.', dir }),
    /HTTP 429.*Rate limited/,
  );
  await assert.rejects(
    synthesizeElevenLabs({ apiUrl: 'http://127.0.0.1:1', key: 'k', voiceId: 'v'.repeat(20), text: 'Hi.', dir }),
    /cannot reach ElevenLabs/,
  );
});

test('no key is refused before a request, with the environment variable named', async () => {
  await assert.rejects(
    synthesizeElevenLabs({ apiUrl: 'http://127.0.0.1:1', key: '', voiceId: 'v'.repeat(20), text: 'Hi.', dir: os.tmpdir() }),
    /ELEVENLABS_API_KEY/,
  );
});

test('a voice id is used as given, with no listing request at all', async (t) => {
  const api = await startApi(({ response }) => json(response, 200, { voices: [] }));
  t.after(() => api.close());
  const voice = await resolveElevenLabsVoice({ voice: 'pNInz6obpgDQGcFmaJgB', env: { ELEVENLABS_API_KEY: 'k' }, apiUrl: api.url });
  assert.deepEqual(voice, { id: 'pNInz6obpgDQGcFmaJgB', name: null, source: 'plan' });
  assert.equal(api.requests.length, 0, 'an id needs no permission beyond text-to-speech');
});

test('a voice name is resolved once, against the voices this key can see', async (t) => {
  const api = await startApi(({ request, response }) => {
    assert.equal(request.url, '/v1/voices');
    assert.equal(request.headers['xi-api-key'], 'k');
    json(response, 200, {
      voices: [
        { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' },
        { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' },
      ],
    });
  });
  t.after(() => api.close());
  const voice = await resolveElevenLabsVoice({ voice: 'sarah', env: { ELEVENLABS_API_KEY: 'k' }, apiUrl: api.url });
  assert.deepEqual(voice, { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', source: 'name' });
});

test('an unknown voice name lists what the key can see, and suggests an id', async (t) => {
  const api = await startApi(({ response }) =>
    json(response, 200, { voices: [{ voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' }] }),
  );
  t.after(() => api.close());
  await assert.rejects(
    resolveElevenLabsVoice({ voice: 'Nobody', env: { ELEVENLABS_API_KEY: 'k' }, apiUrl: api.url }),
    /no ElevenLabs voice is named "Nobody" \(this key sees: Adam\).*Pass a voice id/,
  );
});

test('the voice defaults are the plan, then the environment, then a premade voice', async () => {
  const fromEnv = await resolveElevenLabsVoice({ voice: null, env: { ELEVENLABS_VOICE_ID: 'EXAVITQu4vr4xnSDxMaL' } });
  assert.deepEqual(fromEnv, { id: 'EXAVITQu4vr4xnSDxMaL', name: null, source: 'env' });

  const planWins = await resolveElevenLabsVoice({
    voice: 'pNInz6obpgDQGcFmaJgB',
    env: { ELEVENLABS_VOICE_ID: 'EXAVITQu4vr4xnSDxMaL' },
  });
  assert.equal(planWins.id, 'pNInz6obpgDQGcFmaJgB');

  const fallback = await resolveElevenLabsVoice({ voice: null, env: {} });
  assert.deepEqual(fallback, { ...ELEVENLABS_DEFAULT_VOICE, source: 'default' });
  // A default that a free workspace cannot use would be a default nobody can try.
  assert.equal(looksLikeVoiceId(fallback.id), true);
});

/**
 * The key comes from a file, because the alternative is a key typed into a shell
 * history, a chat message or a CI log. What is asserted here is only the seam:
 * the file is read, the environment wins over it, and nothing prints a value.
 */
test('a gitignored .env supplies the key, and the environment still wins', async (t) => {
  const dir = await temp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, '.env'), 'ELEVENLABS_API_KEY=from-file\nSIGNIN_URL=http://from-file.test\n');

  const before = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  t.after(() => {
    if (before === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = before;
  });

  const loaded = await loadDotEnv({ cwd: dir });
  assert.equal(loaded.loaded, path.join(dir, '.env'));
  assert.equal(process.env.ELEVENLABS_API_KEY, 'from-file');
  assert.equal(process.env.SIGNIN_URL, 'http://from-file.test');

  // A variable already set is not replaced: a one-off override stays an override.
  const again = await loadDotEnv({ cwd: dir });
  assert.equal(again.loaded, null);
  assert.match(again.reason, /already set/);
  assert.equal(process.env.ELEVENLABS_API_KEY, 'from-file');
});

test('a missing .env is not an error, it is just nothing to load', async (t) => {
  const dir = await temp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  // No key in the environment either, or the answer is "already set" — which is a
  // different (and correct) statement, not the one under test.
  const before = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  t.after(() => {
    if (before !== undefined) process.env.ELEVENLABS_API_KEY = before;
  });
  const result = await loadDotEnv({ cwd: dir });
  assert.equal(result.loaded, null);
  assert.equal(result.reason, 'no .env');
});

test('a Node too old to read a .env says so, rather than reporting no key', async (t) => {
  const dir = await temp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, '.env'), 'ELEVENLABS_API_KEY=from-file\n');

  const beforeKey = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  // `process.loadEnvFile` arrived in Node 20.12, and `package.json` accepts 20.0 —
  // on those two releases a `.env` that is sitting right there is invisible, which
  // from the outside is indistinguishable from a wrong key. The reason is the only
  // thing that tells them apart, so it names the version requirement.
  const loadEnvFile = process.loadEnvFile;
  delete process.loadEnvFile;
  t.after(() => {
    process.loadEnvFile = loadEnvFile;
    if (beforeKey !== undefined) process.env.ELEVENLABS_API_KEY = beforeKey;
  });

  const result = await loadDotEnv({ cwd: dir });
  assert.equal(result.loaded, null);
  assert.match(result.reason, /20\.12/);
  assert.match(result.reason, /cannot read \.env/);
});

test('the neighbours reach the body and are part of what is cached', async (t) => {
  const api = await startApi(({ response }) => {
    response.writeHead(200, { 'content-type': 'audio/pcm' });
    response.end(pcm(800));
  });
  t.after(() => api.close());
  const dir = await temp();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const speak = (previousText) =>
    synthesizeElevenLabs({
      apiUrl: api.url,
      key: 'k',
      voiceId: 'v'.repeat(20),
      text: 'And choose Sign in.',
      previousText,
      nextText: "That's it — you're in.",
      voiceSettings: { stability: 0.35 },
      dir,
    });

  const first = await speak('Then your password.');
  assert.equal(first.stitched, true);
  const body = JSON.parse(api.requests[0].body);
  assert.equal(body.previous_text, 'Then your password.');
  assert.equal(body.next_text, "That's it — you're in.");
  assert.equal(body.voice_settings.stability, 0.35);

  const cached = await speak('Then your password.');
  assert.equal(cached.cached, true);
  assert.equal(api.requests.length, 1, 'the same neighbours are the same line');

  const different = await speak('Start with your email address.');
  assert.equal(different.cached, false, 'a different line before this one is a different reading');
  assert.equal(api.requests.length, 2);
});
