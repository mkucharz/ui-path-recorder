#!/usr/bin/env node
/**
 * path-shots — record a path through a live UI and write documentation-quality
 * figures from it.
 *
 * Why a script and not a person with a screenshot tool: a published figure must
 * not depend on the operator's machine. The classic failure is a screenshot
 * taken in the author's own browser — their language, their theme, their
 * password manager's autofill menu, their saved account in the corner. A plan
 * pins locale, theme, viewport and device pixel ratio, runs in a throwaway
 * profile with no extensions, and *fails* when a page renders in another
 * language instead of writing a wrong picture.
 *
 *     node scripts/path-shots.mjs plans/examples/foo.plan.json --review
 *     node scripts/path-shots.mjs plans/examples/foo.plan.json --only 03-signin
 *
 * A plan is one browser session and an ordered list of steps, because a
 * walkthrough is one path through the UI: navigating, typing, clicking and
 * taking a picture at the points a reader needs to see. `--only <shot>` replays
 * the plan up to that shot and stops, which is how one stale figure is refreshed
 * without re-shooting the flow.
 *
 * Nothing here authenticates on its own: credentials come from the plan's
 * `vars`, which name environment variables (or carry a `literal` for a value a
 * figure should show but no real account should have), so no secret is committed.
 *
 * ## Flows that need a human once — `--login` and `--profile`
 *
 * Some flows cannot be driven from a plan alone because a person has to
 * authenticate first. `--profile <dir>` keeps a browser profile on the capture
 * host; `--login` opens a *visible* window on that profile for the human to sign
 * in, and the session then stays in that profile, so every later run is a plain
 * scripted run with no prompts:
 *
 *     node scripts/path-shots.mjs --login --profile .profile --login-url https://example.com/login
 *     node scripts/path-shots.mjs plan.json --profile .profile     # scripted from here on
 *
 * The profile is a capture-host file: never committed, never transferred.
 * Whatever the human signed into stays where they signed in. An expired session
 * fails loudly at the first page that needed it rather than silently capturing a
 * login form.
 *
 * `--out <dir>` writes into a fresh run directory (the default), so a run is
 * reviewable before it touches a document, and `--review` adds a `review.html`
 * contact sheet. `--video` records the whole path as a `.webm` and `--trace`
 * writes a Playwright trace you can scrub; a failure writes the page it failed
 * on — screenshot, HTML and every control's label — into `failures/`, which is
 * what makes a plan iterable without a person describing each screen.
 *
 * ## Why `--video` drives the page like a person
 *
 * A screencast of a script has no cursor, no typing and no pauses, so it reads
 * as teleporting stills. `--video` therefore turns on the humanizer
 * (lib/human.mjs): an in-page pointer, curved travel with eased velocity, a
 * hover dwell, a key-by-key cadence and a beat after each action — all from a
 * seeded generator, so `--seed` replays the same path. The pointer is a
 * depiction placed at the coordinates the runner really dispatches, it is
 * hidden before every figure and every piece of evidence, and `--no-humanize`
 * records the raw machine-speed cut instead.
 */
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createVars, loadPlan, PlanError } from '../lib/plan.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { writeReview } from '../lib/review.mjs';
import { createHuman, resolveOptions } from '../lib/human.mjs';
import { buildVtt, cuesForRecording, vttFor } from '../lib/captions.mjs';
import { cardFitWarning, cardHtml, cardOptions } from '../lib/cards.mjs';
import { NARROW_VIEWPORT, checklistOptions, checklistReserve } from '../lib/checklist.mjs';
import { createRecorder } from '../lib/recorder.mjs';
import { actionOf, createTimeline } from '../lib/timeline.mjs';

const USAGE = `usage:
  node scripts/path-shots.mjs <plan.json> [--only <shot-id>] [--out <dir>] [--review]
                                        [--profile <dir>] [--video] [--trace]
                                        [--humanize] [--no-humanize] [--seed <s>] [--speed <n>]
                                        [--video-fps <n>] [--video-size <WxH>] [--poster <shot-id>]
                                        [--vars-out <file>] [--no-trim] [--headed] [--channel <name>]
  node scripts/path-shots.mjs --login --login-url <url> [--profile <dir>] [--login-done-file <path>]

  --only <id>       replay the plan up to that shot and stop
  --out <dir>       run directory (default: captures/<tutorial>-<timestamp>)
  --review          write review.html: every figure with its size and the text it asserts,
                    plus the video with chapter links when there is one
  --profile <dir>   keep the session in a browser profile on this host (implies a visible window)
  --login           open that profile for a human to sign in, then exit
  --login-done-file an agent on another host signals "signed in" with touch <file>
  --video           record the run to <out>/video/*.webm (needs ffmpeg: npx playwright install ffmpeg)
                    and drive it like a person: pointer, curved travel, typing cadence, dwell
  --no-humanize     with --video, record the raw machine-speed cut instead
  --seed <s>        seed the humanizer (default: derived from the run stamp; logged as seed=)
  --speed <n>       scale every human delay (1 = natural, 20 = a fast test run)
  --video-fps <n>   video frame rate (default: 25)
  --video-size <WxH> shrink the video canvas (default: the viewport, so a plan that
                    pins a 1920x1080 viewport records 1080p). It must have the
                    viewport's shape and be no larger than it: Playwright never
                    scales a recording up, it pads the canvas with a band
  --poster <id>     figure to show in the player before play (default: the first frame)
  --trace           write <out>/trace.zip (open it with: npx playwright show-trace)
  --vars-out <file> keep values read by setVar (default: <out>/.vars.json, mode 600)
  --no-trim         do not crop dead space (needs no sharp)
  --channel <name>  launch a specific browser channel (chrome, msedge, chromium)
  CHROME=<path>     launch a specific browser binary instead of the bundled one

  A browser must exist: npx playwright install chromium, or CHROME=/path/to/chrome.`;

/** Flags that consume the next argument, so it is not mistaken for the plan. */
const VALUE_FLAGS = new Set([
  '--only',
  '--out',
  '--profile',
  '--channel',
  '--login-url',
  '--login-done-file',
  '--vars-out',
  '--seed',
  '--speed',
  '--video-fps',
  '--video-size',
  '--poster',
]);

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : (argv[at + 1] ?? null);
};
const has = (name) => argv.includes(name);
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));

