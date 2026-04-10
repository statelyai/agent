import { z } from 'zod';
import { createAgentMachine } from '../machine.js';
import type { AgentMachine, StandardSchemaV1 } from '../types.js';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  name: z.string().optional(),
});

const toolCallSchema = z.object({
  kind: z.literal('tool'),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  message: z.string().optional(),
});

const finalAnswerSchema = z.object({
  kind: z.literal('final'),
  message: z.string(),
});

const modelResultSchema = z.discriminatedUnion('kind', [
  toolCallSchema,
  finalAnswerSchema,
]);

export type ReactAgentMessage = z.infer<typeof messageSchema>;

export type ReactTool = {
  name: string;
  description: string;
  schema?: StandardSchemaV1;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

export type ReactAgentModelResult = z.infer<typeof modelResultSchema>;

export function createReactAgent(options: {
  prompt?: string;
  maxSteps?: number;
  tools?: ReactTool[];
  model: (args: {
    messages: ReactAgentMessage[];
    tools: Array<{
      name: string;
      description: string;
      schema?: StandardSchemaV1;
    }>;
  }) => Promise<ReactAgentModelResult>;
}): AgentMachine<
  { messages?: ReactAgentMessage[] },
  {
    messages: ReactAgentMessage[];
    stepCount: number;
    pendingToolCall:
      | { toolName: string; input: Record<string, unknown> }
      | null;
  }
> {
  const tools = options.tools ?? [];
  const maxSteps = options.maxSteps ?? 8;
  const toolDefinitions = tools.map(({ name, description, schema }) => ({
    name,
    description,
    schema,
  }));
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  function serializeToolOutput(output: unknown): string {
    return typeof output === 'string' ? output : JSON.stringify(output);
  }

  return createAgentMachine({
    id: 'prebuilt-react-agent',
    schemas: {
      input: z.object({
        messages: z.array(messageSchema).optional(),
      }),
      emitted: {
        textPart: z.object({ delta: z.string() }),
        toolCall: z.object({
          toolName: z.string(),
          input: z.record(z.string(), z.unknown()),
        }),
        toolResult: z.object({
          toolName: z.string(),
          output: z.unknown(),
        }),
      },
    },
    context: (input) => ({
      messages: [
        ...(options.prompt
          ? ([{ role: 'system', content: options.prompt }] satisfies ReactAgentMessage[])
          : []),
        ...(input.messages ?? []),
      ],
      stepCount: 0,
      pendingToolCall:
        null as { toolName: string; input: Record<string, unknown> } | null,
    }),
    initial: 'agent',
    states: {
      agent: {
        resultSchema: modelResultSchema,
        invoke: async ({ context }, enq) => {
          if (context.stepCount >= maxSteps) {
            return {
              kind: 'final' as const,
              message: 'Stopped because the maximum step count was reached.',
            };
          }

          const result = await options.model({
            messages: context.messages,
            tools: toolDefinitions,
          });

          if (result.kind === 'final') {
            enq.emit({ type: 'textPart', delta: result.message });
          }

          return result;
        },
        onDone: ({ result, context }) => {
          if (result.kind === 'final') {
            return {
              target: 'done' as const,
              context: {
                stepCount: context.stepCount + 1,
                messages: [
                  ...context.messages,
                  { role: 'assistant', content: result.message },
                ],
              },
            };
          }

          return {
            target: 'tool' as const,
            context: {
              stepCount: context.stepCount + 1,
              pendingToolCall: {
                toolName: result.toolName,
                input: result.input,
              },
              messages: [
                ...context.messages,
                {
                  role: 'assistant',
                  content:
                    result.message
                    ?? `Calling tool ${result.toolName} with ${JSON.stringify(result.input)}`,
                },
              ],
            },
            params: {
              toolName: result.toolName,
              input: result.input,
            },
          };
        },
      },
      tool: {
        paramsSchema: z.object({
          toolName: z.string(),
          input: z.record(z.string(), z.unknown()),
        }),
        resultSchema: z.object({
          toolName: z.string(),
          output: z.unknown(),
        }),
        invoke: async ({ params }, enq) => {
          const tool = toolsByName.get(params.toolName);

          if (!tool) {
            throw new Error(`Tool '${params.toolName}' not found`);
          }

          enq.emit({
            type: 'toolCall',
            toolName: params.toolName,
            input: params.input,
          });

          const output = await tool.execute(params.input);

          enq.emit({
            type: 'toolResult',
            toolName: params.toolName,
            output,
          });

          return {
            toolName: params.toolName,
            output,
          };
        },
        onDone: ({ result, context }) => ({
          target: 'agent' as const,
          context: {
            pendingToolCall: null,
            messages: [
              ...context.messages,
              {
                role: 'tool',
                name: result.toolName,
                content: serializeToolOutput(result.output),
              },
            ],
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          messages: context.messages,
          finalMessage: context.messages.at(-1)?.content ?? null,
          steps: context.stepCount,
        }),
      },
    },
  });
}
