/**
 * Vercel AI SDK step host for a non-trivial game workflow.
 *
 * State machine: ../game-agent/index.ts
 *
 * Run:
 *   OPENAI_API_KEY=... node --import tsx examples/ai-sdk-game-host/index.ts
 */
import { generateText, Output, stepCountIs, type LanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { toAiSdkTools } from '../../src/ai-sdk/index.js';
import {
  initialAgentStep,
  type AgentRequest,
  type AgentTextRequest,
  type EventUnion,
  resolveAgentStep,
  transitionAgentStep,
} from '../../src/index.js';
import { gameActors, gameMachine, gameSchemas, turnSummarySchema } from '../game-agent/index.js';

type GameEvent = EventUnion<typeof gameSchemas.events>;

function resolveModel(modelRef: string): LanguageModel {
  return openai(modelRef.replace(/^openai\//, ''));
}

async function runGenerateRequest(request: AgentRequest) {
  const input = request.input as AgentTextRequest;
  const model = resolveModel(input.model);
  const prompt = input.prompt ?? '';
  const tools = toAiSdkTools(request.tools);

  if (Object.keys(tools).length > 0) {
    const result = await generateText({
      model,
      system: input.system,
      prompt,
      tools,
      toolChoice: 'required',
      stopWhen: stepCountIs(1),
      temperature: input.temperature,
    });

    const event = result.toolResults[0]?.output;
    if (event && typeof event === 'object' && 'type' in event) {
      return { kind: 'event' as const, event };
    }

    return { kind: 'output' as const, output: result.text };
  }

  if (input.outputSchema) {
    const { output } = await generateText({
      model,
      system: input.system,
      prompt,
      output: Output.object({
        schema: input.outputSchema as z.ZodType,
      }),
      temperature: input.temperature,
    });
    return { kind: 'output' as const, output };
  }

  const { text } = await generateText({
    model,
    system: input.system,
    prompt,
    temperature: input.temperature,
  });
  return { kind: 'output' as const, output: text };
}

function parseGameEvent(value: unknown): GameEvent {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new Error('Model returned an invalid game event.');
  }

  const type = String(value.type);
  const schema = gameSchemas.events[type as keyof typeof gameSchemas.events];
  if (!schema) {
    throw new Error(`Model returned unsupported game event: ${type}`);
  }

  return {
    type,
    ...schema.parse(value),
  } as GameEvent;
}

export async function runAiSdkGameTurn(input = { playerHp: 20, enemyHp: 15 }) {
  let step = initialAgentStep(gameMachine, input, {
    schemas: gameSchemas,
    actors: gameActors,
  });

  while (!step.done) {
    const [request] = step.requests;
    if (!request) {
      throw new Error('Machine is waiting without an agent request.');
    }

    const result = await runGenerateRequest(request);

    if (result.kind === 'event') {
      step = transitionAgentStep(gameMachine, step, parseGameEvent(result.event), {
        schemas: gameSchemas,
        actors: gameActors,
      });
    } else {
      step = resolveAgentStep(
        gameMachine,
        step,
        request,
        result.output,
        {
          schemas: gameSchemas,
          actors: gameActors,
        }
      );
    }
  }

  return step.snapshot.output;
}

async function main() {
  const output = await runAiSdkGameTurn();
  console.log(output);
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  void main();
}

export { turnSummarySchema };