const loginMode = has('--login');
const planPath = positional[0] ?? null;
const only = flag('--only');
const profile = flag('--profile');
const headed = has('--headed') || loginMode || Boolean(profile);
const review = has('--review');
const video = has('--video');
const trace = has('--trace');
const trim = !has('--no-trim');
const outFlag = flag('--out');
const varsOut = flag('--vars-out');
// null means "the plan decides": --video turns it on, --humanize forces it on,
// --no-humanize forces it off. Resolved after the plan is loaded.
const humanizeFlag = has('--no-humanize') ? false : has('--humanize') ? true : null;
const seedFlag = flag('--seed');
const speedFlag = flag('--speed');
const videoFps = Number(flag('--video-fps') ?? 25);
const videoSizeFlag = flag('--video-size');
const posterFlag = flag('--poster');

if (has('--help') || has('-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (!loginMode && !planPath) {
  console.error(USAGE);
  process.exit(2);
}
if (loginMode && !flag('--login-url')) {
  console.error('--login needs --login-url <url>\n\n' + USAGE);
  process.exit(2);
}
if (speedFlag !== null && (!Number.isFinite(Number(speedFlag)) || Number(speedFlag) <= 0)) {
  console.error(`--speed must be a positive number (got ${JSON.stringify(speedFlag)})`);
  process.exit(2);
}
if (!Number.isFinite(videoFps) || videoFps <= 0) {
  console.error(`--video-fps must be a positive number (got ${JSON.stringify(flag('--video-fps'))})`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// A plan is validated before a browser opens: a mistyped step key is otherwise
// a step that silently does nothing.
let plan = null;
let planErrors = null;
if (planPath) {
  try {
    const loaded = await loadPlan(planPath);
    plan = loaded.plan;
    for (const warning of loaded.warnings) console.warn(`  warning: ${warning}`);
  } catch (error) {
    planErrors = error;
  }
}

if (planErrors) {
  console.error(`\n  ${planErrors instanceof PlanError ? 'invalid plan' : 'cannot load plan'}: ${planErrors.message}\n`);
  process.exit(2);
}

const OUT = path.resolve(
  outFlag ?? path.join('captures', `${plan?.tutorial ?? plan?.instance ?? path.basename(planPath ?? 'run').replace(/\.plan\.json$/, '')}-${stamp}`),
);
const FAILED = path.join(OUT, 'failures');
const metaPath = path.join(OUT, '.shots.json');

const scale = plan?.deviceScaleFactor ?? 1;
// 1600×900, not 1600×827: a video is 16:9 (YouTube, a deck, a README embed), and
// a plan that pins no viewport inherits this frame. A plan that pins one keeps it
// — its figures were composed for that height.
const viewport = plan?.viewport ?? { width: 1600, height: 900 };
const locale = plan?.locale ?? 'en-US';
const primary = locale.split('-')[0];

/**
 * Humanization: on for a video unless told otherwise, and only if the plan did
 * not switch it off. A figure does not care how fast a click was, so a run
 * without `--video` keeps the machine-speed path — CI has no time for a 40 ms
 * keystroke cadence.
 */
const humanizeOn = humanizeFlag ?? (video || plan?.humanize?.enabled === true);
const humanOptions = resolveOptions(plan?.humanize ?? {}, { speed: speedFlag === null ? plan?.humanize?.speed : Number(speedFlag) });
// Logged, never inferred: a run you cannot replay is a video you cannot re-shoot.
const humanSeed = seedFlag ?? plan?.humanize?.seed ?? `run-${stamp}`;

/**
 * The intro and end cards, when the plan asks for any. They are recorded frames,
 * so they only exist in a `--video` run: a figure run opens on the app, never on
 * a title card.
 */
const cards = video ? cardOptions(plan, { speed: humanOptions.speed }) : null;

let page;
const fail = (step, msg) => {
  const err = new Error(msg);
  err.step = step;
  throw err;
};

/**
 * sharp is a native dependency, used only to trim uniform borders and to
 * measure a non-PNG capture. A capture host that only has to take pictures (a
 * laptop with Chrome) can leave it out, so it is loaded on demand and its
 * absence is not an error.
 */
let sharpCache;
async function sharp() {
  if (sharpCache === undefined) {
    try {
      sharpCache = (await import('sharp')).default;
    } catch {
      sharpCache = null;
    }
  }
  return sharpCache;
}

/** PNG dimensions without a dependency: IHDR carries them at bytes 16 and 20. */
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function imageSize(buffer) {
  const png = pngSize(buffer);
  if (png) return png;
  const lib = await sharp();
  if (!lib) return fail('-', 'the capture is not a PNG and sharp is unavailable to measure it');
  const meta = await lib(buffer).metadata();
  return { width: meta.width, height: meta.height };
}

/** Collapse runs of whitespace, so a guard matches words rather than DOM splits. */
const flat = (value) => String(value).replace(/\s+/g, ' ').trim();

/**
 * Where to find a browser. The launch target differs by host — a CI runner has
 * Playwright's own download, a laptop has Chrome, a container has a `chromium`
 * on PATH — so candidates are tried in order and the failure lists all of them.
 */
function launchCandidates() {
  if (process.env.CHROME) return [{ executablePath: process.env.CHROME }];
  const channel = flag('--channel');
  if (channel) return [{ channel }];
  const list = [{}];
  if (process.platform === 'darwin') list.unshift({ channel: 'chrome' });
  if (process.platform !== 'win32') {
    list.push(
      { executablePath: '/usr/local/bin/chromium' },
      { executablePath: '/usr/bin/chromium' },
      { executablePath: '/usr/bin/chromium-browser' },
      { executablePath: '/usr/bin/google-chrome' },
      { executablePath: '/usr/bin/google-chrome-stable' },
    );
  }
  return list;
}

const baseLaunch = { headless: !headed };

/**
 * The video canvas.
 *
 * Playwright fits the recorded frame *inside* the canvas without stretching it —
 * a circle stays a circle — and never scales it up. Whatever the frame does not
 * cover is filled with a solid band. So the canvas may only be the viewport's own
 * size (the default), or a *smaller* box with the viewport's exact aspect: that is
 * how a 16:9 page becomes a lighter 720p file. A larger canvas, or one of another
 * shape, is not a bigger picture — it is the page in the corner of a grey field —
 * and is refused before a browser opens, because the bad file looks like a pass.
 *
 * A 1080p upload therefore comes from the viewport, not from this flag: pin the
 * plan at 1920×1080 (16:9) and keep `deviceScaleFactor: 2` so the recording is a
 * downscale of a 2× raster. Encoders also want even dimensions, and the viewport
 * is what a document reads, so the default canvas is normalized to it.
 */
const even = (value) => Math.max(2, Math.round(value) - (Math.round(value) % 2));
const aspect = (box) => box.width / box.height;

let videoSize = { width: even(viewport.width), height: even(viewport.height) };
if (videoSizeFlag !== null) {
  const match = /^(\d+)x(\d+)$/.exec(String(videoSizeFlag).trim());
  if (!match) {
    console.error(`--video-size must be <width>x<height>, e.g. 1920x1080 (got ${JSON.stringify(videoSizeFlag)})`);
    process.exit(2);
  }
  const wanted = { width: even(Number(match[1])), height: even(Number(match[2])) };
  const drift = Math.abs(aspect(wanted) - aspect(viewport)) / aspect(viewport);
  if (drift > 0.005) {
    console.error(
      `\n  --video-size ${wanted.width}x${wanted.height} is ${aspect(wanted).toFixed(3)}:1 and the viewport is ` +
        `${viewport.width}x${viewport.height} (${aspect(viewport).toFixed(3)}:1).\n\n` +
        `  Playwright fits the page inside the canvas and fills the rest with a band, so this\n` +
        `  file would carry a stripe beside the page instead of a bigger picture.\n\n` +
        `  Give the plan a viewport of the video's shape (1920x1080 for 16:9), or pass\n` +
        `  --video-size ${even(viewport.width)}x${even(viewport.height)} to record the page as it is.\n`,
    );
    process.exit(2);
  }
  if (wanted.width > viewport.width || wanted.height > viewport.height) {
    console.error(
      `\n  --video-size ${wanted.width}x${wanted.height} is larger than the ${viewport.width}x${viewport.height} viewport.\n\n` +
        `  Playwright does not scale a recording up: the page would sit in the corner of the\n` +
        `  canvas with a band beside it, not fill it. Pin the plan's viewport at the size you\n` +
        `  want ("viewport": { "width": ${Math.max(wanted.width, viewport.width)}, "height": ${Math.max(wanted.height, viewport.height)} }),\n` +
        `  or pass --video-size at most ${even(viewport.width)}x${even(viewport.height)} to shrink the file.\n`,
    );
    process.exit(2);
  }
  videoSize = wanted;
}

const contextOpts = {
  locale,
  timezoneId: plan?.timezoneId ?? 'UTC',
  viewport,
  deviceScaleFactor: scale,
  colorScheme: plan?.colorScheme ?? 'dark',
  // The chrome — panel, caption, pointer — is drawn by injected CSS and DOM, and
  // a page with a strict `style-src` refuses both without a word: the panel simply
  // arrives unstyled. The recording keeps going, so the failure lands in the
  // finished video rather than in the run. Bypassing the policy is what makes the
  // chrome a property of the recorder instead of a property of whoever wrote the
  // page being recorded.
  bypassCSP: true,
  // A video of an app whose every transition is switched off reads as a series
  // of stills. Figures are unaffected — a shot disables animations itself.
  reducedMotion: plan?.reducedMotion ?? (video ? 'no-preference' : 'reduce'),
  extraHTTPHeaders: { 'Accept-Language': `${locale},en;q=0.9` },
};

let browser = null;
let context = null;
let lastLaunchError = null;
let videoStartedAt = null;
for (const candidate of launchCandidates()) {
  try {
    if (profile) {
      await mkdir(path.resolve(profile), { recursive: true });
      context = await chromium.launchPersistentContext(path.resolve(profile), {
        ...baseLaunch,
        ...candidate,
        ...contextOpts,
      });
    } else {
      browser = await chromium.launch({ ...baseLaunch, ...candidate });
      context = await browser.newContext(contextOpts);
    }
    // The recorder is running from here on; chapter seeks are relative to the
    // first page's creation, recorded when that page is tracked.
    break;
  } catch (error) {
    lastLaunchError = error;
    await browser?.close().catch(() => {});
    browser = null;
    context = null;
  }
}
if (!context) {
  console.error(`\n  could not launch a browser. Tried: ${launchCandidates().map((c) => c.executablePath ?? c.channel ?? 'bundled').join(', ')}`);
  console.error(`  last error: ${lastLaunchError?.message?.split('\n')[0] ?? 'unknown'}`);
  console.error('  fix: npx playwright install chromium   (or CHROME=/path/to/chrome)\n');
  process.exit(2);
}

/**
 * The humanizer, and the pages it drives. `pageLog` is why a `clickNewPage` flow
 * can be reviewed: each tab is its own recording, and the review sheet needs to
 * know which is which.
 */
const human = createHuman({
  context,
  plan,
  enabled: humanizeOn,
  seed: humanSeed,
  speed: humanOptions.speed,
  maskColor: plan?.maskColor ?? '#0a0e14',
});
human.attachInit();
const pageLog = [];
let videoFiles = [];
if (humanizeOn) {
  console.log(`  humanize: on   seed=${humanSeed}  speed=${humanOptions.speed}${video ? '' : '  (no --video: pacing only)'}`);
  // The panel is the overlay's work, so it is worth one line of its own: a
  // checklist nobody expected, or one that is not there, is otherwise first
  // seen in the finished recording.
  const checklist = checklistOptions(plan);
  if (checklist) {
    const width = checklist.layout === 'dock' ? checklistReserve(checklist) : Math.round(Math.min(checklist.width, viewport.width * 0.3));
    console.log(
      `  checklist: ${checklist.items.length} item(s)  side=${checklist.side}  width=${width}px${checklist.layout === 'dock' ? '  docked (the page is laid out beside it)' : ''}`,
    );
    if (viewport.width < NARROW_VIEWPORT) {
      console.warn(
        `  warning: viewport is ${viewport.width}px wide; a ${checklist.side} checklist takes ${width}px of it\n` +
          `  -- widen the viewport or narrow "video.checklist.width" — the panel is docked over the app`,
      );
    } else if (checklist.layout === 'dock' && viewport.width - width < NARROW_VIEWPORT) {
      console.warn(
        `  warning: the docked panel leaves the app ${viewport.width - width}px of the ${viewport.width}px viewport\n` +
          `  -- widen the viewport or narrow "video.checklist.width"; the app lays out in what is left`,
      );
    }
  }
} else {
  // Captions and the checklist are drawn by the overlay, which a raw cut does
  // not install. The .vtt is still written, but the recording itself will carry
  // neither, and that is worth saying once rather than discovering in a finished
  // file.
  const captioned = plan?.steps.filter((step) => step.caption).length ?? 0;
  if (video && captioned) {
    console.warn(`  warning: ${captioned} step(s) carry a caption; --no-humanize leaves it to the .vtt track`);
  }
  const checked = plan?.steps.filter((step) => step.check).length ?? 0;
  if (video && checked) {
    console.warn(`  warning: ${checked} step(s) carry a check; --no-humanize draws no checklist panel beside the page`);
  }
}

if (cards) {
  const kinds = [cards.intro ? 'intro' : null, cards.outro ? 'outro' : null].filter(Boolean);
  console.log(`  cards: ${kinds.join(' + ')}  ${cards.ms}ms each`);
}

const shutdown = async () => {
  // The recorders stop first, while the pages are still open: the last frame of
  // a page is written from the page that ends the recording, and a closed page
  // has nothing left to give. Each wrote its own file as it went, so there is no
  // name to learn afterwards and nothing to rename.
  if (video) {
    const stopped = await Promise.all(
      pageLog.map(async (entry) => {
        if (!entry.recorder) return null;
        const result = await entry.recorder.stop().catch((error) => {
          console.error(`  video: ${entry.label} failed: ${error.message}`);
          return null;
        });
        return result ? { ...result, page: entry.index } : null;
      }),
    );
    for (const result of stopped) {
      if (!result) continue;
      const file = path.relative(OUT, result.file);
      if (videoFiles.some((v) => v.file === file)) continue;
      videoFiles.push({ file, page: result.page, dropped: result.dropped });
    }
  }
  if (trace) {
    await mkdir(OUT, { recursive: true });
    await context.tracing.stop({ path: path.join(OUT, 'trace.zip') }).catch(() => {});
  }
  await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
};

/** The recording, as it was written. */
async function logVideo() {
  if (!video) return;
  if (!videoFiles.length) {
    console.log('  video: none written (a page that never rendered produces no frames)');
    return;
  }
  const sizes = await Promise.all(
    videoFiles.map(async (v) => `${v.file} (${Math.round((await stat(path.join(OUT, v.file))).size / 1024)}K)`),
  );
  console.log(`  video: ${sizes.join(', ')}`);
  const dropped = videoFiles.reduce((sum, v) => sum + (v.dropped ?? 0), 0);
  // A figure changes the surface Chromium is capturing for a moment; those
  // frames are dropped rather than padded into a grey band, so the count is
  // expected to be small and never zero-by-accident.
  if (dropped) console.log(`  frames dropped: ${dropped}   (the page rendered at another size mid-step; the frame before covers the gap)`);
  console.log(`  canvas: ${videoSize.width}x${videoSize.height} @ ${videoFps}fps   (viewport ${viewport.width}x${viewport.height})`);
  console.log(`  seed:  ${humanSeed}   (re-run with --seed ${humanSeed} to replay the same path)`);
}

/**
 * The subtitles, written beside the recordings.
 *
 * A step's `caption` is drawn in the page, which makes the recording explain
 * itself anywhere it is played — but burned-in text is pixels: it cannot be
 * searched, turned off or translated. The same timeline therefore also becomes a
 * WebVTT file a `<track>`, a docs page or a video host can read, and the two
 * cannot disagree because both are the step's own clock.
 *
 * Written after the run (including a run that failed late, whose video is still
 * worth watching), because a cue's end is the next step's start.
 */
async function writeCaptions() {
  if (!video || !videoFiles.length) return;
  const json = timeline.toJSON();
  const written = [];
  for (const recording of videoFiles) {
    const cues = cuesForRecording(json, recording);
    if (!cues.length) continue;
    const file = vttFor(recording.file);
    const note = [json.tutorial ?? json.plan, `${cues.length} cue(s)`, json.seed ? `seed ${json.seed}` : null]
      .filter(Boolean)
      .join(' · ');
    await mkdir(path.dirname(path.join(OUT, file)), { recursive: true });
    await writeFile(path.join(OUT, file), buildVtt(cues, { note }));
    recording.captionsFile = file;
    written.push(`${file} (${cues.length} cue${cues.length === 1 ? '' : 's'})`);
  }
  if (written.length) console.log(`  captions: ${written.join(', ')}`);
}

/** Artefacts to link from the review sheet beyond the figures themselves. */
async function collectExtras() {
  const extras = [];
  if (video) {
    for (const v of videoFiles) extras.push(v.file);
    for (const v of videoFiles) if (v.captionsFile) extras.push(v.captionsFile);
    if (!videoFiles.length) extras.push('video/');
  }
  if (trace) extras.push('trace.zip');
  return extras;
}

/**
 * The first page of the context. `--video` needs Playwright's own ffmpeg, which
 * is a separate download; a missing one is a setup problem, so it gets the
 * command that fixes it rather than a Playwright stack trace.
 *
 * `prepare` runs between the page existing and the recorder starting, which is
 * the only window in which the first recorded frame can be something other than
 * the app — an intro card, on the page the video will go on to show.
 */
async function openPage({ prepare } = {}) {
  let opened;
  try {
    opened = context.pages()[0] ?? (await context.newPage());
    if (prepare) await prepare(opened);
    return await trackPage(opened);
  } catch (error) {
    if (error.ffmpegMissing || /ffmpeg/i.test(error.message)) {
      console.error("\n  --video needs Playwright's ffmpeg:   npx playwright install ffmpeg\n");
      await shutdown();
      process.exit(2);
    }
    throw error;
  }
}

/**
 * Put a card on the page.
 *
 * Cards are page content, not overlay drawings: they are shown before the app is
 * opened and after it is finished, so they need no app and no humanizer — which
 * is what makes them work in the raw cut. The overlay still installs into every
 * document, so it is hidden afterwards; otherwise the card would carry a pointer
 * and the checklist panel over its own checklist.
 */
async function showCard(target, kind) {
  await target.setContent(cardHtml(plan, kind), { waitUntil: 'load' });
  await target.evaluate(() => window.__pathCursorHide?.()).catch(() => {});
  // A card is a whole screen, so one that is taller than the frame is content the
  // finished video silently does not show. It is measured on the rendered card,
  // because how many pixels a line takes is not a property of the plan.
  const box = await target
    .evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return null;
      return { contentHeight: main.getBoundingClientRect().height, padding: parseFloat(getComputedStyle(document.body).paddingTop) || 0 };
    })
    .catch(() => null);
  const warning = box && cardFitWarning({ kind, contentHeight: box.contentHeight, frameHeight: viewport.height, padding: box.padding });
  if (warning) console.warn(`  warning: ${warning}`);
}

/**
 * Register a page for the humanizer and for the video. Every page gets a stable
 * label (`01-main`, `02-tab-2`) so the review sheet links a file rather than a
 * random name, and its own recorder: a tab is its own recording, because the
 * screencast belongs to the page.
 */
async function trackPage(opened) {
  const index = pageLog.length + 1;
  const label = `${String(index).padStart(2, '0')}-${index === 1 ? 'main' : `tab-${index}`}`;
  const recorder = video
    ? await createRecorder({
        page: opened,
        file: path.join(OUT, 'video', `${label}.webm`),
        size: videoSize,
        fps: videoFps,
      })
    : null;
  // The recording for a page starts with the page, so that is the zero point a
  // chapter seek is measured from — per page, because each tab is its own file.
  // Taken after the capture is running, so a chapter is not a fraction early.
  const openedAt = Date.now();
  if (video && !videoStartedAt) videoStartedAt = openedAt;
  pageLog.push({ page: opened, recorder, label, index, openedAt });
  human.setPage(opened);
  return opened;
}

/** The recorder feeding the page in front of us, or null in a raw cut. */
const recorderFor = (target) => pageLog.find((entry) => entry.page === target)?.recorder ?? null;

if (loginMode) {
  const loginUrl = flag('--login-url');
  page = await openPage();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  // Two ways to say "I am signed in": press Enter, or create the sentinel file.
  // The file exists because the person signing in and the person driving the run
  // are not always at the same keyboard — an agent on another host can watch a
  // window it cannot type into, and `touch` is the only channel it has.
  const doneFile = flag('--login-done-file');
  if (doneFile) await rm(doneFile, { force: true }).catch(() => {});
  console.log(`\n  A browser window is open on ${loginUrl}`);
  console.log('  Sign in (and clear any "verify you are human" check), then press Enter here.');
  if (doneFile) console.log(`  (or, from another host: touch ${doneFile})`);
  console.log('');
  await Promise.race([
    new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.once('data', resolve);
    }),
    (async () => {
      if (!doneFile) return new Promise(() => {});
      for (;;) {
        if (await access(doneFile).then(() => true).catch(() => false)) return;
        await new Promise((r) => setTimeout(r, 1500));
      }
    })(),
  ]);
  // Names only: a cookie value is a credential and does not belong in a log.
  const cookies = await context.cookies();
  const domains = [...new Set(cookies.map((c) => c.domain))].sort();
  console.log(`\n  profile ${path.resolve(profile ?? '.')}`);
  console.log(`  ${cookies.length} cookie(s) across: ${domains.join(', ') || 'none'}`);
  console.log('  Run the plan now; an expired session fails at the page that needed it.\n');
  await shutdown();
  process.exit(0);
}

