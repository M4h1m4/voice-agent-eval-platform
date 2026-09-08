/**
 * OpenAI adapter. Plain fetch against Chat Completions — no SDK dependency, so there is
 * no version drift between what is committed and what a reviewer installs, and the wire
 * format stays visible in this file rather than behind a client library.
 *
 * Its only real job is normalising tool calls: OpenAI returns them on the message as
 * `tool_calls` with stringified JSON arguments, and everything above this layer expects
 * `LlmToolCall` with parsed args.
 */
import type { LlmClient, LlmRequest, LlmResponse, LlmMessage } from './types.js';
import { LlmError } from './types.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/**
 * Mid-tier by default, deliberately (see the writeup): a top-tier model may pass every
 * scenario, and an all-green report tells us nothing and leaves Parts 5 and 6 with no
 * failures to analyse. Override with OPENAI_MODEL.
 */
export const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

function toWire(m: LlmMessage) {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content || null,
      ...(m.tool_calls?.length
        ? {
            tool_calls: m.tool_calls.map((t) => ({
              id: t.id,
              type: 'function',
              function: { name: t.name, arguments: JSON.stringify(t.args) },
            })),
          }
        : {}),
    };
  }
  return { role: 'user', content: m.content };
}

export class OpenAiClient implements LlmClient {
  constructor(private readonly apiKey = process.env.OPENAI_API_KEY) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) {
      throw new LlmError(
        'OPENAI_API_KEY is not set. Live mode needs it; replay mode does not — ' +
          'run with LLM_MODE=replay to use the committed cache.',
      );
    }

    const body = {
      model: req.model,
      temperature: req.temperature,
      max_tokens: req.max_tokens ?? 1024,
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      messages: [{ role: 'system', content: req.system }, ...req.messages.map(toWire)],
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: 'auto',
          }
        : {}),
    };

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new LlmError(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    return normalizeResponse(await res.json(), req);
  }
}

/**
 * Wire format -> our shape. Exported and pure so the normalisation that matters —
 * tool-call parsing — is testable without a network, a key, or a bill.
 */
export function normalizeResponse(json: any, req: LlmRequest): LlmResponse {
  const choice = json?.choices?.[0];
  if (!choice) throw new LlmError(`OpenAI returned no choices: ${JSON.stringify(json).slice(0, 200)}`);

  const tool_calls = (choice.message?.tool_calls ?? []).map((t: any) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(t.function?.arguments || '{}');
    } catch {
      // A model emitting malformed JSON arguments is a real behaviour worth recording,
      // not a crash. It surfaces downstream as an invalid-arguments tool result, which
      // is what a production agent would also see.
      args = { __malformed__: String(t.function?.arguments ?? '') };
    }
    return { id: String(t.id), name: String(t.function?.name ?? ''), args };
  });

  return {
    text: choice.message?.content ?? '',
    provider: 'openai',
    tool_calls,
    model: String(json.model ?? req.model),
    usage: {
      input_tokens: Number(json.usage?.prompt_tokens ?? 0),
      output_tokens: Number(json.usage?.completion_tokens ?? 0),
    },
    prompt_hash: '',   // stamped by the caching wrapper
    cache_hit: false,
  };
}

/** Exported for tests: message -> OpenAI wire shape. */
export const toWireMessage = toWire;
