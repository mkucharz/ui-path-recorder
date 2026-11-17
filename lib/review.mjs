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

  /**
   * The same figures, one at a time.
   *
   * A contact sheet answers "is this the right picture"; it does not answer "does
   * the path read in order", which is what a reviewer of a walkthrough is
   * actually deciding. So the figures get a second view: one screen at a time, in
   * the run's order, with the arrows and a thumbnail strip. It is built from the
   * shots themselves — ids, files, sizes, `expect` — so it cannot show a figure
   * the run did not take, and it cannot disagree with the tiles below it.
   *
   * Slide one and the thumbnail strip are rendered as real HTML, so without JS
   * the section is a list of links to the full images rather than a dead player;
   * the script only adds navigation.
   */
  const slideCaption = (shot) => {
    const css = Math.round(shot.width / scale);
    const expect = shot.expect.length
      ? ` · expected: ${shot.expect.map((e) => `<code>${esc(e)}</code>`).join(' ')}`
      : '';
    return `<b>${esc(shot.id)}</b> <span class=dim>${shot.width}×${shot.height}px · ${css}css · step ${shot.step}${expect}</span>`;
  };

  const first = shots[0];
  const deck =
    shots.length > 1
      ? `<section class="deck" id="deck">
<h2>The figures, one at a time <span class="dim">← → to move · click a thumbnail to jump</span> <button type="button" class="present" id="deck-present" title="Full screen (Esc to leave)">Present</button></h2>
<div class="deck-stage" id="deck-stage">
<img id="deck-img" src="${esc(first.file)}" alt="${esc(first.id)}" width="${first.width}" height="${first.height}">
<button type="button" class="nav prev" id="deck-prev" aria-label="Previous figure">‹</button>
<button type="button" class="nav next" id="deck-next" aria-label="Next figure">›</button>
<span class="deck-count" id="deck-count" aria-live="polite"><b>1</b> / ${shots.length}</span>
</div>
<p class="deck-cap" id="deck-cap">${slideCaption(first)}</p>
<ol class="deck-strip" id="deck-strip">${shots
          .map(
            (shot, index) =>
              `<li><a href="${esc(shot.file)}" data-index="${index}"${index === 0 ? ' aria-current="true"' : ''}><img src="${esc(shot.file)}" alt="" loading="lazy"><span>${esc(shot.id)}</span></a></li>`,
          )
          .join('')}</ol>
</section>`
      : '';

  // The slide's own data, rather than a DOM to scrape: one caption string per
  // figure, already escaped here where the plan is in scope. `<` is escaped again
  // so a caption can never close the script tag it travels in.
  const deckData =
    shots.length > 1
      ? `<script type="application/json" id="deck-data">${JSON.stringify(
          shots.map((shot) => ({
            file: shot.file,
            id: shot.id,
            width: shot.width,
            height: shot.height,
            cap: slideCaption(shot),
          })),
        ).replace(/</g, '\\u003c')}</script>`
      : '';

  const deckScript =
    shots.length > 1
      ? `<script>
  // A review is read in order, so the figures can be walked in order. Arrows move
  // (not while a player or a field has focus — those own the arrows), a thumbnail
  // jumps, and the slide is in the URL (#fig-2) so one can be pointed at.
  (() => {
    const deck = document.getElementById('deck');
    if (!deck) return;
    const data = JSON.parse(document.getElementById('deck-data').textContent);
    if (data.length < 2) return;
    const img = document.getElementById('deck-img');
    const cap = document.getElementById('deck-cap');
    const count = document.getElementById('deck-count');
    const stage = document.getElementById('deck-stage');
    const nav = { prev: document.getElementById('deck-prev'), next: document.getElementById('deck-next') };
    const thumbs = [...document.querySelectorAll('#deck-strip a')];
    // document.fullscreenElement rather than a :fullscreen match: one is a
    // property every engine has, the other a selector that older WebKit rejects
    // outright — and a throw inside a keydown handler is a page that stops
    // responding to keys.
    const presented = () => document.fullscreenElement === deck;

    const fromHash = () => {
      const match = /^#fig-(\\d+)$/.exec(location.hash);
      const index = match ? Number(match[1]) - 1 : 0;
      return Number.isInteger(index) && index >= 0 && index < data.length ? index : 0;
    };
    let at = fromHash();

    function show(index, { hash = true } = {}) {
      at = (index + data.length) % data.length;
      const slide = data[at];
      // Size before src, so the stage does not jump between a portrait crop and
      // a full frame while the next file loads.
      img.width = slide.width;
      img.height = slide.height;
      img.src = slide.file;
      img.alt = slide.id;
      cap.innerHTML = slide.cap;
      count.innerHTML = '<b>' + (at + 1) + '</b> / ' + data.length;
      for (const [i, thumb] of thumbs.entries()) thumb.setAttribute('aria-current', String(i === at));
      // replaceState rather than a hash assignment: stepping through the figures
      // is not something the back button should have to be pressed through.
      if (hash) {
        try {
          history.replaceState(null, '', '#fig-' + (at + 1));
        } catch {
          /* a file:// page or an opaque origin */
        }
      }
    }

    nav.prev.addEventListener('click', () => show(at - 1));
    nav.next.addEventListener('click', () => show(at + 1));
    for (const [index, thumb] of thumbs.entries()) {
      thumb.addEventListener('click', (event) => {
        event.preventDefault();
        show(index);
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target.closest && event.target.closest('video, input, textarea, select')) return;
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        show(event.key === 'Home' ? 0 : data.length - 1);
        return;
      }
      const step = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }[event.key];
      // Space is the page's own scroll key; it advances only in presenter mode,
      // where there is no page to scroll.
      const present = event.key === ' ' && presented();
      if (!step && !present) return;
      event.preventDefault();
      show(at + (step ?? 1));
    });

    const presentButton = document.getElementById('deck-present');
    if (presentButton) {
      presentButton.addEventListener('click', () => {
        if (deck.requestFullscreen) deck.requestFullscreen().catch(() => {});
      });
    }
    // In presenter mode a click on the figure is the remote's next button: it is
    // the one place where clicking the picture is not "open it larger".
    if (stage) {
      stage.addEventListener('click', (event) => {
        if (!presented()) return;
        if (event.target.closest('.nav, a')) return;
        show(at + 1);
      });
    }

    // The controls exist only once they work, so a JS-off reader gets links
    // instead of buttons that do nothing.
    deck.classList.add('live');
    show(at, { hash: false });
  })();
</script>`
      : '';

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
  .deck { margin: 2rem 0 1rem }
  .deck h2 { display: flex; flex-wrap: wrap; align-items: baseline; gap: .6rem; margin: 0 0 .5rem }
  .deck h2 .dim { font-weight: 400; font-size: .78rem }
  .deck .present, .deck .nav { font: inherit; color: #cfd6e4; background: #1b2130;
        border: 1px solid #2b3549; border-radius: .35rem; cursor: pointer }
  .deck .present { margin-left: auto; padding: .15rem .6rem; font-size: .76rem }
  .deck .nav, .deck .deck-count { display: none }
  .deck-stage { position: relative; display: grid; place-items: center; min-height: 160px;
        background: #05070c; border: 1px solid #202839; border-radius: .5rem; overflow: hidden }
  .deck-stage img { display: block; width: auto; height: auto; max-width: 100%;
        max-height: min(74vh, 760px); padding: 1rem }
  .deck.live .nav { display: grid; place-items: center; position: absolute; top: 50%;
        transform: translateY(-50%); width: 2.4rem; height: 2.4rem; padding: 0;
        font-size: 1.5rem; line-height: 1; background: #0b0e14cc; opacity: .7 }
  .deck.live .nav:hover, .deck .present:hover { opacity: 1; background: #232d40 }
  .deck .nav.prev { left: .6rem }
  .deck .nav.next { right: .6rem }
  .deck.live .deck-count { display: block; position: absolute; right: .6rem; bottom: .5rem;
        padding: .1rem .45rem; border-radius: .25rem; background: #0b0e14cc;
        font-size: .75rem; font-variant-numeric: tabular-nums }
  .deck-cap { margin: .6rem 0 0; font-size: .8rem; min-height: 1.4em }
  .deck-strip { display: flex; gap: .5rem; margin: .7rem 0 0; padding: 0 0 .2rem;
        list-style: none; overflow-x: auto }
  .deck-strip a { display: block; padding: .2rem; border: 1px solid #202839;
        border-radius: .35rem; color: #7d8799; font-size: .68rem; text-decoration: none }
  .deck-strip a[aria-current="true"] { border-color: #7aa2f7; color: #cfd6e4 }
  .deck-strip img { display: block; height: 52px; width: auto; max-width: 104px;
        object-fit: contain; background: #05070c; border-radius: .2rem }
  .deck-strip span { display: block; margin-top: .15rem; text-align: center }
  .deck:fullscreen { display: flex; flex-direction: column; justify-content: center;
        padding: 2rem; background: #0b0e14 }
  .deck:fullscreen .deck-stage { border: 0 }
  .deck:fullscreen .deck-stage img { max-height: 76vh }
</style>
<h1>${esc(plan.tutorial ?? plan.instance ?? 'capture')} — ${shots.length} figure(s)${videos.length ? `, ${videos.length} video(s)` : ''}</h1>
<p class="meta">${esc(path.basename(planPath))} · ${esc(baseUrl ?? plan.baseUrl)} · ${vp?.width}×${vp?.height} @${scale}x · ${esc(plan.locale ?? 'en-US')} · ${esc(plan.colorScheme ?? 'dark')} · ${(elapsed / 1000).toFixed(0)}s${timeline?.toJSON?.().seed ? ` · seed ${esc(timeline.toJSON().seed)}` : ''}</p>
<p class="meta">Click a figure for its full size. Sizes are captured pixels, then the size the app drew on screen (what the document will show).</p>
${extraLinks}
${reel}
${deck}
${deckData}
<div class="grid">
${rows}
</div>
${deckScript}
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