// mkdir before tracing starts: the trace file is written at the end.
await mkdir(OUT, { recursive: true });
if (trace) await context.tracing.start({ screenshots: true, snapshots: true });

// A var with no value is a setup problem, not a capture failure: report it
// with the command that fixes it rather than as a stack trace.
let vars;
let expand;
let baseUrl;
try {
  ({ vars, expand } = createVars(plan));
  baseUrl = expand(plan.baseUrl).replace(/\/$/, '');
} catch (error) {
  console.error(`\n  ${error.message}\n`);
  console.error('  a plan var reads an environment variable; export it, or use a "literal" value.\n');
  await shutdown();
  process.exit(2);
}

// `--only` names a figure that must exist, otherwise it silently replays the
// whole plan and writes every other figure too. `--poster` gets the same
// treatment: a mistyped poster is a player that shows a broken image.
const shotIds = plan.steps.flatMap((s) => (s.shot ? [typeof s.shot === 'string' ? s.shot : s.shot.id] : []));
for (const [flagName, value] of [
  ['--only', only],
  ['--poster', posterFlag],
]) {
  if (value && !shotIds.includes(value)) {
    console.error(`\n  ${flagName} names no figure "${value}" in ${planPath}\n  figures: ${shotIds.join(', ')}\n`);
    await shutdown();
    process.exit(2);
  }
}

