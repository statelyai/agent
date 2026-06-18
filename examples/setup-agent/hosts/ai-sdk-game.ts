/**
 * Vercel AI SDK step host for a non-trivial game workflow.
 *
 * Run:
 *   OPENAI_API_KEY=... node --import tsx examples/setup-agent/hosts/ai-sdk-game.ts
 */
import { generateText, Output, stepCountIs, type LanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { toAiSdkTools } from '../../../src/ai-sdk/index.js';
import {
  type AgentEffect,
  type AgentTextInput,
} from '../../../src/index.js';
import {
  gameMachine,
  turnSummarySchema,
} from '../game-agent.js';

function resolveModel(modelRef: string): LanguageModel {
  return openai(modelRef.replace(/^openai\//, ''));
}

async function runGenerateEffect(effect: AgentEffect) {
  const input = effect.input as AgentTextInput;
  const model = resolveModel(input.model);
  const prompt = input.prompt ?? '';
  const tools = toAiSdkTools(effect.tools);

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
  let step = gameMachine.initial(input);

  while (!step.done) {
    const [task] = step.tasks;
    if (!task) {
      throw new Error('Machine is waiting without an agent task.');
    }

    const result = await runGenerateEffect(task);

    if (result.kind === 'event') {
      step = gameMachine.transition(step, result.event as never);
    } else {
      step = gameMachine.resolve(step, task, result.output);
    }
  }

  return step.snapshot.output;
}

async function main() {
  const output = await runAiSdkGameTurn();
  console.log(output);
}

if (process.env.OPENAI_API_KEY) {
  void main();
}

export { turnSummarySchema };
