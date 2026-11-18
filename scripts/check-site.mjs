#!/usr/bin/env node
/**
 * Check the site: the template before a build, the built output after one.
 *
 * Two failures this exists to catch, both of which look fine locally and break
 * on Pages:
 *
 * 1. **A root-absolute URL.** A project site is served from
 *    `/<repo>/`, so `src="/assets/x.png"` asks for an org-level path that is not
 *    there. The page is full of correct links on the machine that built it and
 *    broken on the machine that reads it.
 * 2. **A reference to something no build produced.** The gallery is filled from
 *    recorded runs, so a renamed figure or a run that wrote fewer shots turns into
 *    a 404 that only a reader sees.
 *
 * It is a scanner, not a parser: the input is one template this repo owns, and a
 * dependency for that would be more code than the thing it checks. Anything it
 * cannot understand it reports rather than guesses about.
 *
 * Usage:
 *   node scripts/check-site.mjs                  # the template in site/
 *   node scripts/check-site.mjs --built .site    # the pages a build produced
 *
 * Exit: 0 ok · 1 the site is wrong · 2 cannot proceed (no input to read).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { PLAN_BLOCK } from '../lib/json-highlight.mjs';

const HERE = path.resolve(import.meta.dirname, '..');
const ARGS = process.argv.slice(2);
const builtAt = ARGS.indexOf('--built');
const BUILT = builtAt !== -1 ? ARGS[builtAt + 1] : null;

if (ARGS.includes('--help') || ARGS.includes('-h')) {
  process.stdout.write(
    'usage: node scripts/check-site.mjs [--built DIR]\n\n' +
      '  (no arguments)   check the template in site/\n' +
      '  --built DIR      check a built site: every local reference resolves\n\n' +
      'exit: 0 ok · 1 the site is wrong · 2 cannot proceed\n',
  );
  process.exit(0);
}
if (ARGS.length && BUILT === undefined) {
  process.stderr.write(`check-site: unknown or incomplete argument ${JSON.stringify(ARGS.join(' '))}\n`);
  process.exit(2);
}

const root = BUILT ? path.resolve(HERE, BUILT) : path.join(HERE, 'site');
const indexPath = path.join(root, 'index.html');
const mode = BUILT ? 'built' : 'template';

let html;
try {
  html = readFileSync(indexPath, 'utf8');
} catch (error) {
  process.stderr.write(`check-site: cannot read ${indexPath}: ${error.message}\n`);
  process.exit(2);
}

const failures = [];
const fail = (message) => failures.push(message);

/**
 * What a reader sees: the spans removed, the entities the highlighter emits put
 * back. Used in built mode to compare the coloured block with the template it
 * came from, which is the whole claim — the colour is added, the text is not
 * touched.
 */
const textOf = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const attrs = (tag) => {
  const found = {};
  for (const match of tag.matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)) found[match[1].toLowerCase()] = match[2];
  return found;
};

/** The content of `<meta property="NAME" content="…">`, or null. */
const metaContent = (name) => new RegExp(`<meta property="${name}" content="([^"]*)"`, 'i').exec(html)?.[1] ?? null;

/* ------------------------------------------------------------------ *
 * Both modes: the document itself
 * ------------------------------------------------------------------ */

if (!/<html lang="[a-z-]+"/i.test(html)) fail('index.html: <html> needs a lang');
if (!/<meta name="viewport" content="[^"]*width=device-width/i.test(html)) fail('index.html: no responsive viewport meta');
if (!/<meta name="description" content="[^"]{20,}"/i.test(html)) fail('index.html: no meta description');
const title = /<title>([^<]*)<\/title>/i.exec(html);
if (!title || title[1].trim().length < 10) fail('index.html: no usable <title>');

const h1s = html.match(/<h1[\s>]/gi)?.length ?? 0;
if (h1s !== 1) fail(`index.html: expected exactly one <h1>, found ${h1s}`);