page = await openPage({ prepare: cards?.intro ? (opened) => showCard(opened, 'intro') : undefined });
page.setDefaultTimeout(20_000);
// The pointer waits somewhere plausible on the first frame, so it travels into
// the first target instead of appearing on top of it.
await human.begin();

// Some apps pick their own theme from a stored preference rather than from
// prefers-color-scheme, and apply it after first paint. Pin it before any script
// runs, otherwise the first capture of a flow catches the default theme.
if (plan.themeStorage) {
  const [key, value] = Object.entries(plan.themeStorage)[0];
  await context.addInitScript(
    ([k, v]) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* opaque origin */
      }
    },
    [key, value],
  );
}

/** The page must not have resolved a different UI language than the plan. */
async function assertLanguage(step) {
  const lang = await page.evaluate(() => document.documentElement.getAttribute('lang'));
  if (lang && !lang.toLowerCase().startsWith(primary)) {
    fail(step, `page rendered lang="${lang}", plan pins "${locale}" — the capture would ship the operator's locale`);
  }
}

/**
 * A capture must not land mid-theme. An app that applies a stored theme after
 * first paint gives a shot taken as soon as the form appears the wrong one, so
 * measure what the page actually painted instead of trusting `colorScheme`.
 */
async function assertTheme(step) {
  if ((plan.colorScheme ?? 'dark') !== 'dark') return;
  const lum = await page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    const [r, g, b] = bg.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });
  if (lum > 0.5) fail(step, `page painted a light background (luminance ${lum.toFixed(2)}) — the theme had not settled`);
}

