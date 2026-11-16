/**
 * The smallest possible stand-in for "a real app": one static page, served on an
 * ephemeral port so a test run never collides with anything.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const HTML = path.join(import.meta.dirname, 'fixture', 'index.html');

/** Start the fixture server. Returns its base URL and a close() function. */
export async function startFixtureServer(port = 0) {
  const html = await readFile(HTML);
  const server = createServer((req, res) => {
    // One page for every path: the plan rewrites `?token=` onto the same URL.
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

// `node test/serve.mjs --port 8099` — a fixture to try the runner against with
// no account, no network and nothing to install.
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const at = process.argv.indexOf('--port');
  const server = await startFixtureServer(at === -1 ? 8099 : Number(process.argv[at + 1]));
  console.log(`\n  fixture app: ${server.url}`);
  console.log(`  try it:\n`);
  console.log(`    FIXTURE_URL=${server.url} FIXTURE_PASSWORD=correct-horse \\`);
  console.log(`      node scripts/path-shots.mjs test/plans/fixture.plan.json --review\n`);
}
