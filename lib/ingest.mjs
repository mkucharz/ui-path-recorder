#!/usr/bin/env node
/**
 * ingest — turn a capture run's PNGs into web assets and a manifest.
 *
 * A capture is 4x by design (a page zooms into a figure, and a 1x screenshot
 * turns to mush the moment it is scaled). Serving that PNG is wasteful, so this
 * writes a WebP beside each original and records both sizes in `manifest.json`:
 *
 *   width/height   real pixels of the WebP — bounds how far a figure may be zoomed
 *   cssWidth/cssHeight  the size the app drew on screen — the figure's true size
 *
 * The second pair comes from the `.shots.json` the runner writes next to the
 * pictures; without it every image is assumed 1:1, which is correct for a
 * hand-taken capture and wrong for a scripted one.
 *
 *     node lib/ingest.mjs --src captures/run-2026-01-01T10-00 --out public/figures
 *     node lib/ingest.mjs --src captures/run --max-width 3200
 *
 * Requires `sharp`.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : (argv[at + 1] ?? null);
};
const all = (name) => argv.reduce((acc, arg, i) => (arg === name ? acc.concat(argv[i + 1]) : acc), []);

const sources = all('--src').flatMap((s) => s.split(',')).filter(Boolean);
const outRoot = flag('--out');
const maxWidth = Number(flag('--max-width', 2400));
const quality = Number(flag('--quality', 82));

if (!sources.length) {
  console.error('usage: node lib/ingest.mjs --src <dir>[,<dir>] [--out <dir>] [--max-width 2400] [--quality 82]');
  process.exit(2);
}

const RASTER = /\.(png|jpe?g)$/i;
let total = 0;

for (const srcDir of sources.map((s) => path.resolve(s))) {
  const outDir = outRoot ? path.join(path.resolve(outRoot), path.basename(srcDir)) : null;
  if (outDir) await mkdir(outDir, { recursive: true });

  // The runner records the device pixel ratio beside the pictures it wrote.
  // A hand-taken capture has no entry and is 1:1 by definition.
  let scales = {};
  try {
    scales = JSON.parse(await readFile(path.join(srcDir, '.shots.json'), 'utf8'));
  } catch {
    /* no scripted capture here */
  }

  const files = (await readdir(srcDir).catch(() => [])).filter((f) => RASTER.test(f)).sort();
  if (!files.length) {
    console.log(`${path.relative(process.cwd(), srcDir)}: no rasters found — nothing to do`);
    continue;
  }

  const manifest = {};
  for (const file of files) {
    const webp = file.replace(RASTER, '.webp');
    const from = path.join(srcDir, file);
    const pipeline = () => sharp(from).resize({ width: maxWidth, withoutEnlargement: true }).webp({ quality, effort: 5 });
    const info = await pipeline().toFile(path.join(srcDir, webp));
    if (outDir) await pipeline().toFile(path.join(outDir, webp));

    // Computed from the *captured* size, not the resized one, so a full-frame
    // shot that hits maxWidth still declares its real on-screen width.
    const recorded = scales[file.replace(RASTER, '')];
    const scale = recorded?.scale ?? 1;
    const captured = recorded?.width ?? info.width;
    const capturedHeight = recorded?.height ?? info.height;
    manifest[webp] = {
      width: info.width,
      height: info.height,
      cssWidth: Math.round(captured / scale),
      cssHeight: Math.round(capturedHeight / scale),
    };
    console.log(
      `${webp.padEnd(34)} ${info.width}x${info.height} @${scale}x → ${manifest[webp].cssWidth}css  ${Math.round(info.width ? info.size / 1024 : 0)}K`,
    );
    total += 1;
  }
  await writeFile(path.join(outDir ?? srcDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

console.log(`\n${total} image(s) → WebP + manifest.json`);