let masks = [];
let wrote = 0;
const shots = [];
let lastExpect = [];
// Capture scale for the pictures this run writes, kept beside them in
// `.shots.json`. Merged, not replaced, so refreshing one shot with `--only` does
// not lose the scale of the others.
let shotMeta = {};

/**
 * `--vars-out` keeps what `setVar` read, so a run that fails after an install
 * can be retried without creating a second one. It holds credentials: mode 600,
 * written inside the run directory, never committed. It is written by default
 * because the failure that loses it is the expensive one.
 */
const scraped = new Set();
async function writeVars() {
  if (!scraped.size) return;
  const target = path.resolve(varsOut ?? path.join(OUT, '.vars.json'));
  await writeFile(target, JSON.stringify(vars, null, 2) + '\n', { mode: 0o600 });
  console.log(`  vars: ${path.relative(process.cwd(), target)} (mode 600, ${scraped.size} value(s))`);
}

/**
 * The frame a video player shows before anyone presses play.
 *
 * Off by default. A figure is usually a *crop* of the screen (a card, a form), so
 * using one as a poster stretches a detail across the whole player — the first
 * frame of the recording is the honest thumbnail. `--poster <shot-id>` asks for a
 * specific figure anyway.
 */
function posterFigure() {
  return posterFlag ? `${posterFlag}.png` : null;
}

