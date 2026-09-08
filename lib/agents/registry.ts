/**
 * One way to name an agent.
 *
 * Stub and LLM agents are constructed differently — a stub needs the scenario id to
 * pick its plan, an LLM agent needs a client — so without a registry every caller
 * (runner, acceptance script, application) would grow its own branching over agent
 * kinds, and they would disagree about what "v2" means.
 *
 * Specs are strings so they can come from a CLI flag, a config file, or a row in the
 * UI without translation: `stub:oracle`, `llm:v1`.
 */
import type { Agent } from '../harness/types.js';
import type { LlmClient } from '../llm/types.js';
import { stubAgent, type StubKind } from './scripted.js';
import { llmAgent } from './llm.js';
import { AGENT_VERSIONS, type AgentVersionKey } from './prompts.js';
import { DEFAULT_MODEL } from '../llm/openai.js';

export class AgentSpecError extends Error {}

export const STUB_KINDS: StubKind[] = ['oracle', 'naive', 'panicky'];
export const LLM_VERSIONS = Object.keys(AGENT_VERSIONS) as AgentVersionKey[];

export const ALL_SPECS = [
  ...STUB_KINDS.map((k) => `stub:${k}`),
  ...LLM_VERSIONS.map((v) => `llm:${v}`),
] as const;

export const needsLlm = (spec: string) => spec.startsWith('llm:');

export function resolveAgent(
  spec: string,
  scenarioId: string,
  llm?: LlmClient,
  model = DEFAULT_MODEL,
  seed?: number,
): Agent {
  const [kind, name] = spec.split(':');

  if (kind === 'stub') {
    if (!STUB_KINDS.includes(name as StubKind)) {
      throw new AgentSpecError(`unknown stub "${name}" — expected one of ${STUB_KINDS.join(', ')}`);
    }
    return stubAgent(scenarioId, name as StubKind);
  }

  if (kind === 'llm') {
    if (!LLM_VERSIONS.includes(name as AgentVersionKey)) {
      throw new AgentSpecError(`unknown agent version "${name}" — expected one of ${LLM_VERSIONS.join(', ')}`);
    }
    // Failing here beats failing at the first completion: the caller has misconfigured
    // the run, not hit a missing cache entry, and the messages should not look alike.
    if (!llm) throw new AgentSpecError(`agent "${spec}" needs an LLM client; none was provided`);
    return llmAgent(name as AgentVersionKey, llm, model, seed);
  }

  throw new AgentSpecError(`unrecognised agent spec "${spec}" — expected ${ALL_SPECS.join(' | ')}`);
}
