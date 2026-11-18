#!/usr/bin/env node
/**
 * Build the site: record the examples, then render them into `site/`.
 *
 * The page is a template (`site/index.html`) with four slots in it, and this
 * script fills them. That split is the point:
 *
 * - the prose is a committed file a reviewer reads as text;
 * - the media is *output*, recorded here from the committed plans against the
 *   bundled example app, so the site cannot show a figure no plan produces and
 *   no binary lands in git;
 * - the slots are the only contract between the two, and `check-site.mjs`
 *   refuses a template that has lost one.
 *
 * A plan that declares `humanize.seed` is reproduced beat for beat; the ones that
 * do not are seeded here (`site-<key>`), so a build is the same twice even when
 * the plan left the pacing free.
 *
 * Two artefacts the plans cannot express are derived here instead. The theme strip
 * is one plan recorded three times with a different `video.theme`, and a still of
 * it is a *frame of that recording*: screenshots deliberately hide the panel, so a
 * figure is the wrong source for a picture of the chrome. The social card is the
 * whole frame of one of those recordings. Both are cut by ffmpeg from files this
 * build just produced — nothing is drawn here and no binary is committed.
 *
 * Usage: node scripts/build-site.mjs [--keep-work]
 * Exit: 0 built · 1 a recording failed (its failures/ directory is named)
 *       2 cannot proceed (no template, unreadable plan, unwritable output)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findFfmpeg } from '../lib/recorder.mjs';
import { startStaticServer } from '../lib/serve.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(ROOT, '.site');
const WORK = path.join(OUT, '.work');
const REPO = 'https://github.com/mkucharz/ui-path-recorder';
const KEEP_WORK = process.argv.includes('--keep-work');

/** One gallery card. `alt` is written by hand: a figure cannot describe itself. */
const RUNS = [
  {
    key: 'overlay',
    plan: 'plans/examples/signin.plan.json',
    tag: 'Overlay · the default frame',
    title: 'Two figures, no panel',
    caption:
      'A 1100×760 frame and a clip on the sign-in card. No panel and no subtitle — the app and the pointer moving through it, drawn while the page runs rather than edited in afterwards.',
    alt: 'A recording of the bundled example app’s sign-in card with no checklist panel, only the pointer moving through the form.',
    video: true,
  },
  {
    key: 'checklist',
    plan: 'plans/examples/signin-checklist.plan.json',
    tag: 'Checklist',
    title: 'A list that ticks itself off',
    caption:
      'Each step names the row it completes, so the panel fills in as the path runs — and the review sheet lists the same rows with the moment each ticked.',
    alt: 'A recording of the sign-in flow with a “Sign-in check” panel beside it.',
    video: true,
  },
  {
    key: 'dock-right',
    plan: 'plans/examples/signin-sidebar.plan.json',
    tag: 'Docked sidebar · right',
    title: 'A column the page gives up',
    caption:
      'The panel docks and reserves 360 px, so the app is laid out beside the list instead of underneath it. No control is ever covered.',
    alt: 'A recording of the sign-in flow with the checklist docked in a column on the right.',
    video: true,
  },
  {
    key: 'dock-left',
    plan: 'plans/examples/signin-sidebar-left.plan.json',
    tag: 'Docked sidebar · left',
    title: 'The other edge',
    caption:
      'The same plan shape, one field changed: the page gives up its left column, so the frame reads list-then-app.',
    alt: 'A recording of the sign-in flow with the checklist docked in a column on the left.',
    video: true,
  },
  {
    key: 'walkthrough',
    plan: 'plans/examples/signin-walkthrough.plan.json',
    tag: 'Title and end cards',
    title: 'A finished walkthrough, plan-only',
    caption:
      'A title card, a subtitle on every step, a checklist that fills in, and an end card on the same list. Nothing was added in an editor.',
    alt: 'A narrated recording of the sign-in flow that opens on a title card and closes on an end card.',
    video: true,
  },
];

/** The strip: one plan, three palettes. `from` is the preset's own source, shortened. */
const THEMES = [
  { name: 'memory', from: 'the Memory web UI’s own theme' },
  { name: 'dracula', from: 'spec.draculatheme.com' },
  { name: 'catppuccin-mocha', from: 'catppuccin/palette · mocha' },
];

/** The plan the strip is recorded from. */
const THEME_PLAN = 'plans/examples/signin-sidebar.plan.json';

const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const readJson = (file) => {
  try {
    return JSON.parse(read(file));
  } catch (error) {
    process.stderr.write(`build-site: cannot read ${file}: ${error.message}\n`);
    process.exit(2);
  }
};

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

