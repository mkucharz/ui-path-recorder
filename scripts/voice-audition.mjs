#!/usr/bin/env node
/**
 * Render the same walkthrough script several ways, so the choice is made by ear.
 *
 * The copy is the part of narration no code can judge: "Choose Sign in." is a
 * correct sentence and a bad thing to say out loud. This script speaks a handful
 * of registers of the same six steps, with the model and delivery settings that
 * change how they land, and writes one page with a player per variant.
 *
 * Audio only, on purpose. A narrated video is a minute of browser work per
 * variant; the words, the model and the settings are what is being chosen, and
 * those take seconds. The winner is recorded on video once, afterwards.
 *
 *   node scripts/voice-audition.mjs [--out <dir>] [--only <id>]
 *
 * The key is `ELEVENLABS_API_KEY` — from the environment, or from the gitignored
 * `.env` in the working directory (see `.env.example`), which this loads itself.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ELEVENLABS_API_URL,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_DEFAULT_VOICE,
  SAMPLE_RATE,
  elevenLabsRequest,
  elevenLabsSupportsStitching,
  loadDotEnv,
  pcmMs,
  writeWav,
} from '../lib/narration.mjs';

const flag = (name, fallback = null) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? null);
};

const OUT = path.resolve(flag('--out', `captures/audition-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}`));
const ONLY = flag('--only');
const GAP_MS = 400;

/**
 * The six steps of the sign-in walkthrough, written four ways.
 *
 * `caption` in the plan stays as it is — the pill is read, not heard. These are
 * the `say` lines: what a person would actually tell you while showing you.
 */
const COPIES = {
  baseline: {
    title: 'Current copy — the caption read aloud',
    why: 'What ships today. Correct, terse, and shaped like a label.',
    lines: [
      'Open the sign-in page for your workspace.',
      'Sign in with the address and password you already use.',
      'Type the email address on your account.',
      'Then the password.',
      'Choose Sign in.',
      'You land in your workspace, signed in.',
    ],
  },
  warm: {
    title: 'A — a colleague showing you',
    why: 'Contractions, "let\'s", and a closing that lands instead of reporting.',
    lines: [
      "Let's start by opening the sign-in page for your workspace.",
      "You'll sign in the same way you always do — with your email and password.",
      'Go ahead and type the email address on your account.',
      'Then your password.',
      'And choose Sign in.',
      "That's it — you're in your workspace.",
    ],
  },
  quiet: {
    title: 'B — the quiet expert',
    why: 'Short complete sentences, no fuss, still spoken rather than printed.',
    lines: [
      'Open the sign-in page for your workspace.',
      'Use the same email and password you already sign in with.',
      'Start with your email address.',
      'Then the password.',
      'Choose Sign in.',
      'Your workspace opens, already signed in.',
    ],
  },
  tutorial: {
    title: 'C — spoken tutorial',
    why: 'One clause of why per step; long enough to fill the silence.',
    lines: [
      "First, let's open the sign-in page for your workspace.",
      "You'll use the same email and password as always — nothing new to remember.",
      'Start with the email address tied to your account.',
      'Then type your password.',
      "Press Sign in when you're ready.",
      "And you're in — your workspace opens already signed in.",
    ],
  },
  tagged: {
    title: 'D — C with delivery tags',
    why: 'v3 audio tags. Are they performed, or read out loud?',
    lines: [
      "[warmly] First, let's open the sign-in page for your workspace.",
      "You'll use the same email and password as always — nothing new to remember.",
      'Start with the email address tied to your account.',
      'Then type your password.',
      "Press Sign in when you're ready.",
      "[warmly] And you're in — your workspace opens already signed in.",
    ],
  },
};

/** Adam, the premade default; George is the other voice this account can reach. */
const ADAM = ELEVENLABS_DEFAULT_VOICE.id;
const GEORGE = 'JBFqnCBsd6RMkjVDRZzb';

/**
 * One variant per question worth asking.
 *
 * The first row is the control: today's copy with today's settings. Then the
 * copy registers at fixed settings, so only the words move; then the settings on
 * the winning register, so only the delivery moves; then the voice.
 */
