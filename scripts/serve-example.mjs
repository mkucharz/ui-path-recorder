#!/usr/bin/env node
/**
 * Serve the shipped sign-in example so a plan can be run against it with no
 * account, no network call and no build.
 *
 *   node scripts/serve-example.mjs [--port 8100] [--variant current|refreshed|broken]
 *
 * The variant is a property of the *app being served*, not of the plan: running
 * the same plan against `--variant refreshed` is a run that only refreshes its
 * figures (the copy changed, the ids did not), and `--variant broken` is the run
 * that must fail (the password field is gone). Keep the plan out of it — a plan
 * that knows which build it is looking at proves nothing.
 */
import path from 'node:path';
import { startStaticServer } from '../lib/serve.mjs';

const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};

const variant = flag('--variant', 'current');
if (!['current', 'refreshed', 'broken'].includes(variant)) {
  console.error(`unknown variant "${variant}" — current, refreshed or broken`);
  process.exit(2);
}

const server = await startStaticServer({
  root: path.join(import.meta.dirname, '..', 'examples', 'signin'),
  port: Number(flag('--port', 8100)),
  transform: (html) => html.replaceAll('__VARIANT__', variant),
});

console.log(`\n  sign-in example: ${server.url}  (${variant})`);
console.log(`  try it:\n`);
console.log(`    SIGNIN_URL=${server.url} \\`);
console.log(`      node scripts/path-shots.mjs plans/examples/signin.plan.json --review\n`);
console.log(`  same path, Norwegian:\n`);
console.log(`    SIGNIN_URL=${server.url} \\`);
console.log(`      node scripts/path-shots.mjs plans/examples/signin-nb.plan.json --review\n`);