// One script, inline, and it exists for one thing: the video dialog a card opens
// into. The page is otherwise HTML and a stylesheet, and the footer says so — an
// external script, a second inline one, or a `src=` is a different page and has to
// come with a new sentence rather than slip in.
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
if (scripts.length > 1) fail(`index.html: expected at most one <script>, found ${scripts.length}`);
for (const [, scriptAttrs, body] of scripts) {
  if (/\bsrc\s*=/i.test(scriptAttrs)) fail('index.html: the dialog script must be inline, not a second request');
  if (/\btype\s*=\s*"(?!text\/javascript)/i.test(scriptAttrs)) fail('index.html: unexpected <script type>');
  // The job is the dialog, so the proof is in the body: a second script that
  // happens to leave `showModal()` elsewhere on the page does not qualify.
  if (!/showModal\(\)/.test(body)) {
    fail('index.html: a <script> appeared that is not the video dialog; the footer claims a page of HTML, a stylesheet and that one script');
  }
}

// Every in-page anchor must land on something. A dead `#how` is a nav that does
// nothing, which is worse than no nav.
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
for (const match of html.matchAll(/href="#([^"]+)"/g)) {
  if (!ids.has(match[1])) fail(`index.html: href="#${match[1]}" names no id`);
}

/* ------------------------------------------------------------------ *
 * Template mode: the slots the builder fills
 * ------------------------------------------------------------------ */

