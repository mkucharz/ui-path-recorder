/**
 * Plan loading, validation, and `${var}` expansion.
 *
 * A plan is data, so a mistyped key is invisible: `{"clickk": "#go"}` is a step
 * that does nothing and a plan that reports success. Everything here exists to
 * turn that class of mistake into a message naming the key, before a browser
 * opens.
 */
import { readFile } from 'node:fs/promises';
import { MAX_CAPTION_CHARS } from './captions.mjs';

/** Keys a plan may carry at the top level. */
const PLAN_KEYS = new Set([
  'tutorial',
  'description',
  'instance',
  'baseUrl',
  'locale',
  'timezoneId',
  'viewport',
  'colorScheme',
  'deviceScaleFactor',
  'pad',
  'maskColor',
  'themeStorage',
  'reducedMotion',
  'humanize',
  'vars',
  'steps',
]);

/** Keys a step may carry. Each is one action; order within a step is fixed by the runner. */
const STEP_KEYS = new Set([
  'name',
  'caption',
  'when',
  'goto',
  'fill',
  'type',
  'press',
  'click',
  'clickIfPresent',
  'clickNewPage',
  'pause',
  'setVar',
  'waitFor',
  'waitHidden',
  'mask',
  'expect',
  'hold',
  'shot',
]);

/** Keys a plan's `humanize` block may carry — see lib/human.mjs for the meaning. */
const HUMANIZE_KEYS = new Set([
  'enabled',
  'speed',
  'seed',
  'cursor',
  'clickRipple',
  'moveMs',
  'dwellMs',
  'pressMs',
  'afterMs',
  'typing',
  'shotHoldMs',
  'loadMs',
  'loadFade',
]);

const TYPING_KEYS = new Set(['minMs', 'maxMs', 'maxChars', 'longValueLead']);

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

export class PlanError extends Error {}

const fail = (msg) => {
  throw new PlanError(msg);
};

/**
 * The `humanize` block is the difference between a video a viewer can follow and
 * a cut of teleporting clicks, so a mistyped knob here is worth refusing too:
 * `{"humanzie": {...}}` would otherwise render the whole block inert.
 */
function validateHumanize(humanize, fail) {
  if (!humanize || typeof humanize !== 'object' || Array.isArray(humanize)) fail('"humanize" must be an object');
  for (const key of Object.keys(humanize)) {
    if (!HUMANIZE_KEYS.has(key)) {
      fail(`unknown "humanize" key "${key}" (allowed: ${[...HUMANIZE_KEYS].join(', ')})`);
    }
  }
  if (humanize.enabled !== undefined && typeof humanize.enabled !== 'boolean') fail('"humanize.enabled" must be true or false');
  if (humanize.speed !== undefined && (!isNumber(humanize.speed) || humanize.speed <= 0)) {
    fail('"humanize.speed" must be a positive number (1 is a natural pace, 20 is a test)');
  }
  if (humanize.seed !== undefined && (typeof humanize.seed !== 'string' || !humanize.seed)) {
    fail('"humanize.seed" must be a non-empty string — the same seed replays the same movement');
  }
  if (humanize.cursor !== undefined && !['arrow', 'none'].includes(humanize.cursor)) {
    fail(`"humanize.cursor" must be "arrow" or "none" (got ${JSON.stringify(humanize.cursor)})`);
  }
  if (humanize.clickRipple !== undefined && typeof humanize.clickRipple !== 'boolean') {
    fail('"humanize.clickRipple" must be true or false');
  }
  for (const key of ['moveMs', 'dwellMs', 'pressMs', 'afterMs']) {
    const range = humanize[key];
    if (range === undefined) continue;
    if (!Array.isArray(range) || range.length !== 2 || !range.every(isNumber)) {
      fail(`"humanize.${key}" must be a [min, max] pair of milliseconds`);
    }
    if (range[0] < 0 || range[1] < range[0]) fail(`"humanize.${key}" must have 0 <= min <= max (got ${JSON.stringify(range)})`);
  }
  for (const key of ['shotHoldMs', 'loadMs', 'loadFade']) {
    if (humanize[key] === undefined) continue;
    if (!isNumber(humanize[key]) || humanize[key] < 0) fail(`"humanize.${key}" must be a number of milliseconds >= 0`);
  }
  if (humanize.typing !== undefined) {
    const typing = humanize.typing;
    if (!typing || typeof typing !== 'object' || Array.isArray(typing)) fail('"humanize.typing" must be an object');
    for (const key of Object.keys(typing)) {
      if (!TYPING_KEYS.has(key)) fail(`unknown "humanize.typing" key "${key}" (allowed: ${[...TYPING_KEYS].join(', ')})`);
      if (!isNumber(typing[key]) || typing[key] < 0) fail(`"humanize.typing.${key}" must be a number >= 0`);
    }
    if (typing.minMs !== undefined && typing.maxMs !== undefined && typing.maxMs < typing.minMs) {
      fail('"humanize.typing.maxMs" must be >= "humanize.typing.minMs"');
    }
  }
}

