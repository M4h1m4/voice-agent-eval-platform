/**
 * The agent under test: a real model with tool calling.
 *
 * This one has to be a real LLM. A hand-rolled agent only ever reproduces failures
 * somebody designed, and an evaluation of it proves nothing — the platform would be
 * detecting bugs I planted. Everything else in the harness can be faked; this cannot.
 */
import type { Agent, AgentAction, AgentContext } from '../harness/types.js';
import type { LlmClient, LlmMessage, LlmToolCall } from '../llm/types.js';
import type { ToolCall } from '../types/tools.js';
import { DEFAULT_MODEL } from '../llm/openai.js';
import { toolDefinitions, toWireName, fromWireName } from './tool-defs.js';
import { AGENT_VERSIONS, type AgentVersionKey } from './prompts.js';

const TOOLS = toolDefinitions();

export class LlmAgent implements Agent {
  constructor(
    readonly version: string,
    private readonly systemPrompt: string,
    private readonly llm: LlmClient,
    private readonly model = DEFAULT_MODEL,
    private readonly seed?: number,
  ) {}

  async next(ctx: AgentContext): Promise<AgentAction> {
    const res = await this.llm.complete({
      actor: 'agent',
      model: this.model,
      temperature: 0,
      ...(this.seed !== undefined ? { seed: this.seed } : {}),
      system: this.systemPrompt,
      messages: toMessages(ctx),
      tools: TOOLS,
      max_tokens: 400,
    });

    // One tool per step. Extras are dropped rather than queued: a queued call would be
    // executed without the model having seen the previous result, and the message
    // history rebuilt next turn would not contain it. Dropping is lossless in practice
    // — the model reissues the call once it has the result it was waiting on.
    const first = res.tool_calls[0];
    if (first) return { kind: 'tool', call: toToolCall(first) };

    const text = res.text.trim();
    if (text) return { kind: 'speak', text };

    // No words and no tool call. Nothing useful is coming; end rather than loop.
    return { kind: 'end' };
  }
}

/**
 * Wire name back to ours. Arguments are passed through unchecked on purpose: the World
 * validates them and returns a usable error, so a model that mis-shapes a call produces
 * evidence in the trace instead of an exception here.
 */
function toToolCall(t: LlmToolCall): ToolCall {
  return { name: fromWireName(t.name) as ToolCall['name'], args: t.args };
}

/**
 * Conversation state -> provider messages.
 *
 * The orchestrator always pushes a tool_result directly after its tool_call, so calls
 * and results are paired by adjacency and given synthetic ids. The provider requires
 * every tool_call id to be answered; an unanswered one is a hard API error, which is
 * why extras are dropped at source rather than here.
 */
export function toMessages(ctx: AgentContext): LlmMessage[] {
  const out: LlmMessage[] = [];
  ctx.history.forEach((h, i) => {
    switch (h.role) {
      case 'caller':
        out.push({ role: 'user', content: h.text });
        break;
      case 'agent':
        out.push({ role: 'assistant', content: h.text });
        break;
      case 'tool_call':
        out.push({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `call_${i}`, name: toWireName(h.name), args: h.args }],
        });
        break;
      case 'tool_result':
        out.push({
          role: 'tool',
          tool_call_id: `call_${i - 1}`,
          content: JSON.stringify(h.result),
        });
        break;
    }
  });
  return out;
}

export function llmAgent(key: AgentVersionKey, llm: LlmClient, model = DEFAULT_MODEL, seed?: number): LlmAgent {
  const { version, prompt } = AGENT_VERSIONS[key];
  return new LlmAgent(version, prompt, llm, model, seed);
}
