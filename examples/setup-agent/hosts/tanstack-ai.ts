/**
 * TanStack AI pure-transition host for the game workflow.
 *
 * Install peer SDKs in an app:
 *   pnpm add @tanstack/ai @tanstack/ai-openai
 *
 * Then run with an OpenAI-compatible TanStack adapter.
 */
import { initialTransition, transition } from 'xstate';
import {
  getAgentEffects,
  transitionResult,
  type AgentEffect,
} from '../../../src/index.js';
import {
  chooseMove,
  gameMachine,
  gameSchemas,
  summarizeTurn,
} from '../game-agent.js';

type TanStackChat = (options: {
  adapter: unknown;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools?: unknown[];
  outputSchema?: unknown;
  stream?: false;
}) => Promise<unknown>;

function toTanStackTools(effect: AgentEffect) {
  return effect.events.map((event) => ({
    name: event.toolName,
    description: `Transition with event '${event.type}'.`,
    inputSchema: event.inputSchema,
    execute: async (input: unknown = {}) => ({
      ...(input && typeof input === 'object' ? input : {}),
      type: event.type,
    }),
  }));
}

async function runTanStackEffect(args: {
  chat: TanStackChat;
  adapter: unknown;
  effect: AgentEffect;
}) {
  const result = await args.chat({
    adapter: args.adapter,
    stream: false,
    messages: [
      ...(args.effect.input.system
        ? [{ role: 'system' as const, content: args.effect.input.system }]
        : []),
      { role: 'user', content: args.effect.input.prompt ?? '' },
    ],
    tools: toTanStackTools(args.effect),
    outputSchema: args.effect.input.outputSchema,
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
  let [snapshot, actions] = initialTransition(
    gameMachine,
    args.input ?? { playerHp: 20, enemyHp: 15 }
  );

  while (snapshot.status !== 'done') {
    const [effect] = getAgentEffects(actions, {
      snapshot,
      schemas: gameSchemas,
      actors: { chooseMove, summarizeTurn },
    });

    if (!effect) {
      throw new Error('Machine is waiting without an agent effect.');
    }

    const result = await runTanStackEffect({
      chat: args.chat,
      adapter: args.adapter,
      effect,
    });

    if (result.kind === 'event') {
      [snapshot, actions] = transition(
        gameMachine,
        snapshot,
        result.event as never
      );
    } else {
      [snapshot, actions] = transitionResult(
        gameMachine,
        snapshot,
        effect,
        result.output
      );
    }
  }

  return snapshot.output;
}
