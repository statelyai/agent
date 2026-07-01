/**
 * TanStack AI step host for the game workflow.
 *
 * Install peer SDKs in an app:
 *   pnpm add @tanstack/ai @tanstack/ai-openai
 *
 * Then run with an OpenAI-compatible TanStack adapter.
 */
import { initialTransition, transition, type AnyStateMachine } from 'xstate';
import { type AgentRequest } from '../../src/index.js';
import { getAgentRequests, transitionResult } from '../../src/index.js';
import { gameActors, gameMachine, gameSchemas } from '../game-agent/index.js';

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

export async function runTanStackGameTurn(args: {
  chat: TanStackChat;
  adapter: unknown;
  input?: { playerHp: number; enemyHp: number };
}) {
  let [snapshot, actions]: [any, any[]] = initialTransition(
    gameMachine,
    args.input ?? { playerHp: 20, enemyHp: 15 }
  );

  while (snapshot.status !== 'done') {
    const [request] = getAgentRequests(actions, {
      snapshot,
      schemas: gameSchemas,
      actors: gameActors,
    });
    if (!request) {
      throw new Error('Machine is waiting without an agent request.');
    }

    const result = await runTanStackRequest({
      chat: args.chat,
      adapter: args.adapter,
      request,
    });

    if (result.kind === 'event') {
      [snapshot, actions] = transition(gameMachine, snapshot, result.event as never);
    } else {
      [snapshot, actions] = transitionResult(
        gameMachine as unknown as AnyStateMachine,
        snapshot,
        request,
        result.output
      );
    }
  }

  return snapshot.output;
}
