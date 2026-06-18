import { generateText, Output, tool } from 'ai';
import { z } from 'zod';
import type {
  AgentAdapter,
  AgentGenerateTextInput,
  AgentTools,
  DecideAdapter,
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
          schema: toZodSchema(outputSchema),
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
            inputSchema: z.unknown(),
            execute: descriptor as any,
          } as any),
        ]];
      }

      const inputSchema =
        descriptor.inputSchema
        ?? (descriptor.schemas as { input?: StandardSchemaV1 } | undefined)?.input;
      const toolOptions: Record<string, unknown> = {
        description: descriptor.description,
        inputSchema: inputSchema ? toZodSchema(inputSchema) : z.unknown(),
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
 * Create a decision helper adapter for decide(...) and classify(...).
 */
export function createAiSdkDecisionAdapter(
  config: CreateAiSdkAdapterOptions = {}
): DecideAdapter {
  const generate = config.generateText ?? generateText;

  return {
    async decide({ model, prompt, options, reasoning }) {
      const optionKeys = Object.keys(options);
      const allSchemaLess = Object.values(options).every((option) => !option.schema);

      if (allSchemaLess && !reasoning) {
        const optionDescriptions = Object.entries(options)
          .map(([key, opt]) => `- ${key}: ${opt.description}`)
          .join('\n');

        const result = await generate({
          model: resolveModel(model, config.resolveModel),
          system: `You must choose exactly one of the following options:\n${optionDescriptions}`,
          prompt,
          output: Output.choice({
            options: optionKeys,
          }),
        });

        return {
          choice: result.output,
          data: {},
        };
      }

      const optionSchemas: z.ZodTypeAny[] = [];
      for (const [key, opt] of Object.entries(options)) {
        optionSchemas.push(
          z.object({
            decision: z.literal(key),
            data: opt.schema ? toZodSchema(opt.schema) : z.object({}),
            ...(reasoning ? { reasoning: z.string() } : {}),
          })
        );
      }

      const schemas = optionSchemas;
      const schema =
        schemas.length === 1
          ? schemas[0]!
          : z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]);

      const optionDescriptions = Object.entries(options)
        .map(([key, opt]) => `- ${key}: ${opt.description}`)
        .join('\n');

      const systemPrompt = `You must choose exactly one of the following options:\n${optionDescriptions}\n\nRespond with structured output containing the chosen decision and any required data.`;

      const result = await generate({
        model: resolveModel(model, config.resolveModel),
        system: systemPrompt,
        prompt,
        output: Output.object({
          schema,
        }),
      });

      const obj = result.output as {
        decision: string;
        data: Record<string, unknown>;
        reasoning?: string;
      };

      return {
        choice: obj.decision,
        data: obj.data ?? {},
        reasoning: obj.reasoning,
      };
    },
  };
}

/**
 * Convert a StandardSchemaV1 to a zod schema.
 * If it's already a zod schema, return as-is.
 * Otherwise, fall back to z.record for basic compatibility.
 */
function toZodSchema(schema: StandardSchemaV1): z.ZodType {
  // Check if it's already a zod schema (has _zod property in v4)
  if ('_zod' in schema || '_def' in schema) {
    return schema as unknown as z.ZodType;
  }
  // Fallback: accept any object
  return z.record(z.string(), z.unknown());
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