const VARIANTS = [
  { id: '01-baseline', copy: 'baseline', voice: ADAM, note: 'control: what ships today, no stitching' },
  { id: '02-warm', copy: 'warm', voice: ADAM, stability: 0.45, stitch: true },
  { id: '03-quiet', copy: 'quiet', voice: ADAM, stability: 0.45, stitch: true },
  { id: '04-tutorial', copy: 'tutorial', voice: ADAM, stability: 0.45, stitch: true },
  { id: '05-tutorial-default-stability', copy: 'tutorial', voice: ADAM, stability: 0.5, stitch: true },
  { id: '06-tutorial-george', copy: 'tutorial', voice: GEORGE, stability: 0.45, stitch: true },
  { id: '07-tutorial-v3', copy: 'tutorial', voice: ADAM, stability: 0.45, stitch: true, model: 'eleven_v3' },
  { id: '08-tagged-v3', copy: 'tagged', voice: ADAM, stability: 0.45, stitch: true, model: 'eleven_v3' },
];

const dotenv = await loadDotEnv();
if (dotenv.loaded) process.stdout.write(`  env: loaded ${path.basename(dotenv.loaded)}\n`);
// Every reason that is not simply "there is none" or "already exported": an old
// Node cannot read a `.env` at all and a malformed one is not loaded, and both
// would otherwise be reported below as a missing key — about a file that is there.
else if (dotenv.reason && !['no .env', 'ELEVENLABS_API_KEY is already set'].includes(dotenv.reason)) {
  process.stderr.write(`  env: ${dotenv.reason}\n`);
}
const key = (process.env.ELEVENLABS_API_KEY ?? '').trim();
if (!key) {
  console.error('voice-audition needs ELEVENLABS_API_KEY — put it in .env (see .env.example) or export it');
  process.exit(2);
}
const apiUrl = ((process.env.ELEVENLABS_API_URL ?? '').trim() || ELEVENLABS_API_URL).replace(/\/+$/, '');

/**
 * One line, as the engine will be asked for it.
 *
 * `previous_text`/`next_text` are what keep a line from arriving cold: the model
 * sees the sentence before and after, so the cadence continues across requests
 * instead of restarting at every step. `apply_text_normalization: 'on'` stops a
 * "7 days" from being read as digits.
 */
async function speak({ text, voice, model, stability, style = 0, previous, next, speed = 1 }) {
  // The production builder, so an audition asks for exactly what a recording
  // will: if the request shape changes, this changes with it.
  const { url, init } = elevenLabsRequest({
    apiUrl,
    voiceId: voice,
    key,
    text,
    model,
    speed,
    voiceSettings: { stability, style },
    previousText: previous ?? null,
    nextText: next ?? null,
  });

  const response = await fetch(url, init);
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let detail = raw;
    try {
      detail = JSON.parse(raw)?.detail?.message ?? raw;
    } catch {
      // Not JSON: the body is the message.
    }
    throw new Error(`HTTP ${response.status}: ${String(detail).slice(0, 240)}`);
  }
  const type = String(response.headers.get('content-type') ?? '');
  if (!/^audio\/pcm\b/i.test(type)) throw new Error(`answered ${type || 'no content type'}, not audio/pcm`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const pcm = bytes.length % 2 ? bytes.subarray(0, bytes.length - 1) : bytes;
  if (!pcm.length) throw new Error('no audio came back');
  return pcm;
}

const silence = (ms) => Buffer.alloc(Math.round((ms / 1_000) * SAMPLE_RATE) * 2);

function wavDuration(pcm) {
  return pcmMs(pcm, SAMPLE_RATE);
}

