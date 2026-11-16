/**
 * What a failure leaves behind.
 *
 * A plan for a flow nobody has scripted yet is wrong about a selector on the
 * first run. The useful output is then not the error message but the page: the
 * next edit can be made from evidence instead of somebody's description of what
 * they saw. Every failure writes three files sharing one stem —
 *
 *   <stamp>--<step>.png    the page as it looked
 *   <stamp>--<step>.html   its DOM
 *   <stamp>--<step>.txt    the error, the URL, and every control on screen
 *
 * — and the `.txt` is the one to read first: "on screen:" lists the buttons the
 * plan expected to find under a different name.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {object} opts
 * @param {import('playwright-core').Page} opts.page
 * @param {string} opts.dir Directory to write into (created if missing).
 * @param {string} opts.step Step label, e.g. "#8 deploy".
 * @param {string} opts.message The failure.
 * @returns {Promise<string>} The stem written, for the caller to log.
 */
export async function writeEvidence({ page, dir, step, message }) {
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stem = path.join(dir, `${stamp}--${String(step).replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`);
  const notes = [`step: ${step}`, `error: ${message}`];
  try {
    notes.push(`url: ${page.url()}`, `title: ${await page.title()}`);
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('a,button,[role=button],input,select,textarea')]
        // "on screen" has to mean on screen: a control in a hidden section is
        // not one the plan could have clicked, and listing it sends the reader
        // of the evidence after a control that was never there.
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => {
          const text = (el.innerText || el.value || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ');
          const name = el.getAttribute('name') ? ` name=${el.getAttribute('name')}` : '';
          const id = el.id ? ` #${el.id}` : '';
          const href = el.getAttribute('href') ? ` href=${el.getAttribute('href')}` : '';
          return `${el.tagName.toLowerCase()}${id}${name}${href} :: ${text.slice(0, 60)}`;
        })
        .filter((line) => line.split('::')[1].trim())
        .slice(0, 40),
    );
    notes.push('', 'on screen:', ...labels.map((l) => `  ${l}`));
    await page.screenshot({ path: `${stem}.png`, animations: 'disabled' });
    await writeFile(`${stem}.html`, await page.content());
  } catch (error) {
    notes.push(`(could not inspect the page: ${error.message})`);
  }
  await writeFile(`${stem}.txt`, notes.join('\n') + '\n');
  return stem;
}
