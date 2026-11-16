/**
 * The fixture server: the smallest possible stand-in for "a real app", served on
 * an ephemeral port so a test run never collides with anything.
 */
import path from 'node:path';
import { startStaticServer } from '../lib/serve.mjs';

const ROOT = path.join(import.meta.dirname, 'fixture');

/** Start the fixture server. Returns its base URL and a close() function. */
export function startFixtureServer(port = 0) {
  return startStaticServer({ root: ROOT, port });
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
