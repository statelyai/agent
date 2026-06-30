/**
 * Cloudflare Workers AI step host for the game workflow.
 *
 * Run with Wrangler in a Worker that has an `AI` binding. Workers AI does not
 * expose the same tool-calling shape as the Vercel AI SDK binding path, so this
 * host serializes allowed event tools into the prompt and accepts JSON output.
 */
import {
  initialAgentStep,
  resolveAgentStep,
  transitionAgentStep,
  type AgentRequest,
} from '../../src/index.js';
import { gameMachine } from '../game-agent/index.js';

interface Env {
  AI: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
}

function promptWithAllowedEvents(request: AgentRequest): string {
  const legalEvents = request.events
    .map((event) => `- ${event.type}`)
    .join('\n');

  if (!legalEvents) {
    return request.input.prompt ?? '';
  }

  return [
    request.input.prompt ?? '',
    '',
    'Choose exactly one legal event and respond as JSON.',
    'Legal events:',
    legalEvents,
    'Example: {"type":"ATTACK","target":"goblin"}',
  ].join('\n');
}

async function runWorkersAiRequest(env: Env, request: AgentRequest) {
  const response = (await env.AI.run(request.input.model, {
    system: request.input.system,
    prompt: promptWithAllowedEvents(request),
    temperature: request.input.temperature,
    max_tokens: request.input.maxTokens,
  })) as { response?: string } | string | Record<string, unknown>;

  const text =
    typeof response === 'string'
      ? response
      : typeof response.response === 'string'
        ? response.response
        : JSON.stringify(response);

  if (request.events.length > 0) {
    return { kind: 'event' as const, event: JSON.parse(text) };
  }

  if (request.input.outputSchema) {
    return { kind: 'output' as const, output: JSON.parse(text) };
  }

  return { kind: 'output' as const, output: text };
}

export async function runCloudflareGameTurn(
  env: Env,
  input = { playerHp: 20, enemyHp: 15 },
) {
  let step = initialAgentStep(gameMachine, input);

  while (!step.done) {
    const [request] = step.requests;
    if (!request) {
      throw new Error('Machine is waiting without an agent request.');
    }

    const result = await runWorkersAiRequest(env, request);

    if (result.kind === 'event') {
      step = transitionAgentStep(gameMachine, step, result.event as never);
    } else {
      step = resolveAgentStep(gameMachine, step, request, result.output);
    }
  }

  return step.snapshot.output;
}

export default {
  async fetch(_request: Request, env: Env) {
    const output = await runCloudflareGameTurn(env);
    return Response.json(output);
  },
};