const html = (variants) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>narration audition — ui-path-recorder</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0 auto; max-width: 62rem; padding: 2.5rem 1.5rem 5rem;
         background: #0f1116; color: #e6e8ee;
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
  p.lede { color: #9aa3b2; margin: 0 0 2.5rem; }
  section { border-top: 1px solid #232735; padding: 1.4rem 0 1.6rem; }
  h2 { font-size: 1.05rem; margin: 0 0 .2rem; }
  .meta { color: #8b94a6; font-size: .82rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .why { color: #b6bdcb; margin: .5rem 0 .9rem; }
  audio { width: 100%; margin: .3rem 0 .6rem; }
  details summary { cursor: pointer; color: #8b94a6; font-size: .85rem; }
  ol { color: #c3cad6; font-size: .9rem; }
  .fail { color: #ff9b9b; }
</style></head><body>
<h1>Narration audition</h1>
<p class="lede">The same six sign-in steps, spoken several ways. Audio only — the copy, the model and the delivery are what is being chosen.</p>
${variants
  .map(
    (v) => `<section>
  <h2>${v.title}</h2>
  <div class="meta">${v.model} · ${v.voiceName ?? v.voice} · stability ${v.stability} · stitching ${v.stitch ? 'on' : 'off'} · ${(v.ms / 1000).toFixed(1)}s</div>
  ${v.why ? `<p class="why">${v.why}</p>` : ''}
  ${v.file ? `<audio controls preload="metadata" src="${v.file}"></audio>` : `<p class="fail">${v.error}</p>`}
  <details><summary>the words</summary><ol>${v.lines.map((line) => `<li>${line.replace(/</g, '&lt;')}</li>`).join('')}</ol></details>
</section>`,
  )
  .join('\n')}
</body></html>
`;

/**
 * The `eleven_v3` family refuses `previous_text`/`next_text` outright ("not yet
 * supported with the 'eleven_v3' model", HTTP 400), so stitching is per-model
 * rather than per-variant: asking for it anyway would fail every line of the run.
 * `eleven_v4` accepts them — the repository's own predicate is the authority, not
 * a list written here, so this asks it rather than guessing.
 */
const stitches = (variant, model) => Boolean(variant.stitch) && elevenLabsSupportsStitching(model);

const picked = VARIANTS.filter((variant) => !ONLY || variant.id === ONLY || variant.copy === ONLY);
if (!picked.length) {
  console.error(`no variant matches ${JSON.stringify(ONLY)} — try: ${VARIANTS.map((v) => v.id).join(', ')}`);
  process.exit(2);
}

await mkdir(OUT, { recursive: true });
console.log(`  audition: ${picked.length} variant(s) → ${OUT}\n`);

const rendered = [];
for (const variant of picked) {
  const copy = COPIES[variant.copy];
  const model = variant.model ?? ELEVENLABS_DEFAULT_MODEL;
  const stability = variant.stability ?? 0.5;
  const stitched = stitches(variant, model);
  const head = `${variant.id}  ${model}  stability ${stability}  ${stitched ? 'stitched' : 'unstitched'}`;
  process.stdout.write(`  ${head}\n`);
  const parts = [];
  let failed = null;
  for (const [index, text] of copy.lines.entries()) {
    try {
      const pcm = await speak({
        text,
        voice: variant.voice,
        model,
        stability,
        previous: stitched ? copy.lines[index - 1] : undefined,
        next: stitched ? copy.lines[index + 1] : undefined,
      });
      if (parts.length) parts.push(silence(GAP_MS));
      parts.push(pcm);
      process.stdout.write(`    ${String(index + 1).padStart(2)}/${copy.lines.length}  ${(wavDuration(pcm) / 1000).toFixed(1)}s  ${text.slice(0, 52)}\n`);
    } catch (error) {
      failed = { line: index + 1, message: error.message };
      break;
    }
  }
  const track = Buffer.concat(parts);
  const file = failed ? null : `${variant.id}.wav`;
  if (file) await writeFile(path.join(OUT, file), writeWav(track));
  rendered.push({
    id: variant.id,
    title: copy.title,
    why: copy.why,
    lines: copy.lines,
    model,
    voice: variant.voice,
    voiceName: variant.voice === ADAM ? 'Adam' : variant.voice === GEORGE ? 'George' : null,
    stability,
    stitch: stitched,
    ms: wavDuration(track),
    file,
    error: failed ? `line ${failed.line}: ${failed.message}` : null,
  });
  if (failed) process.stdout.write(`    failed on line ${failed.line}: ${failed.message}\n`);
  process.stdout.write('\n');
}

await writeFile(path.join(OUT, 'index.html'), html(rendered));
await writeFile(
  path.join(OUT, 'variants.json'),
  `${JSON.stringify(rendered.map(({ id, model, voice, stability, stitch, ms }) => ({ id, model, voice, stability, stitch, ms })), null, 2)}\n`,
);
console.log(`  page: ${path.join(OUT, 'index.html')}`);
// The page is plain HTML with relative WAV paths, so opening the file works. The
// server is for a host with no desktop browser to open it with.
console.log(`  open it directly, or serve the folder: python3 -m http.server 8142 --directory ${OUT}\n`);