/**
 * Record one run into `dir`.
 *
 * The CLI is spawned rather than imported because it *is* the tool: a build that
 * called library functions could pass while `path-shots` was broken, which is the
 * one thing a page full of its output must not do.
 *
 * Spawned asynchronously on purpose: the example app is served by this process, so
 * a synchronous child would block the event loop and the recording would wait
 * forever for a page that can never be answered.
 */
async function record({ planPath, dir, url, video = false, seed = null }) {
  const args = [path.join(ROOT, 'scripts', 'path-shots.mjs'), planPath, '--out', dir, '--review'];
  if (video) args.push('--video');
  if (seed) args.push('--seed', seed);
  process.stdout.write(`  record ${path.relative(ROOT, planPath)} → ${path.relative(ROOT, dir)}\n`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, SIGNIN_URL: url },
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  return code === 0 ? { ok: true, dir } : { ok: false, dir };
}

/**
 * Cut one frame out of a recording.
 *
 * A figure cannot show the checklist. `path-shots` hides the pointer, the subtitle
 * and the panel before it writes a screenshot — a figure is the *app*, and chrome
 * in it would be a lie about what the page looks like. The panel is chrome and it
 * exists only in the video, so a still of the panel is a frame of the recording:
 * ffmpeg cuts it, and nothing here draws it.
 */
async function frame({ video, at, out, crop = null }) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    throw new Error('no ffmpeg found — the stills on this page are frames of its recordings (npx playwright install ffmpeg)');
  }
  mkdirSync(path.dirname(out), { recursive: true });
  const args = ['-y', '-loglevel', 'error', '-ss', String(at / 1000), '-i', video, '-frames:v', '1'];
  if (crop) args.push('-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
  args.push(out);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) throw new Error(`ffmpeg failed (exit ${code}) cutting ${path.relative(ROOT, out)}`);
}

/**
 * Copy what the site serves out of a run directory.
 *
 * A run directory is not a web asset: it can hold `.vars.json` (values scraped off
 * the page, mode 600) and `trace.zip`. The site gets the figures, the review sheet
 * and the video — an allowlist, because a blocklist is one new artefact away from
 * publishing something nobody meant to.
 */
function copyRun(from, to) {
  mkdirSync(to, { recursive: true });
  const figures = [];
  for (const name of readdirSync(from).sort()) {
    if (name.endsWith('.png') || name === 'review.html') {
      cpSync(path.join(from, name), path.join(to, name));
      if (name.endsWith('.png')) figures.push(name.replace(/\.png$/, ''));
    }
  }
  const video = path.join(from, 'video');
  if (existsSync(video)) {
    mkdirSync(path.join(to, 'video'), { recursive: true });
    for (const name of readdirSync(video).sort()) {
      if (name.endsWith('.webm') || name.endsWith('.vtt')) cpSync(path.join(video, name), path.join(to, 'video', name));
    }
  }
  if (!figures.length) throw new Error(`${path.relative(ROOT, from)} has no figures`);
  const shots = JSON.parse(readFileSync(path.join(from, '.shots.json'), 'utf8'));
  // A stills-only run with no humanizer writes no timeline; only the video cards
  // need one, for the file name and the duration.
  const timelinePath = path.join(from, '.timeline.json');
  const timeline = existsSync(timelinePath) ? JSON.parse(readFileSync(timelinePath, 'utf8')) : null;
  return { figures, shots, timeline };
}

/* ------------------------------------------------------------------ *
 * Markup
 * ------------------------------------------------------------------ */

const seconds = (ms) => Math.round(ms / 1000);

/**
 * A card's media, described once by the run that produced it.
 *
 * A video's poster is a frame of *that recording*, not one of its figures: a
 * figure is a crop of a control, and stretching a crop across a 16:9 player is a
 * picture the recording never showed. The frame also carries the panel, which is
 * the part of the recording a reader is being offered.
 */
function mediaFor({ alt, media }) {
  const { poster, width, height, video } = media;
  const size = `width="${width}" height="${height}"`;
  if (!video) {
    return `<div class="media"><img src="${poster}" ${size} loading="lazy" decoding="async" alt="${esc(alt)}"></div>`;
  }
  // The recording draws its own subtitles in, so the track is offered but never
  // default: a default track would paint a second copy over the same corner.
  const track = video.captions ? `<track kind="captions" src="${video.captions}" srclang="en" label="Captions">` : '';
  return `<div class="media"><video controls preload="metadata" playsinline poster="${poster}" ${size} aria-label="${esc(alt)}">
      <source src="${video.src}" type="video/webm">${track}
      <p>Your browser cannot play WebM. <a href="${video.src}">Download the recording</a>.</p>
    </video></div>`;
}

