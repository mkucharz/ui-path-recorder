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
 * @param {{width:number,height:number}} [opts.viewport] The viewport a video was recorded at.
 * @returns {Promise<string>} Path written.
 */
export async function writeReview({
  plan,
  planPath,
  shots,
  scale,
  outDir,
  baseUrl,
  elapsed,
  extras = [],
  timeline = null,
  videos = [],
  poster = null,
  viewport = plan?.viewport ?? null,
}) {
  // A plan may omit `viewport`, so the runner passes the resolved one; the meta
  // line must not print "undefined×undefined" when it does.
  const vp = viewport ?? plan?.viewport ?? null;
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

  /**
   * The video a reviewer has to watch before a figure reaches a document, with a
   * chapter list built from the run's own timeline. A chapter is a real seek
   * (`#t=`), so checking that the pointer follows the flow is a click rather
   * than a scrub.
   */
  const filesByPage = new Map(videos.map((video) => [video.page, video.file]));
  const primaryVideo = videos[0]?.file ?? null;
  const chapters = timeline?.chapters?.() ?? [];
  const chapterList = chapters.length
    ? `<ol class="chapters">${chapters
        .map((chapter) => {
          const file = filesByPage.get(chapter.page) ?? primaryVideo;
          const seconds = (chapter.atMs / 1000).toFixed(1);
          const shot = chapter.shot ? ` <code>${esc(chapter.shot)}</code>` : '';
          return `<li><a href="${esc(file)}#t=${seconds}">${esc(chapter.name)}</a>${shot} <span class=dim>${seconds}s · ${esc(chapter.action)}</span></li>`;
        })
        .join('')}</ol>`
    : '';

  /**
   * The checklist the recording ticks, read back from the same timeline the
   * panel was drawn from. It is the one part of the video a reviewer cannot check
   * by looking at a still: the list is only right if every row is ticked at the
   * moment the step that completes it starts, so each row seeks there.
   */
  const checks = timeline?.checks?.() ?? [];
  const checkList = checks.length
    ? `<div class="chapterwrap"><b class=dim>checklist</b><ol class="chapters checks">${checks
        .map((check) => {
          const file = filesByPage.get(check.page) ?? primaryVideo;
          const seconds = (check.atMs / 1000).toFixed(1);
          return `<li><a href="${esc(file)}#t=${seconds}">${esc(check.item)}</a> <span class=dim>${seconds}s</span></li>`;
        })
        .join('')}</ol></div>`
    : '';

  const players = videos.length
    ? videos
        .map(
          (video, index) => `<figure class="reel"><video id="${index === 0 ? 'reel' : `reel-${index}`}" controls preload="metadata"${
            poster ? ` poster="${esc(poster)}"` : ''
          }><source src="${esc(video.file)}" type="video/webm">${
            // Off by default on purpose: the recording already draws its
            // subtitles in, and a default track would paint a second, native
            // caption over the same corner. Switching it on is how a reviewer
            // checks the file's timing against what is on screen.
            video.captionsFile
              ? `<track kind="captions" src="${esc(video.captionsFile)}" srclang="${esc((plan.locale ?? 'en-US').split('-')[0])}" label="Captions">`
              : ''
          }</video>
  <figcaption><b>${esc(video.file)}</b> <span class=dim>${video.page > 1 ? `tab ${video.page}` : 'main tab'}${timeline?.toJSON?.().seed ? ` · seed ${esc(timeline.toJSON().seed)}` : ''}${
    video.captionsFile ? ` · <a href="${esc(video.captionsFile)}">captions</a>` : ''
  }</span></figcaption></figure>`,
        )
        .join('\n')
    : '';

  const reel = videos.length
    ? `<section class="reelwrap"><h2>The walkthrough</h2><div class="reels">${players}</div>${
        chapterList ? `<div class="chapterwrap">${chapterList}</div>` : ''
      }${checkList}</section>`
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
  h2 { font-size: .9rem; margin: 2rem 0 .5rem; color: #cfd6e4 }
  .reels { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)) }
  .reelwrap { margin-bottom: 2rem }
  figure.reel video { display: block; width: 100%; height: auto; background: #000; border: 1px solid #202839; border-radius: .5rem; object-fit: contain${vp ? `; aspect-ratio: ${vp.width} / ${vp.height}` : ''} }
  .chapterwrap { margin-top: 1rem; background: #12161f; border: 1px solid #202839; border-radius: .5rem; padding: .75rem 1rem }
  .chapterwrap > b.dim { display: block; margin-bottom: .35rem; font-size: .72rem; letter-spacing: .08em; text-transform: uppercase }
  ol.chapters { margin: 0; padding-left: 1.4rem; columns: 2; column-gap: 2rem; font-size: .8rem }
  ol.chapters li { break-inside: avoid; margin-bottom: .3rem }
</style>
<h1>${esc(plan.tutorial ?? plan.instance ?? 'capture')} — ${shots.length} figure(s)${videos.length ? `, ${videos.length} video(s)` : ''}</h1>
<p class="meta">${esc(path.basename(planPath))} · ${esc(baseUrl ?? plan.baseUrl)} · ${vp?.width}×${vp?.height} @${scale}x · ${esc(plan.locale ?? 'en-US')} · ${esc(plan.colorScheme ?? 'dark')} · ${(elapsed / 1000).toFixed(0)}s${timeline?.toJSON?.().seed ? ` · seed ${esc(timeline.toJSON().seed)}` : ''}</p>
<p class="meta">Click a figure for its full size. Sizes are captured pixels, then the size the app drew on screen (what the document will show).</p>
${extraLinks}
${reel}
<div class="grid">
${rows}
</div>
${
  chapterList || checkList
    ? `<script>
  // A chapter — and a checklist row — is a seek into the player, not a trip to
  // the raw file: a reviewer jumps around a recording, and leaving the page on
  // every click loses the figure list they were comparing against. The href
  // alone still works (video/01-main.webm#t=4.6) when this script does not run.
  (() => {
    const players = [...document.querySelectorAll('figure.reel video')];
    for (const link of document.querySelectorAll('ol.chapters a[href*="#t="]')) {
      link.addEventListener('click', (event) => {
        const [file, seconds] = link.getAttribute('href').split('#t=');
        const player = players.find((video) => video.querySelector('source')?.getAttribute('src') === file);
        if (!player || !Number.isFinite(Number(seconds))) return;
        event.preventDefault();
        // One recording at a time: two tabs playing at once is noise, not a
        // comparison.
        for (const other of players) if (other !== player) other.pause();
        player.currentTime = Number(seconds);
        player.play().catch(() => {});
        player.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  })();
</script>`
    : ''
}`;

  const file = path.join(outDir, 'review.html');
  await writeFile(file, html);
  return file;
}
