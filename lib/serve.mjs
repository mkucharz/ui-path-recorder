/**
 * The smallest static server a plan can run against: one directory, one page
 * for every path.
 *
 * A plan exercises a real browser against a real page, and both the test
 * fixture and the shipped example need the same twenty lines: bind an ephemeral
 * port, answer every request with `index.html`, let the query string carry the
 * state (`?lang=`, `?token=`). `transform` is where a caller makes one served
 * build differ from another — the sign-in example uses it to serve "the app
 * after the change" without teaching the plan about variants.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {object} opts
 * @param {string} opts.root Directory holding `index.html`.
 * @param {number} [opts.port] 0 binds an ephemeral port.
 * @param {(html: string) => string} [opts.transform] Rewrite the page as it is served.
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export async function startStaticServer({ root, port = 0, transform = (html) => html }) {
  const html = transform(await readFile(path.join(root, 'index.html'), 'utf8'));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address();
  return {
    url: `http://127.0.0.1:${bound}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
