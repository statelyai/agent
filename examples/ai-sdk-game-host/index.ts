/**
 * Vercel AI SDK step host for a non-trivial game workflow.
 *
 * State machine: ../game-agent/index.ts
 *
 * Run:
 *   OPENAI_API_KEY=... node --import tsx examples/ai-sdk-game-host/index.ts
 */
import { type LanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createAiSdkExecutors } from '../../src/ai-sdk/index.js';
import {
  executeAgentRequest,
  initialAgentStep,
  resolveDecision,
  type EventUnion,
  resolveAgentStep,
  transitionAgentStep,
} from '../../src/index.js';
import { gameActors, gameMachine, gameSchemas, turnSummarySchema } from '../game-agent/index.js';

type GameEvent = EventUnion<typeof gameSchemas.events>;

function resolveModel(modelRef: string): LanguageModel {
  return openai(modelRef.replace(/^openai\//, ''));
}

// Adapter-provided executors: `decide` forces a tool call, one tool per
// candidate event, and reads the chosen event off the tool call — the
// "tool-per-event + toolChoice: 'required'" recipe from docs/p0-design.md
// §2.6 — how the model is coerced into choosing is adapter business, not
// core's.
const executors = createAiSdkExecutors({ resolveModel });
const { decide } = executors;

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

    if (request.kind === 'decision') {
      const chosenEvent = await resolveDecision(request, decide);
      step = transitionAgentStep(gameMachine, step, parseGameEvent(chosenEvent), {
        schemas: gameSchemas,
        actors: gameActors,
      });
      continue;
    }

    const output = await executeAgentRequest(request, executors);
    step = resolveAgentStep(
      gameMachine,
      step,
      request,
      output,
      {
        schemas: gameSchemas,
        actors: gameActors,
      }
    );
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
