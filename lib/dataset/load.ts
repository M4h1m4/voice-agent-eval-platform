/**
 * Dataset loader: parse YAML, resolve `extends`, validate, cross-check policy ids.
 *
 * Everything here exists to make a malformed scenario fail loudly at load time
 * rather than quietly at evaluation time. The failure this guards against is not a
 * crash — it is a scenario that parses, runs, checks nothing, and reports PASS.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Scenario, ScenarioPatch } from '../types/scenario.js';
import { Policy, PolicyFile } from '../types/policy.js';

export class DatasetError extends Error {}

/**
 * Deep-merge overrides onto a parent scenario.
 *
 * Rule: **objects merge, arrays replace wholesale, and an empty object clears.**
 *
 * The clearing rule exists because merging left no way to remove inherited keys:
 * `hidden_facts: {}` in an override was a silent no-op, so `rx-002-c` kept its parent's
 * `which_walgreens` while having no beat that could disclose it — dead data that looked
 * like evidence design, invisible until the loader started checking for it (D23).
 * Writing `{}` to mean "change nothing" is pointless, so reading it as "clear" is
 * unambiguous.
 *
 * Element-wise array merging
 * would need path expressions like `turn_plan[0].segments`, and a path that matches
 * nothing fails silently — exactly the bug class this loader exists to prevent.
 * Replacing the whole array is verbose but unambiguous.
 *
 * Unrecognised keys are not filtered here on purpose. They survive the merge so that
 * `.strict()` validation downstream rejects them, which is how an override typo
 * becomes an error instead of a no-op.
 */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(patch)) return patch;
  if (patch === null) return null;
  if (
    typeof patch === 'object' &&
    !Array.isArray(patch) &&
    Object.keys(patch as object).length === 0 &&
    typeof base === 'object' &&
    base !== null &&
    !Array.isArray(base)
  ) {
    return {};
  }
  if (typeof patch !== 'object' || typeof base !== 'object' || base === null || Array.isArray(base)) {
    return patch;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

type RawFile = { path: string; raw: Record<string, unknown> };

function readRawScenarios(dir: string): Map<string, RawFile> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const byId = new Map<string, RawFile>();
  for (const f of files) {
    const path = join(dir, f);
    const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const id = raw?.id;
    if (typeof id !== 'string' || !id) throw new DatasetError(`${f}: missing string "id"`);
    if (byId.has(id)) throw new DatasetError(`duplicate scenario id "${id}" in ${f}`);
    if (id !== basename(f).replace(/\.ya?ml$/, '')) {
      throw new DatasetError(`${f}: id "${id}" must match the filename`);
    }
    byId.set(id, { path, raw });
  }
  return byId;
}

/** Resolve inheritance, guarding against cycles and missing parents. */
function resolveRaw(id: string, files: Map<string, RawFile>, seen: string[] = []): Record<string, unknown> {
  if (seen.includes(id)) throw new DatasetError(`extends cycle: ${[...seen, id].join(' -> ')}`);
  const file = files.get(id);
  if (!file) throw new DatasetError(`unknown scenario "${id}" (referenced via extends)`);
  if (!('extends' in file.raw)) return file.raw;

  const patch = ScenarioPatch.safeParse(file.raw);
  if (!patch.success) {
    throw new DatasetError(
      `${file.path}: an inheriting scenario must be exactly {id, extends, role?, overrides} — ` +
        patch.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  const parent = resolveRaw(patch.data.extends, files, [...seen, id]);
  const merged = deepMerge(parent, patch.data.overrides) as Record<string, unknown>;
  merged.id = patch.data.id;
  if (patch.data.role) merged.role = patch.data.role;
  delete merged.extends;
  return merged;
}

export function loadPolicies(dir = 'policies'): Map<string, Policy> {
  const raw = parseYaml(readFileSync(join(dir, 'policies.yaml'), 'utf8'));
  const parsed = PolicyFile.safeParse(raw);
  if (!parsed.success) {
    throw new DatasetError(
      'policies.yaml invalid — ' +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return new Map(parsed.data.policies.map((p) => [p.id, p]));
}

export function loadScenarios(dir = 'scenarios', policyDir = 'policies') {
  const policies = loadPolicies(policyDir);
  const files = readRawScenarios(dir);
  const scenarios: Scenario[] = [];
  const errors: string[] = [];

  for (const [id, file] of files) {
    try {
      const merged = resolveRaw(id, files);
      const parsed = Scenario.safeParse(merged);
      if (!parsed.success) {
        errors.push(
          `${basename(file.path)}: ` +
            parsed.error.issues
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; '),
        );
        continue;
      }
      // A scenario citing a policy that does not exist would otherwise be checked
      // against nothing and pass.
      const unknown = parsed.data.policy_refs.filter((p) => !policies.has(p));
      if (unknown.length) {
        errors.push(`${basename(file.path)}: unknown policy_refs: ${unknown.join(', ')}`);
        continue;
      }
      scenarios.push(parsed.data);
    } catch (e) {
      errors.push(e instanceof DatasetError ? e.message : String(e));
    }
  }

  if (errors.length) throw new DatasetError(`dataset invalid:\n  - ${errors.join('\n  - ')}`);
  scenarios.sort((a, b) => a.id.localeCompare(b.id));
  return { scenarios, policies };
}
