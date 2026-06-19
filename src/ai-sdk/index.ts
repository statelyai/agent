import { tool, type FlexibleSchema } from 'ai';
import type { AgentTools, StandardSchemaV1 } from '../types.js';

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
