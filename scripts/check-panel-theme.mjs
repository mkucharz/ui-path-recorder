#!/usr/bin/env node
/**
 * Check the chrome presets in `themes/`.
 *
 * Two things rot independently, and both are invisible at run time:
 *
 * 1. A preset names a token the stylesheet no longer reads, or carries a value
 *    that cannot end its own declaration. `lib/theme.mjs` refuses both when it
 *    loads the file, so a run would fail — but only for the plan that names that
 *    preset. Checking every preset here makes it a build failure instead.
 * 2. A preset copies values from a product's theme block. When that product
 *    changes a colour, the copy keeps rendering the old one and nobody notices,
 *    because a screenshot looks fine either way. `--app-css` compares each
 *    derived value against the stylesheet it came from.
 *
 * Usage:
 *   node scripts/check-panel-theme.mjs                     # shape of every preset
 *   node scripts/check-panel-theme.mjs --app-css PATH      # + values against PATH
 *
 * Exit: 0 ok, 1 a preset is wrong, 2 cannot proceed (unreadable --app-css or an
 * unreadable themes/ directory).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THEMES = path.resolve(HERE, '..', 'themes');

/** Panel token ← the CSS custom property in the product stylesheet it was read from. */
const DERIVED = [
  ['--pc-surface', '--color-base-100'],
  ['--pc-surface-strong', '--color-base-200'],
  ['--pc-text', '--color-base-content'],
  ['--pc-accent', '--color-primary'],
  ['--pc-mark', '--color-primary-content'],
  ['--pc-radius', '--radius-box'],
];

function usage(problem) {
  process.stderr.write(`check-panel-theme: ${problem}\n`);
  process.stderr.write('usage: node scripts/check-panel-theme.mjs [--app-css PATH]\n');
  process.exit(2);
}

/** `--help` is a request, not a mistake: print and succeed. */
function help() {
  process.stdout.write(
    'usage: node scripts/check-panel-theme.mjs [--app-css PATH]\n\n' +
      '  (no arguments)   check the shape of every preset in themes/\n' +
      '  --app-css PATH   also compare each derived value against the product stylesheet\n\n' +
      'exit: 0 ok · 1 a preset is wrong · 2 cannot proceed\n',
  );
  process.exit(0);
}

let appCss = null;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--app-css') appCss = process.argv[++i];
  else if (arg === '--help' || arg === '-h') help();
  else usage(`unknown argument ${JSON.stringify(arg)}`);
}

// Imported after the argument check so a bad invocation does not depend on the
// module graph being loadable.
const { PANEL_TOKENS, tokenValueProblem } = await import('../lib/theme.mjs');

let files;
try {
  files = readdirSync(THEMES).filter((name) => name.endsWith('.json')).sort();
} catch (error) {
  usage(`cannot read ${THEMES}: ${error.message}`);
}
if (!files.length) usage(`no presets in ${THEMES}`);

const failures = [];
const presets = new Map();

for (const file of files) {
  const name = file.replace(/\.json$/, '');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.join(THEMES, file), 'utf8'));
  } catch (error) {
    failures.push(`themes/${file}: not readable JSON — ${error.message}`);
    continue;
  }
  const tokens = parsed?.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    failures.push(`themes/${file}: needs a "tokens" object`);
    continue;
  }
  if (!Object.keys(tokens).length) failures.push(`themes/${file}: "tokens" is empty`);
  for (const [token, value] of Object.entries(tokens)) {
    if (!PANEL_TOKENS.includes(token)) {
      failures.push(`themes/${file}: "${token}" is not a chrome token (known: ${PANEL_TOKENS.join(', ')})`);
      continue;
    }
    const problem = tokenValueProblem(value);
    if (problem) failures.push(`themes/${file}: "${token}" ${problem}`);
  }
  // A preset that does not say where it came from cannot be checked later.
  if (!parsed?.source) failures.push(`themes/${file}: needs a "source" saying which stylesheet the values came from`);
  presets.set(name, tokens);
}

let derived = 0;
if (appCss) {
  let css;
  try {
    css = readFileSync(appCss, 'utf8');
  } catch (error) {
    usage(`cannot read --app-css ${appCss}: ${error.message}`);
  }
  const valueOf = (property) => {
    // The first declaration of the property is the theme block's: the presets are
    // read from a daisyUI theme, which is declared before anything consumes it.
    const match = new RegExp(`${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;]+);`).exec(css);
    return match ? match[1].trim() : null;
  };
  const memory = presets.get('memory');
  if (!memory) {
    failures.push('--app-css compares the "memory" preset, and themes/memory.json was not loaded');
  } else {
    for (const [token, property] of DERIVED) {
      const source = valueOf(property);
      if (source === null) {
        failures.push(`${appCss}: no ${property} declaration to compare with`);
        continue;
      }
      const value = memory[token];
      if (!value) {
        failures.push(`themes/memory.json: no "${token}", so ${property} has nowhere to land`);
        continue;
      }
      // Substring, not equality: a preset is allowed to wrap the value (`… / .9`,
      // `color-mix(in oklab, … 12%, transparent)`), so the comparison drops the
      // source's closing parenthesis — the number is the part that must survive.
      // What it may not do is carry a number the stylesheet no longer says.
      const needle = source.replace(/\)$/, '');
      if (!value.includes(needle)) {
        failures.push(
          `themes/memory.json: "${token}" does not contain ${property} ${JSON.stringify(source)} any more\n` +
            `  preset says: ${JSON.stringify(value)}`,
        );
        continue;
      }
      derived += 1;
    }
  }
}

for (const [name, tokens] of presets) {
  process.stdout.write(`themes/${name}.json  ${Object.keys(tokens).length} tokens, all known\n`);
}
if (appCss) {
  process.stdout.write(`  ${derived} derived value(s) still match ${appCss}\n`);
} else {
  process.stdout.write('  values not compared (pass --app-css PATH to check them against a stylesheet)\n');
}

if (failures.length) {
  process.stderr.write('\nFAILURES:\n');
  for (const failure of failures) process.stderr.write(` - ${failure}\n`);
  process.exit(1);
}
process.stdout.write('ok\n');
