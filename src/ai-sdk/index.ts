import { tool, type FlexibleSchema, type Tool } from 'ai';
import type { AgentTools, StandardSchemaV1 } from '../types.js';

export function toAiSdkTools(tools: AgentTools) {
  const entries: Array<[string, Tool<unknown, unknown> | Tool<unknown, never>]> = [];

  for (const [name, descriptor] of Object.entries(tools)) {
    if (!descriptor) {
      continue;
    }

    if (typeof descriptor === 'function') {
      entries.push([name, tool({
        inputSchema: unknownSchema,
        execute: (input) => descriptor(input),
      })]);
      continue;
    }

    const inputSchema =
      descriptor.inputSchema
      ?? (descriptor.schemas as { input?: StandardSchemaV1 } | undefined)?.input;
    const toolOptions = {
      description: descriptor.description,
      inputSchema: inputSchema
        ? inputSchema as FlexibleSchema<unknown>
        : unknownSchema,
    };

    if (descriptor.execute) {
      entries.push([name, tool({
        ...toolOptions,
        execute: (input) => descriptor.execute?.(input),
      })]);
      continue;
    }

    entries.push([name, tool(toolOptions)]);
  }

  return Object.fromEntries(entries);
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
