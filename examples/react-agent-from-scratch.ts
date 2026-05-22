import { z } from 'zod';
import { execute } from '../src/local/index.js';
import { createAgentMachine, type StandardSchemaV1 } from '../src/index.js';

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

const reactOutputSchema = z.object({
  messages: z.array(messageSchema),
  finalMessage: z.string().nullable(),
  steps: z.number().int().min(0),
});

export type ReactAgentMessage = z.infer<typeof messageSchema>;

export type ReactTool = {
  name: string;
  description: string;
  schema?: StandardSchemaV1;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

export type ReactAgentModelResult = z.infer<typeof modelResultSchema>;

export function createReactAgentFromScratch(options: {
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
}) {
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
    id: 'react-agent-from-scratch',
    schemas: {
      input: z.object({
        messages: z.array(messageSchema).optional(),
      }),
      output: reactOutputSchema,
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
        schemas: { output: modelResultSchema },
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
        onDone: ({ output, context }) => {
          if (output.kind === 'final') {
            return {
              target: 'done' as const,
              context: {
                stepCount: context.stepCount + 1,
                messages: [
                  ...context.messages,
                  {
                    role: 'assistant',
                    content: output.message,
                  } satisfies ReactAgentMessage,
                ],
              },
            };
          }

          return {
            target: 'tool' as const,
            context: {
              stepCount: context.stepCount + 1,
              pendingToolCall: {
                toolName: output.toolName,
                input: output.input,
              },
              messages: [
                ...context.messages,
                {
                  role: 'assistant',
                  content:
                    output.message
                    ?? `Calling tool ${output.toolName} with ${JSON.stringify(output.input)}`,
                } satisfies ReactAgentMessage,
              ],
            },
            input: {
              toolName: output.toolName,
              input: output.input,
            },
          };
        },
      },
      tool: {
        schemas: { input: z.object({
          toolName: z.string(),
          input: z.record(z.string(), z.unknown()),
        }), output: z.object({
          toolName: z.string(),
          output: z.unknown(),
        }) },
        invoke: async ({ input }, enq) => {
          const tool = toolsByName.get(input.toolName);

          if (!tool) {
            throw new Error(`Tool '${input.toolName}' not found`);
          }

          enq.emit({
            type: 'toolCall',
            toolName: input.toolName,
            input: input.input,
          });

          const output = await tool.execute(input.input);

          enq.emit({
            type: 'toolResult',
            toolName: input.toolName,
            output,
          });

          return {
            toolName: input.toolName,
            output,
          };
        },
        onDone: ({ output, context }) => ({
          target: 'agent' as const,
          context: {
            pendingToolCall: null,
            messages: [
              ...context.messages,
              {
                role: 'tool',
                name: output.toolName,
                content: serializeToolOutput(output.output),
              } satisfies ReactAgentMessage,
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
