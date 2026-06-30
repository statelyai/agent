/**
 * Vercel AI SDK step host for a non-trivial game workflow.
 *
 * Run:
 *   OPENAI_API_KEY=... node --import tsx examples/setup-agent/hosts/ai-sdk-game.ts
 */
import { generateText, Output, stepCountIs, type LanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { initialTransition, transition } from 'xstate';
import { toAiSdkTools } from '../../../src/ai-sdk/index.js';
import {
  getAgentRequests,
  type AgentRequest,
  type AgentTextRequest,
  transitionResult,
} from '../../../src/index.js';
import { gameActors, gameMachine, gameSchemas, turnSummarySchema } from '../game-agent.js';

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

export async function runAiSdkGameTurn(input = { playerHp: 20, enemyHp: 15 }) {
  let [snapshot, actions]: [any, any[]] = initialTransition(gameMachine, input);

  while (snapshot.status !== 'done') {
    const [request] = getAgentRequests(actions, {
      snapshot,
      schemas: gameSchemas,
      actors: gameActors,
    });
    if (!request) {
      throw new Error('Machine is waiting without an agent request.');
    }

    const result = await runGenerateRequest(request);

    if (result.kind === 'event') {
      [snapshot, actions] = transition(gameMachine, snapshot, result.event as never);
    } else {
      [snapshot, actions] = transitionResult(
        gameMachine as any,
        snapshot,
        request,
        result.output
      );
    }
  }

  return snapshot.output;
}

async function main() {
  const output = await runAiSdkGameTurn();
  console.log(output);
}

if (process.env.OPENAI_API_KEY) {
  void main();
}

export { turnSummarySchema };
