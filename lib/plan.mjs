/**
 * Plan loading, validation, and `${var}` expansion.
 *
 * A plan is data, so a mistyped key is invisible: `{"clickk": "#go"}` is a step
 * that does nothing and a plan that reports success. Everything here exists to
 * turn that class of mistake into a message naming the key, before a browser
 * opens.
 */
import { readFile } from 'node:fs/promises';

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
  'vars',
  'steps',
]);

/** Keys a step may carry. Each is one action; order within a step is fixed by the runner. */
const STEP_KEYS = new Set([
  'name',
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
  'shot',
]);

export class PlanError extends Error {}

const fail = (msg) => {
  throw new PlanError(msg);
};

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

  const shotIds = new Set();
  plan.steps.forEach((step, i) => {
    const where = `step #${i + 1}${step?.name ? ` (${step.name})` : ''}`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) fail(`${where} must be an object`);
    const keys = Object.keys(step);
    const unknown = keys.filter((k) => !STEP_KEYS.has(k));
    if (unknown.length) {
      fail(`${where}: unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}\n  allowed: ${[...STEP_KEYS].join(', ')}`);
    }
    if (!keys.some((k) => k !== 'name')) fail(`${where} does nothing — it has no action key`);

    if (step.shot !== undefined) {
      const spec = typeof step.shot === 'string' ? { id: step.shot } : step.shot;
      if (!spec || typeof spec.id !== 'string' || !spec.id) fail(`${where}: "shot" needs a string id`);
      if (spec.clip !== undefined && typeof spec.clip !== 'string') {
        for (const side of ['x', 'y', 'width', 'height']) {
          if (typeof spec.clip[side] !== 'number') fail(`${where}: a rect clip needs a numeric "${side}"`);
        }
      }
      if (shotIds.has(spec.id)) fail(`${where}: duplicate shot id "${spec.id}" — ids are file names`);
      shotIds.add(spec.id);
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

export { PLAN_KEYS, STEP_KEYS };
