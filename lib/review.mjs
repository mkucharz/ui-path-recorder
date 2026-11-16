/**
 * The contact sheet for a capture run.
 *
 * A run's figures must be reviewable *before* they reach a document, and the
 * reviewer is usually looking for one thing: does this picture show what the
 * text says it shows. So every tile carries the id, the real pixel size, the
 * size the app drew on screen (what the page will render), and the `expect`
 * strings the plan asserted on that screen — a stale figure is then visible by
 * reading rather than by squinting.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * @param {object} opts
 * @param {any} opts.plan
 * @param {string} opts.planPath
 * @param {Array<{id: string, file: string, step: number, expect: string[], width: number, height: number}>} opts.shots
 * @param {number} opts.scale Capture device pixel ratio.
 * @param {string} opts.outDir
 * @param {string} [opts.baseUrl] The resolved base URL (the plan's may be a `${VAR}` placeholder).
 * @param {number} opts.elapsed Milliseconds.
 * @param {string[]} [opts.extras] Additional artefacts to link (video, trace).
 * @returns {Promise<string>} Path written.
 */
export async function writeReview({ plan, planPath, shots, scale, outDir, baseUrl, elapsed, extras = [] }) {
  const rows = shots
    .map((s) => {
      const css = Math.round(s.width / scale);
      const expect = s.expect.length
        ? `<br><span class=dim>expected: ${s.expect.map((e) => `<code>${esc(e)}</code>`).join(' ')}</span>`
        : '';
      return `<figure><a href="${esc(s.file)}"><img src="${esc(s.file)}" loading="lazy" alt="${esc(s.id)}"></a>
  <figcaption><b>${esc(s.id)}</b><br><span class=dim>${s.width}×${s.height}px · ${css}css · step ${s.step}</span>${expect}</figcaption></figure>`;
    })
    .join('\n');

  const extraLinks = extras.length
    ? `<p class="meta">Also in this run: ${extras.map((e) => `<a href="${esc(e)}">${esc(e)}</a>`).join(' · ')}</p>`
    : '';

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Capture review — ${esc(plan.tutorial ?? plan.instance ?? 'run')}</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; padding: 2rem; background: #0b0e14; color: #cfd6e4;
         font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem }
  p.meta { margin: 0 0 .5rem; color: #7d8799; font-size: .8rem }
  p.meta:last-of-type { margin-bottom: 2rem }
  a { color: #7aa2f7 }
  .grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)) }
  figure { margin: 0; background: #12161f; border: 1px solid #202839; border-radius: .5rem; overflow: hidden }
  figure img { display: block; width: 100%; height: auto; background: #0b0e14 }
  figcaption { padding: .6rem .75rem; font-size: .78rem; border-top: 1px solid #202839 }
  .dim { color: #7d8799 }
  code { background: #1b2130; padding: .05rem .25rem; border-radius: .2rem }
</style>
<h1>${esc(plan.tutorial ?? plan.instance ?? 'capture')} — ${shots.length} figure(s)</h1>
<p class="meta">${esc(path.basename(planPath))} · ${esc(baseUrl ?? plan.baseUrl)} · ${plan.viewport?.width}×${plan.viewport?.height} @${scale}x · ${esc(plan.locale ?? 'en-US')} · ${esc(plan.colorScheme ?? 'dark')} · ${(elapsed / 1000).toFixed(0)}s</p>
<p class="meta">Click a figure for its full size. Sizes are captured pixels, then the size the app drew on screen (what the document will show).</p>
${extraLinks}
<div class="grid">
${rows}
</div>`;

  const file = path.join(outDir, 'review.html');
  await writeFile(file, html);
  return file;
}