const SLOTS = ['styles', 'hero', 'gallery', 'themes', 'version'];
if (!BUILT) {
  for (const slot of SLOTS) {
    const found = html.split(`<!-- site:${slot} -->`).length - 1;
    if (found !== 1) fail(`index.html: <!-- site:${slot} --> must appear exactly once (found ${found})`);
  }
  if (!existsSync(path.join(root, 'style.css'))) fail('site/style.css is missing');
  if (!/\bhref="style\.css"/.test(html)) fail('index.html: does not reference style.css');
  // The plan block is the page's one piece of source, and the build colours it by
  // parsing it. So: exactly one marker — the build replaces only the first, and a
  // second one would be left grey with nothing to say so — a closing tag, and it
  // has to parse, because the highlighter reads JSON and a typo would otherwise be
  // coloured as though it were one.
  const blocks = html.match(/<code class="json">/g) ?? [];
  const plan = PLAN_BLOCK.exec(html);
  if (blocks.length !== 1) {
    fail(`index.html: <code class="json"> must appear exactly once (found ${blocks.length})`);
  } else if (!plan) {
    fail('index.html: the <code class="json"> block has no closing </code>');
  } else if (/<\/?(?:pre|code)\b|class="json"/.test(plan[1])) {
    // A missing `</code>` makes the lazy match run to the *next* block's close,
    // so the capture holds markup. Parsed as JSON it would report a syntax error
    // at a position that points at the wrong element.
    fail('index.html: the <code class="json"> block runs past its own element (a </code> is missing)');
  } else {
    try {
      JSON.parse(plan[1]);
    } catch (error) {
      fail(`index.html: the plan block is not valid JSON (${error.message})`);
    }
  }
} else {
  for (const slot of SLOTS) {
    if (html.includes(`<!-- site:${slot} -->`)) fail(`index.html: <!-- site:${slot} --> was not filled by the build`);
  }
  // Proves the build coloured the template's plan rather than shipping its plain
  // text, and that colouring did not alter it: the block's characters survive
  // every span, and the four roles the plan is made of are all present.
  const builtPlan = PLAN_BLOCK.exec(html);
  const templatePlan = (() => {
    try {
      return PLAN_BLOCK.exec(readFileSync(path.join(HERE, 'site', 'index.html'), 'utf8'));
    } catch {
      return null;
    }
  })();
  if (!templatePlan) {
    fail('index.html: cannot read site/index.html to compare the built plan against');
  } else if (!builtPlan) {
    fail('index.html: the built plan block is not a <code class="json"> block');
  } else if (textOf(builtPlan[1]) !== templatePlan[1]) {
    fail('index.html: the built plan block is not the template\'s text');
  }
  for (const role of ['j-k', 'j-s', 'j-n', 'j-p']) {
    if (!builtPlan?.[1].includes(`class="${role}"`)) {
      fail(`index.html: the built plan block has no ${role} token`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Both modes: no root-absolute URL, and every local reference resolves
 * ------------------------------------------------------------------ */

const VIRTUAL = /^(https?:|mailto:|data:|tel:|javascript:|#)/i;
const localPath = (raw) => {
  const clean = raw.split('#')[0].split('?')[0];
  if (!clean || clean === './') return null;
  return path.resolve(root, clean);
};

let checked = 0;
// `poster` is in here on purpose: it is a URL the browser fetches to draw a
// video before play, so it has the same rules as `src` — a root-absolute one
// 404s on a project site just as a stylesheet would.
for (const match of html.matchAll(/(href|src|poster)="([^"]+)"/g)) {
  const [, attribute, value] = match;
  if (VIRTUAL.test(value)) {
    // `//host/x` is protocol-relative: not ours, and not how a project site links.
    if (value.startsWith('//')) fail(`index.html: ${attribute}="${value}" is protocol-relative; use an absolute https URL`);
    continue;
  }
  if (value.startsWith('/')) {
    fail(`index.html: ${attribute}="${value}" is root-absolute — Pages serves this repo from a sub-path, so it would 404`);
    continue;
  }
  const resolved = localPath(value);
  if (!resolved) continue;
  if (!existsSync(resolved)) {
    fail(`index.html: ${attribute}="${value}" names nothing at ${path.relative(HERE, resolved)}`);
    continue;
  }
  checked += 1;
}

// The social card is an absolute URL on purpose (crawlers do not resolve
// relative ones), so it is checked through the path it maps to instead.
const og = /<meta property="og:image" content="([^"]+)"/i.exec(html);
if (!og) {
  fail('index.html: no og:image');
} else {
  const file = og[1].replace(/^https:\/\/mkucharz\.github\.io\/ui-path-recorder\//, '');
  if (!file.startsWith('assets/')) {
    fail(`index.html: og:image is not under assets/ (${og[1]})`);
  } else if (BUILT && !existsSync(path.resolve(root, file))) {
    fail(`index.html: og:image "${file}" does not exist`);
  } else if (BUILT) {
    // The declared size is what a crawler lays the card out with, and it is a
    // claim about a file this build recorded: a plan whose viewport changed would
    // break it silently, and the card would be cropped on every share.
    const declaredWidth = metaContent('og:image:width');
    const declaredHeight = metaContent('og:image:height');
    const png = readFileSync(path.resolve(root, file));
    const actual = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    if (!declaredWidth || !declaredHeight) fail('index.html: og:image has no declared og:image:width/height');
    else if (Number(declaredWidth) !== actual.width || Number(declaredHeight) !== actual.height) {
      fail(`index.html: og:image is ${actual.width}×${actual.height} but declared ${declaredWidth}×${declaredHeight}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Built mode: the media contract
 * ------------------------------------------------------------------ */

if (BUILT) {
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const a = attrs(tag);
    if (!a.alt || !a.alt.trim()) fail(`index.html: <img src="${a.src ?? '?'}"> has no alt`);
    if (!a.width || !a.height) fail(`index.html: <img src="${a.src ?? '?'}"> has no width/height (it would shift the page)`);
    if (a.src && !/^(https?:|data:|\/)/.test(a.src) && !existsSync(path.resolve(root, a.src))) {
      fail(`index.html: <img src="${a.src}"> does not exist`);
    }
  }

  for (const block of html.match(/<video\b[^>]*>[\s\S]*?<\/video>/gi) ?? []) {
    const tag = /^<video\b[^>]*>/i.exec(block)[0];
    // The dialog's player is the one video with no source in the document: the
    // card hands it one on open, so nothing is fetched by a reader who did not
    // ask. It says so with `data-player`, and it is hidden until then, which is
    // why the blank-box rule below does not apply to it either.
    if (/\bdata-player\b/i.test(tag)) continue;
    const open = attrs(tag);
    // A poster is a URL, so the scan above already proved it is relative and
    // resolves. This asks whether it is there at all.
    if (!open.poster) fail('index.html: a <video> has no poster (a reader who cannot play it, or who asked for reduced motion, sees a blank box)');
    if (!/<source\b[^>]*src="/i.test(block)) fail('index.html: a <video> has no <source>');
  }

  // A run directory can hold `.vars.json` (values scraped off the page). The
  // builder copies an allowlist, and this is the check that the allowlist held.
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  for (const file of walk(root)) {
    if (path.basename(file) === '.vars.json') {
      fail(`${path.relative(HERE, file)}: a scraped-variable file reached the site`);
    }
  }
}

/* ------------------------------------------------------------------ */

process.stdout.write(`check-site: ${mode} ${path.relative(HERE, root)} — `);
if (failures.length) {
  process.stdout.write(`${failures.length} problem(s)\n\n`);
  for (const failure of failures) process.stderr.write(` - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`ok (${checked} local reference(s) resolve)\n`);