function cardMarkup(entry, run, media) {
  const duration = media.video && run.timeline ? ` · ${seconds(run.timeline.durationMs)} s` : '';
  const tag = `${entry.tag} · ${run.figures.length} figure${run.figures.length === 1 ? '' : 's'}${duration}`;
  return `      <article class="card" id="${entry.key}">
        ${mediaFor({ alt: entry.alt, media })}
        <div class="body">
          <p class="card-tag">${esc(tag)}</p>
          <h3>${esc(entry.title)}</h3>
          <p>${esc(entry.caption)}</p>
          <p class="card-links">
            <a href="assets/${entry.key}/review.html">Review sheet&nbsp;↗</a>
            <a class="plan" href="${REPO}/blob/main/${entry.plan}">the plan&nbsp;↗</a>
          </p>
        </div>
      </article>`;
}

function swatchesFor(name) {
  const preset = readJson(`themes/${name}.json`);
  const picks = ['--pc-surface-strong', '--pc-accent', '--pc-text', '--pc-muted', '--pc-done'];
  const chips = picks
    .map((token) => (preset.tokens[token] ? `<li style="background:${esc(preset.tokens[token])}"></li>` : ''))
    .join('');
  return `<ul class="swatches" aria-hidden="true">${chips}</ul>`;
}

/**
 * One palette: the checklist panel, cut from that palette's recording.
 *
 * The crop is the panel rather than the whole frame because a whole 1920-wide
 * frame three-up on a page is unreadable — the panel is where a preset's surface,
 * border, text, muted and done colours all land.
 */
