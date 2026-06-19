import { generateText, Output, tool, type FlexibleSchema } from 'ai';
import type {
  AgentAdapter,
  AgentGenerateTextInput,
  AgentTools,
  StandardSchemaV1,
} from '../types.js';

type AiSdkGenerateText = typeof generateText;
type AiSdkModel = Parameters<typeof generateText>[0]['model'];

export interface CreateAiSdkAdapterOptions {
  resolveModel?: (modelRef: string) => AiSdkModel;
  generateText?: AiSdkGenerateText;
}

/**
 * Create an adapter that uses the Vercel AI SDK for generative states.
 * By default, model refs are passed straight through to the AI SDK.
 * For provider helpers such as `openai(...)`, pass `resolveModel`.
 */
export function createAiSdkAdapter(
  config: CreateAiSdkAdapterOptions = {}
): AgentAdapter {
  const generate = config.generateText ?? generateText;

  return {
    async generateText(input) {
      const result = await generate(toAiSdkGenerateTextOptions(input, {
        resolveModel: config.resolveModel,
      }));

      const output = result as { output?: unknown; text?: string };
      return output.output ?? output.text ?? result;
    },
  };
}

export function toAiSdkGenerateTextOptions(
  { modelRef, system, prompt, messages, tools, toolChoice, outputSchema }: AgentGenerateTextInput,
  config: Pick<CreateAiSdkAdapterOptions, 'resolveModel'> = {}
): Parameters<typeof generateText>[0] {
  const options: any = {
    model: resolveModel(modelRef ?? 'default', config.resolveModel),
    system,
    tools: tools ? toAiSdkTools(tools) : undefined,
    toolChoice: toAiSdkToolChoice(toolChoice),
    ...(outputSchema
      ? {
        output: Output.object({
          schema: outputSchema as FlexibleSchema<unknown>,
        }),
      }
      : {}),
  };

  if (messages.length > 0) {
    options.messages = messages as any;
  } else {
    options.prompt = prompt ?? '';
  }

  return options;
}

export function toAiSdkTools(tools: AgentTools) {
  return Object.fromEntries(
    Object.entries(tools).flatMap(([name, descriptor]) => {
      if (!descriptor) {
        return [];
      }

      if (typeof descriptor === 'function') {
        return [[
          name,
          tool({
            inputSchema: unknownSchema,
            execute: descriptor as any,
          } as any),
        ]];
      }

      const inputSchema =
        descriptor.inputSchema
        ?? (descriptor.schemas as { input?: StandardSchemaV1 } | undefined)?.input;
      const toolOptions: Record<string, unknown> = {
        description: descriptor.description,
        inputSchema: inputSchema
          ? inputSchema as FlexibleSchema<unknown>
          : unknownSchema,
        execute: descriptor.execute as any,
      };

      return [[name, tool(toolOptions as any)]];
    })
  );
}

function toAiSdkToolChoice(toolChoice: AgentGenerateTextInput['toolChoice']) {
  if (!toolChoice) {
    return undefined;
  }

  if (typeof toolChoice === 'object') {
    return { type: 'tool' as const, toolName: toolChoice.name };
  }

  return toolChoice;
}

/**
 * Resolve a portable model ref to an AI SDK model.
 * Supports custom resolution when users prefer provider helpers such as
 * `openai('gpt-5.4-nano')`.
 */
function resolveModel(
  modelRef: string,
  resolver?: (modelRef: string) => AiSdkModel
): AiSdkModel {
  if (resolver) {
    return resolver(modelRef);
  }

  return modelRef as any;
}

const unknownSchema = {
  '~standard': {
    version: 1,
    vendor: 'statelyai-agent',
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      input: () => ({}),
    },
  },
} as unknown as StandardSchemaV1 & FlexibleSchema<unknown>;