const startedAt = Date.now();
/**
 * Where each step began and ended, for the video's chapter list. Wall clock for
 * seeking; `plannedMs` for reproducing — see lib/timeline.mjs.
 */
const timeline = createTimeline({
  plan,
  planPath,
  seed: humanSeed,
  speed: humanOptions.speed,
  humanized: human.enabled,
  viewport,
  fps: video ? videoFps : null,
  videoSize: video ? videoSize : null,
  startedAt,
  videoStartedAt,
  pageStartedAt: (page) => pageLog.find((entry) => entry.index === page)?.openedAt ?? null,
  planned: human.plannedMsSince,
});
// The step being run, so a raw Playwright timeout (a click that never lands, a
// fill on a field that vanished) is attributed to a step and leaves evidence
// instead of printing a one-line message with no page to look at.
let currentStep = null;

/**
 * The intro card is already on the page (it had to be there before the recorder
 * started), so all that is left is to leave it up for as long as the plan asked
 * and mark it as a chapter: a viewer who wants to skip the title has somewhere to
 * seek to, and one who scrubs back finds it again.
 *
 * A plain timer rather than the humanizer's `hold`, because the raw cut has no
 * humanizer — and the card is a frame of the recording either way.
 */
const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (cards?.intro) {
  const intro = timeline.begin({ index: 0, name: 'intro', action: 'card' });
  intro.page(1);
  console.log('  card: intro');
  await waitMs(cards.ms);
}
try {
  for (const [i, step] of plan.steps.entries()) {
    const label = `#${i + 1}${step.name ? ` ${step.name}` : ''}`;
    currentStep = label;
    const record = timeline.begin({
      index: i + 1,
      name: step.name ?? null,
      action: actionOf(step),
      caption: step.caption ?? null,
      check: step.check ? step.check.replace(/\s+/g, ' ').trim() : null,
    });
    // Which tab this step runs in. A `clickNewPage` flow continues in a second
    // recording, and a chapter that seeks into the wrong one lands on a screen
    // the step never showed — so the tab is recorded per step, not once.
    record.page(pageLog.length);
    // A flow through a third party has two possible shapes and the plan cannot
    // branch: a consent screen appears on the first run and is skipped once the
    // session holds a grant. A step that only applies at one of those places says
    // so with `when` and is skipped elsewhere — which is what lets one plan
    // survive both.
    if (step.when?.url && !new RegExp(step.when.url).test(page.url())) {
      record.skip('when:url');
      console.log(`  skip ${label} (at ${page.url().slice(0, 80)})`);
      continue;
    }
    // A screen that only some deployments show can keep the same URL as the one
    // that replaces it, so the guard is the text on the page, not the address.
    if (step.when?.text) {
      const onScreen = flat(await page.locator('body').innerText());
      if (!onScreen.includes(flat(expand(step.when.text)))) {
        record.skip('when:text');
        console.log(`  skip ${label} (no ${JSON.stringify(step.when.text)} on screen)`);
        continue;
      }
    }
    // The step's subtitle, in the picture for as long as the step runs. A step
    // without one clears the last, so a caption can never outlive the screen it
    // described. It is set before `goto`, because `arrive()` is what says it
    // again once the new document exists.
    await human.caption(step.caption ?? '');
    // The checklist row this step completes, ticked on the same beat as the
    // subtitle. A tick before a `goto` lands in the old document and is drawn
    // already-done by the new one, which is the rule for a panel that crosses a
    // navigation: re-ticking every page change reads as a bug.
    if (step.check) await human.check(step.check);
    if (step.goto) {
      const url = expand(step.goto);
      await page.goto(url.startsWith('http') ? url : `${baseUrl}${url}`, { waitUntil: 'domcontentloaded' });
      await human.arrive();
    }
    if (step.fill) {
      await human.fill(page.locator(expand(step.fill.selector)), expand(step.fill.value));
    }
    // `type` sends real key events one character at a time. Some frameworks only
    // enable their submit button once the field has seen key events, so `fill`,
    // which sets the value in one assignment, leaves the button disabled forever.
    if (step.type) {
      await human.type(page.locator(expand(step.type.selector)), expand(step.type.value));
    }
    if (step.press) {
      await human.press(page.locator(expand(step.press.selector)), expand(step.press.key));
    }
    if (step.click) {
      // A bare string is the common case; `{selector}` matches the other actions.
      const selector = typeof step.click === 'string' ? step.click : step.click.selector;
      await human.click(page.locator(expand(selector)));
    }
    // A click whose target may not be there. Third-party pages carry a cookie
    // banner that covers the bottom of the viewport in some regions but not
    // others, so a plan that waits for it fails on the runs that did not get one.
    // Absence is not an error here.
    if (step.clickIfPresent) {
      const spec = step.clickIfPresent;
      const locator = page.locator(expand(spec.selector)).first();
      const found = await locator
        .waitFor({ state: 'visible', timeout: spec.timeout ?? 5_000 })
        .then(() => true)
        .catch(() => false);
      if (found) {
        await human.click(locator);
        console.log(`  pressed ${String(spec.selector).slice(0, 60)}`);
      }
    }
    // A link with `target=_blank` opens a second tab, and the rest of the plan
    // continues there. Masks belong to the page they were declared on, so they
    // reset: a figure that masks a field must not try to mask a locator on the
    // page that replaced it.
    if (step.clickNewPage) {
      const spec = step.clickNewPage;
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: spec.timeout ?? 30_000 }),
        human.click(page.locator(expand(spec.selector))),
      ]);
      await popup.waitForLoadState('domcontentloaded');
      page = await trackPage(popup);
      page.setDefaultTimeout(20_000);
      masks = [];
      // The step's chapter stays on the tab the click was dispatched in — that is
      // where the click is visible. The new tab's content is the next step's
      // subject, and its recording starts at zero, so seeking it here would land
      // on a screen this step never showed.
      await human.arrive();
      console.log(`  new tab: ${page.url()}`);
    }
    // Third-party pages settle with their own timers (a redirect that renders a
    // second form), and there is no element to wait for yet when the point of
    // the step is to find out what appeared.
    if (step.pause) await human.hold(step.pause);
    // A beat of stillness a viewer can read. `--only` replays are unaffected.
    if (step.hold) await human.hold(step.hold);
    // Read a value off the page into a plan variable. An installer that
    // generates a first password and shows it once cannot be driven from an
    // environment variable: the plan reads it from the page it was printed on.
    if (step.setVar) {
      const spec = step.setVar;
      const el = page.locator(expand(spec.from.selector)).first();
      const prop = spec.from.prop ?? 'text';
      const value =
        prop === 'value'
          ? await el.inputValue()
          : prop === 'href'
            ? await el.getAttribute('href')
            : (await el.textContent())?.trim();
      if (!value) fail(label, `setVar "${spec.name}" read nothing from ${spec.from.selector}`);
      vars[spec.name] = value;
      scraped.add(spec.name);
      // Never the value: half of these are credentials.
      console.log(`  var ${spec.name} <- ${spec.from.selector} (${value.length} chars)`);
    }
    if (step.waitFor) {
      const { selector, text, url } = step.waitFor;
      const timeout = step.waitFor.timeout ?? 20_000;
      if (selector) {
        await page
          .locator(expand(selector))
          .first()
          .waitFor({ state: 'visible', timeout })
          .catch(() => fail(label, `selector ${JSON.stringify(selector)} never became visible (at ${page.url()})`));
      }
      // "the page shows this text" — not "some element matching it is
      // visible". getByText also matches every ancestor of the text node, so
      // `.first()` is the page container, which is visible before the text
      // exists: a wait that returns immediately is worse than no wait at all.
      if (text) {
        const needle = flat(expand(text));
        // Whitespace-insensitive: a sentence split across elements comes back
        // from innerText with the break inside it, and the guard is about the
        // words on screen, not how the DOM happened to divide them.
        await page
          .waitForFunction((n) => document.body.innerText.replace(/\s+/g, ' ').includes(n), needle, {
            timeout,
            polling: 1000,
          })
          .catch(() => fail(label, `page never showed ${JSON.stringify(needle)} (at ${page.url()})`));
      }
      // A flow that hands off to another host (an OAuth provider, then a
      // callback) has no stable element to wait for, so the URL is the signal.
      // An array accepts either outcome, which is how a plan works whether or
      // not the session was already signed in.
      if (url) {
        const patterns = [].concat(url);
        await page
          .waitForURL((u) => patterns.some((p) => new RegExp(p).test(u.href)), { timeout })
          .catch(() => fail(label, `url never matched ${patterns.join(' | ')} (at ${page.url()})`));
      }
    }
    // `waitHidden` is the mirror of `waitFor`: some chrome is server-rendered
    // visible and hidden once the page's own script boots, so a shot taken on
    // first paint ships a control the app never shows a reader. Wait for the
    // settled state; do not mask the flash.
    if (step.waitHidden) {
      const { selector, timeout = 20_000 } = step.waitHidden;
      await page
        .locator(expand(selector))
        .first()
        .waitFor({ state: 'hidden', timeout })
        .catch(() => fail(label, `${selector} never went away — the page would ship a flash (at ${page.url()})`));
    }
    if (step.mask) {
      masks = masks.concat([].concat(step.mask).map((s) => page.locator(expand(s))));
    }
    // `expect` is one guard with two forms, and they answer different questions:
    //
    // - `{ "selector": "#password" }` — is the control this path depends on
    //   still on the screen? Ids survive copy edits, renames and translations;
    //   labels do not, which is why this is the form to reach for by default.
    // - `"$29,799.00"` — are the words the document makes a claim about still
    //   on the screen? Use text when the text *is* the claim.
    //
    // Either way the guard is a check at this point in the path, not a wait:
    // `waitFor` is how a screen is allowed to settle.
    const isSelectorGuard = step.expect && typeof step.expect === 'object' && !Array.isArray(step.expect);
    if (step.expect) {
      lastExpect = isSelectorGuard
        ? [].concat(step.expect.selector).map((s) => `element ${expand(s)}`)
        : [].concat(expand(step.expect));
    }
    if (step.expect || step.shot) await assertLanguage(label);
    if (step.expect) {
      if (isSelectorGuard) {
        for (const raw of [].concat(step.expect.selector)) {
          const selector = expand(raw);
          const visible = await page
            .locator(selector)
            .first()
            .isVisible()
            .catch(() => false);
          if (!visible) {
            fail(label, `expected element ${JSON.stringify(selector)} on screen (at ${page.url()})`);
          }
        }
      } else {
        const body = flat(await page.locator('body').innerText());
        for (const needle of [].concat(expand(step.expect))) {
          if (!body.includes(flat(needle))) {
            fail(label, `expected page text ${JSON.stringify(needle)}\n  got: ${body.slice(0, 400)}`);
          }
        }
      }
    }
    if (step.shot) {
      const spec = typeof step.shot === 'string' ? { id: step.shot } : step.shot;
      const file = path.join(OUT, `${spec.id}.png`);
      await mkdir(OUT, { recursive: true });
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      await human.settle();
      await page.waitForTimeout(250);
      await assertTheme(label);
      // The pointer and its ripple are a depiction for the viewer. A figure is
      // evidence, so it must contain neither — and it is hidden before the
      // capture, not cropped out afterwards.
      //
      // Hiding the chrome repaints the page, so the recording is paused across
      // the capture: the frame already on screen is held, and a single frame of
      // a pointerless, panel-less page never reaches the video. Resume only
      // after the chrome is back, or the first frame of the gap becomes that
      // frame instead.
      const recorder = recorderFor(page);
      recorder?.pause();
      await human.hideCursor();
      const shotOpts = { animations: 'disabled', caret: 'hide', mask: masks, maskColor: plan.maskColor ?? '#0a0e14' };
      let raw;
      if (spec.clip) {
        // Clip to the subject: a login page pins theme and language switchers to
        // the viewport corner, and a full-frame capture drags them into the
        // picture where they are chrome the reader never touches.
        //
        // A clip is a selector or a measured `{x, y, width, height}` in CSS
        // pixels. The rect exists for a subject with no element of its own, and
        // it carries its own padding, so it is not padded again.
        const isRect = typeof spec.clip === 'object';
        if (!isRect) {
          // `boundingBox` and screenshot clips are viewport-relative, and
          // Chromium cannot capture outside the viewport: a subject below the
          // fold fails as "clipped area is either empty or outside the
          // resulting image". Scroll it in first, centred, so the padded box
          // has room on both sides instead of being clamped at a viewport edge.
          await page
            .locator(expand(spec.clip))
            .first()
            .evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }))
            .catch(() => {});
          await page.waitForTimeout(150);
        }
        const box = isRect ? { ...spec.clip } : await page.locator(expand(spec.clip)).first().boundingBox();
        if (!box) fail(label, `clip selector matched nothing: ${spec.clip}`);
        const pad = spec.pad ?? (isRect ? 0 : 32);
        const vp = page.viewportSize();
        raw = await page.screenshot({
          ...shotOpts,
          clip: {
            x: Math.max(0, box.x - pad),
            y: Math.max(0, box.y - pad),
            width: Math.min(vp.width - Math.max(0, box.x - pad), box.width + pad * 2),
            height: Math.min(vp.height - Math.max(0, box.y - pad), box.height + pad * 2),
          },
        });
      } else {
        raw = await page.screenshot(shotOpts);
      }
      let buffer = raw;
      // A clip is already the composition. Trimming it again re-crops the
      // figure to its darkest content — a card's fill is close enough to the
      // page colour to count as dead space — and slices the edges of the card
      // the author chose as the subject. Only a whole-frame capture is trimmed.
      if (trim && !spec.clip) {
        const lib = await sharp();
        if (lib) {
          const { trimDeadSpace } = await import('../lib/frame.mjs');
          buffer = (await trimDeadSpace(raw, spec.pad ?? plan.pad)).buffer;
        }
      }
      await writeFile(file, buffer);
      const dims = await imageSize(buffer);
      // Record the capture scale next to the pictures: a document needs the
      // figure's *CSS* size (what the app drew on screen) to size the card and to
      // cap the zoom at a size the pixels can actually support. A PNG cannot
      // carry that, and guessing from the file name breaks the first time a shot
      // is captured at another ratio.
      shotMeta[spec.id] = { width: dims.width, height: dims.height, scale };
      shots.push({ id: spec.id, file: `${spec.id}.png`, step: i + 1, expect: lastExpect, ...dims });
      console.log(`  ${spec.id.padEnd(26)} ${dims.width}x${dims.height}  ${path.relative(process.cwd(), file)}`);
      wrote += 1;
      record.shot(spec.id);
      // The video stays on the frame the figure describes long enough to read
      // it, then the pointer comes back for the next action.
      await human.showCursor();
      recorder?.resume();
      await human.hold(spec.holdMs ?? humanOptions.shotHoldMs);
      if (only === spec.id) break;
    }
  }

  // The end card is the last frame, so it is set after the path rather than drawn
  // over it: no overlay, no app, just the list this run ticked off. It is skipped
  // for `--only` (a replay up to one figure is not a finished walkthrough) and
  // the failure path never reaches it, because a card that says "done" after a
  // failed run is a lie the video would tell every time it is watched.
  if (cards?.outro && !only) {
    const outro = timeline.begin({ index: plan.steps.length + 1, name: 'outro', action: 'card' });
    outro.page(pageLog.length);
    console.log('  card: outro');
    await showCard(page, 'outro');
    await waitMs(cards.ms);
  }
} catch (error) {
  if (!error.step && currentStep) error.step = currentStep;
  if (error.step) {
    console.error(`\n  FAILED at step ${error.step}: ${error.message}`);
    // Evidence is a picture of the page, not of the pointer — and the same
    // pause that keeps it out of a figure keeps it out of the video.
    recorderFor(page)?.pause();
    await human.hideCursor();
    const stem = await writeEvidence({ page, dir: FAILED, step: error.step, message: error.message }).catch(() => null);
    if (stem) console.error(`  evidence: ${path.relative(process.cwd(), stem)}.{png,html,txt}`);
  } else {
    console.error(`\n  FAILED: ${error.message}`);
  }
  await writeFile(metaPath, JSON.stringify(shotMeta, null, 2) + '\n').catch(() => {});
  // The scraped values survive the failure too: a plan that dies after an
  // install must not need a second install to be retried.
  await writeVars();
  // The recording is finished first: a video's file only exists once the
  // context closes, and the review sheet links it.
  await shutdown();
  await logVideo();
  timeline.setVideos(videoFiles);
  timeline.close();
  // Before the timeline is written, so `.timeline.json` names the `.vtt` beside
  // each recording: the two files are copied around together.
  await writeCaptions().catch(() => {});
  if (video || human.enabled) await timeline.write(OUT).catch(() => {});
  // A plan that fails late has still banked every figure before the failure, and
  // those are exactly what a reviewer needs to see next to the evidence.
  const extras = await collectExtras();
  if (shots.length || videoFiles.length) {
    await writeReview({
      plan,
      planPath,
      shots,
      scale,
      baseUrl,
      outDir: OUT,
      elapsed: Date.now() - startedAt,
      extras,
      timeline,
      videos: videoFiles,
      poster: posterFigure(),
      viewport,
    }).catch(() => {});
  }
  process.exit(1);
}

await shutdown();
await logVideo();
timeline.setVideos(videoFiles);
timeline.close();
await writeFile(metaPath, JSON.stringify(shotMeta, null, 2) + '\n');
await writeVars();
await writeCaptions();
if (video || human.enabled) await timeline.write(OUT);
const extras = await collectExtras();
if (review && (shots.length || videoFiles.length)) {
  const file = await writeReview({
    plan,
    planPath,
    shots,
    scale,
    baseUrl,
    outDir: OUT,
    elapsed: Date.now() - startedAt,
    extras,
    timeline,
    videos: videoFiles,
    poster: posterFigure(),
    viewport,
  });
  console.log(`  review: ${path.relative(process.cwd(), file)}`);
}
if (only && wrote === 0) {
  console.error(`\n  no shot named "${only}" in ${planPath}`);
  process.exit(1);
}
console.log(`\n  ${wrote} shot(s) written to ${path.relative(process.cwd(), OUT)}`);
