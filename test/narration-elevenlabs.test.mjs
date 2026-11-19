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
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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

test('the request carries the text, the model and the speed, and asks for PCM', () => {
  const { url, init } = elevenLabsRequest({
    apiUrl: 'https://api.example.test/',
    voiceId: 'pNInz6obpgDQGcFmaJgB',
    key: 'test-key',
    text: 'Open the sign-in page.',
    model: ELEVENLABS_DEFAULT_MODEL,
    speed: 1.1,
  });
  assert.equal(url, 'https://api.example.test/v1/text-to-speech/pNInz6obpgDQGcFmaJgB?output_format=pcm_48000');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['xi-api-key'], 'test-key');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers.accept, 'audio/pcm');
  assert.deepEqual(JSON.parse(init.body), {
    text: 'Open the sign-in page.',
    model_id: ELEVENLABS_DEFAULT_MODEL,
    voice_settings: { speed: 1.1 },
  });
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
