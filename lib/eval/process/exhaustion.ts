/**
 * Process Evaluator: Tool Budget Exhaustion & Conversation Termination (Part 3).
 *
 * Checks:
 *   1. Clean termination (did the agent hit max_tool_calls or harness_error?)
 *   2. Ghosting / Caller Abandonment (did the call terminate without the agent speaking to the caller?)
 *   3. Turn and tool efficiency metrics
 */
import type { Scenario } from '../../types/scenario.js';
import type { Trace } from '../../types/trace.js';
import { ids, errors } from '../evidence.js';
import type { MetricResult, ProcessEvaluator } from '../types.js';

export const toolBudgetExhaustionEvaluator: ProcessEvaluator = (
  _scenario: Scenario,
  trace: Trace,
): MetricResult[] => {
  const results: MetricResult[] = [];

  const isExhausted = trace.termination === 'max_tool_calls';
  const isHarnessError = trace.termination === 'harness_error';

  const toolCalls = trace.events.filter((e) => e.type === 'tool_call');
  const callerTurns = trace.events.filter((e) => e.type === 'caller_turn');
  const agentMessages = trace.events.filter((e) => e.type === 'agent_message');

  // Metric 1: Clean termination / Budget Exhaustion
  results.push({
    metric: 'tool_budget_exhaustion',
    category: 'process',
    verdict: isExhausted || isHarnessError ? 'fail' : 'pass',
    score: isExhausted || isHarnessError ? 0 : 1,
    severity: 'critical',
    details: {
      message: isExhausted
        ? `Tool budget exhausted: Execution terminated via "max_tool_calls" (${toolCalls.length} calls across ${callerTurns.length} turns).`
        : isHarnessError
        ? `Execution failed due to harness error.`
        : `Execution terminated cleanly via "${trace.termination}".`,
      evidence: { termination: trace.termination, totalToolCalls: toolCalls.length, turns: callerTurns.length },
      // The harness error that recorded the limit, plus the calls that consumed the
      // budget — the loop itself is what a reviewer needs to see, not the count.
      evidence_events:
        isExhausted || isHarnessError
          ? ids([...errors(trace), ...toolCalls.slice(-6)])
          : undefined,
    },
  });

  // Metric 2: Caller Abandonment (did the agent exhaust calls mid-turn without speaking to the caller?)
  const lastCallerTurn = callerTurns.at(-1);
  const lastAgentMsg = agentMessages.at(-1);

  const abandoned =
    isExhausted &&
    lastCallerTurn !== undefined &&
    (lastAgentMsg === undefined || lastAgentMsg.seq < lastCallerTurn.seq);

  if (abandoned) {
    results.push({
      metric: 'caller_abandonment',
      category: 'process',
      verdict: 'fail',
      score: 0,
      severity: 'critical',
      details: {
        message: `Caller was abandoned: Agent consumed turn budget in tool execution without responding to caller turn "${lastCallerTurn.text}".`,
        evidence: {
          lastCallerTurn: lastCallerTurn.text,
          lastAgentUtterance: lastAgentMsg?.text ?? '(none)',
        },
        // The unanswered turn, and the last thing the agent did say.
        evidence_events: ids([lastCallerTurn, lastAgentMsg]),
      },
    });
  }

  return results;
};
