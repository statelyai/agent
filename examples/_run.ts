import 'dotenv/config';

import { generateText, Output } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
  AgentAdapter,
  DecideAdapter,
  ExecuteResult,
  StandardSchemaV1,
} from '../src/index.js';
export { waitForRunDone, waitForRunSnapshot } from '../src/runtime/index.js';

export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return !!entry && moduleUrl === pathToFileURL(entry).href;
}

let bufferedLinesPromise: Promise<string[]> | null = null;
let bufferedLineIndex = 0;

async function getBufferedLines(): Promise<string[]> {
  if (!bufferedLinesPromise) {
    bufferedLinesPromise = (async () => {
      const chunks: string[] = [];

      for await (const chunk of input) {
        chunks.push(String(chunk));
      }

      return chunks.join('').split(/\r?\n/);
    })();
  }

  return bufferedLinesPromise;
}

export async function prompt(label: string): Promise<string> {
  if (!input.isTTY) {
    output.write(`${label}: `);
    const lines = await getBufferedLines();
    const value = lines[bufferedLineIndex] ?? '';
    bufferedLineIndex += 1;
    return value.trim();
  }

  const rl = createInterface({ input, output });
  try {
    const value = await rl.question(`${label}: `);
    return value.trim();
  } finally {
    rl.close();
  }
}

export function closePrompt(): void {
  bufferedLinesPromise = null;
  bufferedLineIndex = 0;
}

export function createExampleModel(
  model = 'openai/gpt-5.4-nano'
): Parameters<typeof generateText>[0]['model'] {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required to run the examples.');
  }

  return openai(resolveOpenAiModel(model));
}

export function formatResult(result: ExecuteResult<any, any, any>) {
  if (result.status === 'done') {
    return {
      status: result.status,
      value: result.state.value,
      context: result.context,
      messages: result.messages,
      output: result.output,
    };
  }

  if (result.status === 'pending') {
    return {
      status: result.status,
      value: result.value,
      context: result.context,
      messages: result.messages,
      events: Object.keys(result.events),
    };
  }

  return {
    status: result.status,
    value: result.state.value,
    error: result.error,
  };
}

export function createOpenAiDecisionAdapter(): DecideAdapter {
  return {
    async decide({ model, prompt, options, reasoning }) {
      const optionKeys = Object.keys(options);

      const allSchemaLess = Object.values(options).every((option) => !option.schema);

      if (allSchemaLess && !reasoning) {
        const choiceResult = await generateText({
          model: createExampleModel(model),
          system: [
            'Choose exactly one option.',
            ...Object.entries(options).map(([key, option]) => `${key}: ${option.description}`),
          ].join('\n'),
          prompt,
          output: Output.choice({
            options: optionKeys,
          }),
        });

        return {
          choice: choiceResult.output,
          data: {} as Record<string, unknown>,
        };
      }

      const decisionSchemas = optionKeys.map((key) => {
        const option = options[key]!;

        return z.object({
          decision: z.literal(key),
          data: option.schema ? toZodSchema(option.schema) : z.object({}),
          ...(reasoning
            ? { reasoning: z.string() }
            : {}),
        });
      });

      const decisionSchema =
        decisionSchemas.length === 1
          ? decisionSchemas[0]!
          : z.union(
              decisionSchemas as unknown as [
                z.ZodTypeAny,
                z.ZodTypeAny,
                ...z.ZodTypeAny[],
              ]
            );

      const result = await generateText({
        model: createExampleModel(model),
        system: [
          'Choose exactly one option and return structured output.',
          ...Object.entries(options).map(([key, option]) => `${key}: ${option.description}`),
        ].join('\n'),
        prompt,
        output: Output.object({
          schema: decisionSchema,
        }),
      });
      const output = result.output as {
        decision: string;
        data: Record<string, unknown>;
        reasoning?: string;
      };

      return {
        choice: output.decision,
        data: output.data,
        reasoning: output.reasoning,
      };
    },
  };
}

export function createOpenAiGenerationAdapter(): AgentAdapter {
  return {
    async generateText({ model, system, prompt, messages, outputSchema }) {
      const result = await generateText({
        model: createExampleModel(model),
        system,
        prompt,
        messages: messages as any,
        ...(outputSchema
          ? {
            output: Output.object({
              schema: toZodSchema(outputSchema),
            }),
          }
          : {}),
      });

      const output = result as { output?: unknown; text?: string };
      return output.output ?? output.text ?? result;
    },
  };
}

export async function generateExampleObject<T>(options: {
  schema: StandardSchemaV1<T>;
  prompt: string;
  system?: string;
  model?: string;
}): Promise<T> {
  const result = await generateText({
    model: createExampleModel(options.model),
    output: Output.object({
      schema: toZodSchema(options.schema),
    }),
    system: options.system,
    prompt: options.prompt,
  });

  return result.output as T;
}

export async function generateExampleText(options: {
  prompt: string;
  system?: string;
  model?: string;
}): Promise<string> {
  const result = await generateText({
    model: createExampleModel(options.model),
    system: options.system,
    prompt: options.prompt,
  });

  return result.text.trim();
}

function resolveOpenAiModel(model: string): string {
  return model.startsWith('openai/') ? model.slice('openai/'.length) : model;
}

function toZodSchema(schema: StandardSchemaV1): z.ZodTypeAny {
  if ('_zod' in schema || '_def' in schema) {
    return schema as unknown as z.ZodTypeAny;
  }

  return z.record(z.string(), z.unknown());
}