function themeMarkup(theme, still) {
  return `      <figure class="theme">
        <div class="frame"><img src="assets/theme-${theme.name}/panel.png" width="${still.width}" height="${still.height}" loading="lazy" decoding="async" alt="The checklist panel with three of its four rows ticked, recorded with the ${esc(theme.name)} palette."></div>
        <figcaption>
          <span class="name">"video": { "theme": "${esc(theme.name)}" }</span>
          ${swatchesFor(theme.name)}
          <span class="from">from ${esc(theme.from)}</span>
        </figcaption>
      </figure>`;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const template = (() => {
  try {
    return readFileSync(path.join(SITE, 'index.html'), 'utf8');
  } catch (error) {
    process.stderr.write(`build-site: cannot read site/index.html: ${error.message}\n`);
    process.exit(2);
  }
})();

const slots = ['hero', 'gallery', 'themes', 'version'];
for (const slot of slots) {
  const found = template.split(`<!-- site:${slot} -->`).length - 1;
  if (found !== 1) {
    process.stderr.write(`build-site: site/index.html must hold exactly one <!-- site:${slot} --> (found ${found})\n`);
    process.exit(2);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, 'assets'), { recursive: true });
mkdirSync(path.join(WORK, 'plans'), { recursive: true });
cpSync(path.join(SITE, 'style.css'), path.join(OUT, 'style.css'));

const server = await startStaticServer({
  root: path.join(ROOT, 'examples', 'signin'),
  port: 0,
  transform: (html) => html.replaceAll('__VARIANT__', 'current'),
});
process.stdout.write(`serving the example app at ${server.url}\n`);

const started = Date.now();
const built = [];
const failed = [];

/**
 * When to cut a frame: a beat before the last step begins.
 *
 * By then the panel is nearly full and the screen is still the app the plan is
 * about, where a frame from the last step is already the destination. The plans
 * pin their own seed, so this lands on the same beat every build.
 */
const beatBeforeEnd = (timeline) => Math.max(0, timeline.steps.at(-1).startMs - 1500);

try {
  for (const entry of RUNS) {
    const dir = path.join(WORK, entry.key);
    // A plan that pins its seed is the authority; one that leaves pacing free gets
    // a stable seed here, so the page does not change because a build ran at a
    // different second.
    const seed = readJson(entry.plan).humanize?.seed ?? `site-${entry.key}`;
    const result = await record({ planPath: path.join(ROOT, entry.plan), dir, url: server.url, video: entry.video, seed });
    if (!result.ok) {
      failed.push({ key: entry.key, dir });
      continue;
    }
    const run = copyRun(dir, path.join(OUT, 'assets', entry.key));
    const first = run.shots[run.figures[0]];
    const media = {
      poster: `assets/${entry.key}/${run.figures[0]}.png`,
      width: first.width,
      height: first.height,
    };
    if (entry.video) {
      const recording = run.timeline.videos[0];
      const at = beatBeforeEnd(run.timeline);
      await frame({ video: path.join(dir, recording.file), at, out: path.join(OUT, 'assets', entry.key, 'poster.png') });
      const size = run.timeline.videoSize ?? run.timeline.viewport;
      media.poster = `assets/${entry.key}/poster.png`;
      media.width = size.width;
      media.height = size.height;
      media.video = {
        src: `assets/${entry.key}/${recording.file}`,
        captions: recording.captionsFile ? `assets/${entry.key}/${recording.captionsFile}` : null,
      };
    }
    built.push({ entry, run, media });
  }

  if (failed.length) throw new Error('a recording failed');

  // The strip: one plan, three palettes. Each is a whole recording with the
  // palette injected, and the still is a frame of it cropped to the panel — the
  // panel is chrome, and chrome is exactly what a plan's `theme` repaints.
  const themeSource = readJson(THEME_PLAN);
  const themeRuns = [];
  for (const theme of THEMES) {
    const plan = structuredClone(themeSource);
    plan.tutorial = `signin-theme-${theme.name}`;
    plan.video = { ...(plan.video ?? {}), theme: theme.name };
    const planPath = path.join(WORK, 'plans', `${theme.name}.plan.json`);
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const dir = path.join(WORK, `theme-${theme.name}`);
    const result = await record({ planPath, dir, url: server.url, video: true });
    if (!result.ok) {
      failed.push({ key: `theme-${theme.name}`, dir });
      continue;
    }
    const timeline = JSON.parse(readFileSync(path.join(dir, '.timeline.json'), 'utf8'));
    const video = path.join(dir, timeline.videos[0].file);
    const at = beatBeforeEnd(timeline);
    const panel = { width: plan.video.checklist.width ?? 320, side: plan.video.checklist.side ?? 'right' };
    const across = timeline.viewport.width;
    // A sliver of the app at the panel's inner edge, so the crop shows the panel's
    // own shadow and border against something rather than floating in a void — and
    // the crop stops at the frame edge, because the panel is flush with it.
    const sliver = 12;
    const cropWidth = Math.min(across, panel.width + sliver);
    const crop = {
      x: panel.side === 'left' ? 0 : across - cropWidth,
      y: 0,
      width: cropWidth,
      height: Math.min(timeline.viewport.height, 340),
    };
    const panelPng = path.join(OUT, 'assets', `theme-${theme.name}`, 'panel.png');
    await frame({ video, at, out: panelPng, crop });
    const still = { width: crop.width, height: crop.height };
    // The social card wants 16:9 and the whole frame, and one palette is enough.
    if (theme.name === THEMES[0].name) {
      await frame({ video, at, out: path.join(OUT, 'assets', 'og.png') });
    }
    themeRuns.push({ theme, still });
  }
  if (failed.length) throw new Error('a theme recording failed');

  const hero = built.find(({ entry }) => entry.key === 'dock-right') ?? built.find(({ media }) => media.video) ?? built[0];
  const { poster, width, height, video } = hero.media;
  const shape = `${width}×${height}`;
  const heroMarkup = `      <div class="frame">
        <video controls muted loop autoplay playsinline preload="metadata" poster="${poster}" width="${width}" height="${height}" aria-label="${esc(hero.entry.alt)}">
          <source src="${video.src}" type="video/webm">
        </video>
        <img class="hero-poster" src="${poster}" width="${width}" height="${height}" alt="${esc(hero.entry.alt)}">
      </div>
      <p class="caption"><b>This recording made this page’s examples.</b> Recorded during the build from
      <code>${hero.entry.plan}</code> against the bundled example app: one ${shape} frame, the page and the
      panel side by side.</p>`;

  const html = template
    .replace('<!-- site:hero -->', heroMarkup)
    .replace('<!-- site:gallery -->', built.map(({ entry, run, media }) => cardMarkup(entry, run, media)).join('\n'))
    .replace('<!-- site:themes -->', themeRuns.map(({ theme, still }) => themeMarkup(theme, still)).join('\n'))
    .replace('<!-- site:version -->', `v${esc(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version)}`);

  writeFileSync(path.join(OUT, 'index.html'), html);

  process.stdout.write(
    `\nbuilt .site/ — ${built.length} example run(s), ${themeRuns.length} palette still(s), ` +
      `${Math.round((Date.now() - started) / 1000)} s\n`,
  );
} catch (error) {
  process.stderr.write(`\nbuild-site: ${error.message}\n`);
  for (const { key, dir } of failed) {
    process.stderr.write(`  ${key}: see ${path.relative(ROOT, dir)}/failures/\n`);
  }
  process.stderr.write(`  the work directory is kept at ${path.relative(ROOT, WORK)}\n`);
  process.exit(1);
} finally {
  await server.close();
  if (!KEEP_WORK && !failed.length) rmSync(WORK, { recursive: true, force: true });
}

// The work tree is build scratch: it must not reach the published artefact.
const bytes = (() => {
  const walk = (dir) =>
    readdirSync(dir).reduce((total, name) => {
      const full = path.join(dir, name);
      return total + (statSync(full).isDirectory() ? walk(full) : statSync(full).size);
    }, 0);
  return walk(OUT);
})();
process.stdout.write(`.site/ is ${(bytes / 1024 / 1024).toFixed(1)} MB\n`);
