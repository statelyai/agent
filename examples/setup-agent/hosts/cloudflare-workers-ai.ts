/**
 * Cloudflare Workers AI step host for the game workflow.
 *
 * Run with Wrangler in a Worker that has an `AI` binding. Workers AI does not
 * expose the same tool-calling shape as the Vercel AI SDK binding path, so this
 * host serializes allowed event tools into the prompt and accepts JSON output.
 */
import {
  type AgentEffect,
} from '../../../src/index.js';
import {
  gameMachine,
} from '../game-agent.js';

interface Env {
  AI: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
}

function promptWithAllowedEvents(effect: AgentEffect): string {
  const legalEvents = effect.events
    .map((event) => `- ${event.type}`)
    .join('\n');

  if (!legalEvents) {
    return effect.input.prompt ?? '';
  }

  return [
    effect.input.prompt ?? '',
    '',
    'Choose exactly one legal event and respond as JSON.',
    'Legal events:',
    legalEvents,
    'Example: {"type":"ATTACK","target":"goblin"}',
  ].join('\n');
}

async function runWorkersAiEffect(env: Env, effect: AgentEffect) {
  const response = await env.AI.run(effect.input.model, {
    system: effect.input.system,
    prompt: promptWithAllowedEvents(effect),
    temperature: effect.input.temperature,
    max_tokens: effect.input.maxTokens,
  }) as { response?: string } | string | Record<string, unknown>;

  const text =
    typeof response === 'string'
      ? response
      : typeof response.response === 'string'
        ? response.response
        : JSON.stringify(response);

  if (effect.events.length > 0) {
    return { kind: 'event' as const, event: JSON.parse(text) };
  }

  if (effect.input.outputSchema) {
    return { kind: 'output' as const, output: JSON.parse(text) };
  }

  return { kind: 'output' as const, output: text };
}

export async function runCloudflareGameTurn(
  env: Env,
  input = { playerHp: 20, enemyHp: 15 }
) {
  let step = gameMachine.initial(input);

  while (!step.done) {
    const [task] = step.tasks;
    if (!task) {
      throw new Error('Machine is waiting without an agent task.');
    }

    const result = await runWorkersAiEffect(env, task);

    if (result.kind === 'event') {
      step = gameMachine.transition(step, result.event as never);
    } else {
      step = gameMachine.resolve(step, task, result.output);
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
