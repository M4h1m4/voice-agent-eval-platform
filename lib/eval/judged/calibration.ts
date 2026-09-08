/**
 * Human-to-automated calibration (Part 3).
 *
 * Scores TWO automated evaluators against the same human labels:
 *
 *   pattern  the original regex classifier, kept only for contrast. It hardcoded the
 *            scenario's proper noun and was written after seeing these traces, so its
 *            agreement number is close to circular — near-perfect and near-meaningless.
 *   llm      a model reading the rubric, told what the caller asked for and why no tool
 *            covers it, and nothing else about the scenario.
 *
 * Reporting both is the point. A single high agreement figure from an evaluator fitted
 * to its own test set is exactly the misleading number the assignment warns about; the
 * gap between the two columns is the honest signal.
 */
import { HUMAN_LABELS, type TraceHumanLabel } from './labels.js';
import { classifyTraceDialogue } from './judge.js';
import { judgeWithLlm } from './llm-judge.js';
import { evaluatorContext } from '../context.js';
import { DEFAULT_MODEL } from '../../llm/openai.js';
import type { LlmClient } from '../../llm/types.js';
import { loadTrace } from '../../store/traces.js';
import { createHash } from 'node:crypto';

/**
 * Content fingerprint of a trace, over the dialogue and tool calls a human would have
 * read when labelling it. Deliberately excludes timing and ids, which change on a
 * regeneration without changing what the label was about.
 */
export function fingerprint(trace: { events: { type: string; [k: string]: unknown }[] }): string {
  const material = trace.events
    .filter((e) => ['caller_turn', 'agent_message', 'tool_call'].includes(e.type))
    .map((e) => `${e.type}:${(e as { text?: string; tool?: string }).text ?? (e as { tool?: string }).tool}`)
    .join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}
import { loadScenarios } from '../../dataset/load.js';

export interface CalibrationItem {
  run_id: string;
  scenario_id: string;
  agent_version: string;
  difficulty: 'obvious' | 'boundary_case';
  human_verdict: 'pass' | 'fail' | 'unexercised';
  human_classification: string;
  judge_verdict: 'pass' | 'fail' | 'unexercised';
  judge_classification: string;
  agreement: boolean;
  /** True when the trace changed after the label was written. */
  stale_label?: boolean;
  /** The superseded regex classifier, for contrast. */
  pattern_verdict?: 'pass' | 'fail' | 'unexercised';
  pattern_classification?: string;
  pattern_agreement?: boolean;
  notes: string;
}

export interface CalibrationReport {
  total: number;
  agreements: number;
  disagreements: number;
  agreementRate: number;
  patternAgreementRate?: number;
  items: CalibrationItem[];
  boundaryAnalysis: string;
}

export async function runCalibration(llm?: LlmClient): Promise<CalibrationReport> {
  const { scenarios } = loadScenarios();
  const items: CalibrationItem[] = [];
  const client = llm ?? (evaluatorContext().llmClient as LlmClient);

  let agreements = 0;
  let patternAgreements = 0;

  for (const [runId, humanLabel] of Object.entries(HUMAN_LABELS)) {
    const trace = loadTrace(runId);
    const scenario = scenarios.find((s) => s.id === humanLabel.scenario_id);
    if (!scenario) continue;

    // A label written against a different version of this trace cannot testify about
    // the judge. Counted separately rather than as a disagreement.
    const fp = fingerprint(trace);
    const stale = humanLabel.trace_fingerprint !== undefined && humanLabel.trace_fingerprint !== fp;

    const patternResult = classifyTraceDialogue(scenario, trace);
    if (patternResult.verdict === humanLabel.human_verdict) patternAgreements++;

    const judgeResult = await judgeWithLlm(scenario, trace, client, DEFAULT_MODEL);
    const isAgree = humanLabel.human_verdict === judgeResult.verdict;
    if (isAgree) agreements++;

    items.push({
      run_id: runId,
      scenario_id: humanLabel.scenario_id,
      agent_version: humanLabel.agent_version,
      difficulty: humanLabel.difficulty,
      human_verdict: humanLabel.human_verdict,
      human_classification: humanLabel.human_classification,
      judge_verdict: judgeResult.verdict,
      judge_classification: judgeResult.classification,
      agreement: isAgree,
      pattern_verdict: patternResult.verdict,
      pattern_classification: patternResult.classification,
      pattern_agreement: patternResult.verdict === humanLabel.human_verdict,
      stale_label: stale,
      notes: judgeResult.reasoning,
    });
  }

  const total = items.length;
  const agreementRate = total > 0 ? agreements / total : 1;
  const patternAgreementRate = total > 0 ? patternAgreements / total : 1;

  const disagreed = items.filter((i) => !i.agreement);
  const boundary = items.filter((i) => i.difficulty === 'boundary_case');
  const boundaryAgreed = boundary.filter((i) => i.agreement).length;

  // Agreement on traces where the metric ACTUALLY APPLIED.
  //
  // Several labelled traces come from scenarios that declare no unsupported requests,
  // so both the human and the judge say "unexercised" and agree trivially. Counting
  // those inflates the headline figure with cases that tested nothing — the label set
  // is padded, and the overall rate is the misleading number the assignment warns about.
  const stale = items.filter((i) => i.stale_label);
  const exercised = items.filter((i) => i.human_verdict !== 'unexercised' && !i.stale_label);
  const exercisedAgreed = exercised.filter((i) => i.agreement).length;

  const boundaryAnalysis = [
    `${total} human-labelled traces (${boundary.length} boundary cases).`,
    '',
    `LLM judge      ${(agreementRate * 100).toFixed(1)}% agreement  (${agreements}/${total})`,
    `pattern (old)  ${(patternAgreementRate * 100).toFixed(1)}% agreement  (${patternAgreements}/${total})`,
    '',
    `Of those ${total} labels, only ${exercised.length} are traces where the metric applied at all.`,
    `The other ${total - exercised.length} come from scenarios with no unsupported request, where both`,
    'sides say "unexercised" and agree for free. The honest figure is the exercised one:',
    '',
    `  ON EXERCISED TRACES:  ${exercised.length ? ((exercisedAgreed / exercised.length) * 100).toFixed(1) : 'n/a'}% (${exercisedAgreed}/${exercised.length})`,
    '',
    `On boundary cases the judge agreed on ${boundaryAgreed}/${boundary.length}.`,
    ...(stale.length
      ? ['', `${stale.length} label(s) are STALE — the trace changed after they were written:`,
         ...stale.map((i) => `  ${i.run_id}`),
         'They are excluded from the exercised figure. A stale label is not evidence about the judge.']
      : []),
    '',
    'The pattern classifier hardcoded this scenario\'s proper noun and was written after',
    'reading these traces, so a high figure from it measures fit, not accuracy. Treat the',
    'gap between the two rows as the signal, not either number on its own.',
    '',
    disagreed.length
      ? 'DISAGREEMENTS (each needs a human to decide who is right):\n' +
        disagreed
          .map(
            (i) =>
              `  ${i.run_id}\n    human: ${i.human_classification} (${i.human_verdict})` +
              `\n    judge: ${i.judge_classification} (${i.judge_verdict})\n    judge said: ${i.notes.slice(0, 160)}`,
          )
          .join('\n')
      : `No disagreements across ${exercised.length} applicable traces. That is weak evidence of accuracy, ` +
        'not strong evidence, and it says nothing about scenarios the judge has never seen.',
  ].join('\n');

  return {
    total,
    agreements,
    disagreements: total - agreements,
    agreementRate,
    patternAgreementRate,
    items,
    boundaryAnalysis,
  };
}