/**
 * Validate a parsed plan. Throws PlanError naming the offending key.
 * @param {any} plan
 * @returns {{warnings: string[]}}
 */
export function validate(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('a plan must be a JSON object');
  const warnings = [];

  for (const key of Object.keys(plan)) {
    if (!PLAN_KEYS.has(key)) fail(`unknown top-level key "${key}" (allowed: ${[...PLAN_KEYS].join(', ')})`);
  }
  if (!plan.baseUrl) fail('a plan needs "baseUrl" (an absolute URL, or "${SOME_ENV_VAR}")');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) fail('a plan needs a non-empty "steps" array');

  if (plan.deviceScaleFactor !== undefined) {
    const s = plan.deviceScaleFactor;
    if (typeof s !== 'number' || s <= 0) fail('"deviceScaleFactor" must be a positive number');
    if (s < 2) warnings.push(`deviceScaleFactor ${s} — figures captured below 2x look soft when a page zooms in`);
  }
  if (plan.viewport) {
    for (const side of ['width', 'height']) {
      if (typeof plan.viewport[side] !== 'number') fail(`"viewport.${side}" must be a number`);
    }
  }
  if (plan.colorScheme && !['dark', 'light', 'no-preference'].includes(plan.colorScheme)) {
    fail(`"colorScheme" must be dark, light or no-preference (got ${JSON.stringify(plan.colorScheme)})`);
  }
  if (plan.reducedMotion !== undefined && !['reduce', 'no-preference'].includes(plan.reducedMotion)) {
    fail(`"reducedMotion" must be "reduce" or "no-preference" (got ${JSON.stringify(plan.reducedMotion)})`);
  }
  if (plan.humanize !== undefined) validateHumanize(plan.humanize, fail);

  const shotIds = new Set();
  plan.steps.forEach((step, i) => {
    const where = `step #${i + 1}${step?.name ? ` (${step.name})` : ''}`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) fail(`${where} must be an object`);
    const keys = Object.keys(step);
    const unknown = keys.filter((k) => !STEP_KEYS.has(k));
    if (unknown.length) {
      fail(`${where}: unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}\n  allowed: ${[...STEP_KEYS].join(', ')}`);
    }
    if (!keys.some((k) => k !== 'name' && k !== 'caption')) fail(`${where} does nothing — it has no action key`);

    // A caption is a subtitle: one line a viewer reads while watching, not a
    // paragraph. Refusing an over-long one here is cheaper than discovering it
    // as a pill covering the app in a finished recording.
    if (step.caption !== undefined) {
      if (typeof step.caption !== 'string' || !step.caption.trim()) {
        fail(`${where}: "caption" must be a non-empty string — it is the subtitle shown while the step runs`);
      }
      if (/\r|\n/.test(step.caption)) fail(`${where}: "caption" must be a single line`);
      const text = step.caption.replace(/\s+/g, ' ').trim();
      if (text.length > MAX_CAPTION_CHARS) {
        fail(
          `${where}: "caption" is ${text.length} characters — a subtitle is read while the step plays, not paged through\n  keep it under ${MAX_CAPTION_CHARS}: ${JSON.stringify(text.slice(0, 60))}…`,
        );
      }
    }

    if (step.hold !== undefined && (!isNumber(step.hold) || step.hold < 0)) {
      fail(`${where}: "hold" must be a number of milliseconds >= 0`);
    }

    if (step.shot !== undefined) {
      const spec = typeof step.shot === 'string' ? { id: step.shot } : step.shot;
      if (!spec || typeof spec.id !== 'string' || !spec.id) fail(`${where}: "shot" needs a string id`);
      if (spec.holdMs !== undefined && (!isNumber(spec.holdMs) || spec.holdMs < 0)) {
        fail(`${where}: "shot.holdMs" must be a number of milliseconds >= 0`);
      }
      if (spec.clip !== undefined && typeof spec.clip !== 'string') {
        for (const side of ['x', 'y', 'width', 'height']) {
          if (typeof spec.clip[side] !== 'number') fail(`${where}: a rect clip needs a numeric "${side}"`);
        }
      }
      if (shotIds.has(spec.id)) fail(`${where}: duplicate shot id "${spec.id}" — ids are file names`);
      shotIds.add(spec.id);
    }

    // `expect` is one guard with two forms: page text, or elements that must be
    // on screen. A malformed guard is a plan that silently asserts nothing, so
    // it is refused here rather than at the screen it was meant to protect.
    if (step.expect !== undefined) {
      const guard = step.expect;
      if (guard && typeof guard === 'object' && !Array.isArray(guard)) {
        const unknown = Object.keys(guard).filter((k) => k !== 'selector');
        if (unknown.length) {
          fail(
            `${where}: "expect" has unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}\n  allowed: "selector"`,
          );
        }
        const selectors = [].concat(guard.selector ?? []);
        if (!selectors.length || selectors.some((s) => typeof s !== 'string' || !s)) {
          fail(`${where}: "expect.selector" needs a selector or an array of selectors`);
        }
      } else if (typeof guard === 'string') {
        if (!guard) fail(`${where}: "expect" text must not be empty`);
      } else if (Array.isArray(guard)) {
        if (!guard.length || guard.some((n) => typeof n !== 'string' || !n)) {
          fail(`${where}: "expect" text must be a non-empty string or an array of them`);
        }
      } else {
        fail(`${where}: "expect" must be page text, an array of strings, or { "selector": "…" }`);
      }
    }
  });

  // `${name}` resolves from the plan's vars, then the environment. A name that
  // resolves from neither is a warning here and a hard error at first use: a
  // step guarded by `when` may never need it, and a name a later `setVar` fills
  // in does not need to exist yet.
  const named = new Set(Object.keys(plan.vars ?? {}));
  for (const step of plan.steps) {
    if (step.setVar?.name) named.add(step.setVar.name);
  }
  const missing = new Set();
  for (const match of JSON.stringify(plan).matchAll(/\$\{(\w+)\}/g)) {
    if (!named.has(match[1]) && process.env[match[1]] === undefined) missing.add(match[1]);
  }
  if (missing.size) {
    warnings.push(
      `unresolved \${...}: ${[...missing].join(', ')} — set vars.<name> in the plan (env or literal) or export the name`,
    );
  }

  return { warnings };
}

/**
 * Build the variable map and the expander the runner uses.
 * Order: plan vars → the live map (which `setVar` writes to) → the environment.
 */
export function createVars(plan) {
  const vars = {};
  for (const [name, spec] of Object.entries(plan.vars ?? {})) {
    if (spec.literal !== undefined) {
      vars[name] = String(spec.literal);
      continue;
    }
    const value = process.env[spec.env ?? name];
    if (!value) fail(`plan var "${name}" needs env ${spec.env ?? name} to be set`);
    vars[name] = value;
  }

  const expand = (value) =>
    typeof value === 'string'
      ? value.replace(/\$\{(\w+)\}/g, (_, name) => {
          if (name in vars) return vars[name];
          if (process.env[name] !== undefined) return process.env[name];
          fail(`unknown plan var \${${name}} — declare it in "vars" or export it`);
        })
      : Array.isArray(value)
        ? value.map(expand)
        : value;

  return { vars, expand };
}

/** Read, parse and validate a plan file. */
export async function loadPlan(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
  }
  return { plan, ...validate(plan) };
}

export { PLAN_KEYS, STEP_KEYS, HUMANIZE_KEYS };
