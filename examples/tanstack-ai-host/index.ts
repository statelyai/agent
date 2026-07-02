/**
 * TanStack AI step host for the game workflow.
 *
 * Install peer SDKs in an app:
 *   pnpm add @tanstack/ai @tanstack/ai-openai
 *
 * Then run with an OpenAI-compatible TanStack adapter.
 */
import {
  initialAgentStep,
  resolveAgentStep,
  transitionAgentStep,
  type AgentRequest,
  type EventUnion,
} from '../../src/index.js';
import { gameActors, gameMachine, gameSchemas } from '../game-agent/index.js';

type GameEvent = EventUnion<typeof gameSchemas.events>;

type TanStackChat = (options: {
  adapter: unknown;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools?: unknown[];
  outputSchema?: unknown;
  stream?: false;
}) => Promise<unknown>;

function toTanStackTools(request: AgentRequest) {
  return request.events.map((event) => ({
    name: event.toolName,
    description: `Transition with event '${event.type}'.`,
    inputSchema: event.inputSchema,
    execute: async (input: unknown = {}) => ({
      ...(input && typeof input === 'object' ? input : {}),
      type: event.type,
    }),
  }));
}

async function runTanStackRequest(args: {
  chat: TanStackChat;
  adapter: unknown;
  request: AgentRequest;
}) {
  const result = await args.chat({
    adapter: args.adapter,
    stream: false,
    messages: [
      ...(args.request.input.system
        ? [{ role: 'system' as const, content: args.request.input.system }]
        : []),
      { role: 'user', content: args.request.input.prompt ?? '' },
    ],
    tools: toTanStackTools(args.request),
    outputSchema: args.request.input.outputSchema,
  });

  if (result && typeof result === 'object' && 'type' in result) {
    return { kind: 'event' as const, event: result };
  }

  return { kind: 'output' as const, output: result };
}

function parseGameEvent(value: unknown): GameEvent {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new Error('Host returned an invalid game event.');
  }

  const type = String(value.type);
  const schema = gameSchemas.events[type as keyof typeof gameSchemas.events];
  if (!schema) {
    throw new Error(`Host returned unsupported game event: ${type}`);
  }

  return {
    type,
    ...schema.parse(value),
  } as GameEvent;
}

export async function runTanStackGameTurn(args: {
  chat: TanStackChat;
  adapter: unknown;
  input?: { playerHp: number; enemyHp: number };
}) {
  let step = initialAgentStep(
    gameMachine,
    args.input ?? { playerHp: 20, enemyHp: 15 },
    {
      schemas: gameSchemas,
      actors: gameActors,
    },
  );

  while (!step.done) {
    const [request] = step.requests;
    if (!request) {
      throw new Error('Machine is waiting without an agent request.');
    }

    const result = await runTanStackRequest({
      chat: args.chat,
      adapter: args.adapter,
      request,
    });

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
