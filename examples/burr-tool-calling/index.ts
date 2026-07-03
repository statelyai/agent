/**
 * Burr Tool Calling — tool selection, execution, and final formatting as
 * separate, independently testable steps.
 *
 * Burr's `tool-calling` example has the model choose a tool and args, then
 * runs it and formats the result. This is structured-output classification
 * (`selectTool` returns one of a discriminated union), not an event-choice
 * decision: there is exactly one live path forward from `dispatch`, chosen
 * by inspecting the request's typed output — not a model picking among
 * several legal machine *events* from a waiting state (the pattern the
 * decision primitive — `agent.decide`/`sendDecision()` — targets; see
 * twenty-questions). So this
 * stays a co-located `requests:` + guarded `always` routing, the same shape
 * as burr-multi-agent-collaboration's supervisor — hosted with `runAgent`
 * instead of manual `createActor`/`toPromise` choreography.
 */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAsyncLogic } from 'xstate';
import { runAgent, setupAgent, type AgentTextRequest, type AgentTools } from '../../src/index.js';
const models = {
  "tool-router": "tool-router",
  "formatter": "formatter",
} as const;


export async function runBurrToolCallingExample() {
  const selectedToolSchema = z.discriminatedUnion('tool', [
    z.object({
      tool: z.literal('queryWeather'),
      parameters: z.object({ latitude: z.number(), longitude: z.number() }),
    }),
    z.object({
      tool: z.literal('fallback'),
      parameters: z.object({ response: z.string() }),
    }),
  ]);
  const agent = setupAgent({
    models,
    context: z.object({
      query: z.string(),
      selected: selectedToolSchema.nullable(),
      rawResponse: z.record(z.string(), z.unknown()).nullable(),
      finalOutput: z.string().nullable(),
    }),
    input: z.object({ query: z.string() }),
    output: z.object({ finalOutput: z.string() }),
    actors: {
      queryWeather: createAsyncLogic<
        Record<string, unknown>,
        { latitude: number; longitude: number }
      >({
        run: async ({ input }) => ({
          forecast: 'sunny',
          location: `${input.latitude},${input.longitude}`,
        }),
      }),
      fallback: createAsyncLogic<Record<string, unknown>, { response: string }>({
        run: async ({ input }) => ({ response: input.response }),
      }),
    },
    requests: {
      selectTool: {
        schemas: {
          input: z.object({ query: z.string() }),
          output: selectedToolSchema,
        },
        model: 'tool-router',
        system: 'Select exactly one tool.',
        prompt: ({ input }) => input.query,
      },
      formatResult: {
        schemas: {
          input: z.object({
            query: z.string(),
            rawResponse: z.record(z.string(), z.unknown()),
          }),
          output: z.string(),
        },
        model: 'formatter',
        prompt: ({ input }) =>
          `Question: ${input.query}\nData: ${JSON.stringify(input.rawResponse)}`,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'burr-tool-calling-xstate',
    context: ({ input }) => ({
      query: input.query,
      selected: null,
      rawResponse: null,
      finalOutput: null,
    }),
    initial: 'selectingTool',
    states: {
      selectingTool: {
        invoke: {
          src: 'selectTool',
          input: ({ context }) => ({ query: context.query }),
          onDone: ({ output }) => ({
            target: 'dispatch',
            context: { selected: output },
          }),
        },
      },
      dispatch: {
        always: ({ context }) =>
          context.selected?.tool === 'queryWeather'
            ? { target: 'queryingWeather' }
            : { target: 'fallingBack' },
      },
      queryingWeather: {
        invoke: {
          src: 'queryWeather',
          input: ({ context }) =>
            context.selected?.tool === 'queryWeather'
              ? context.selected.parameters
              : { latitude: 0, longitude: 0 },
          onDone: ({ output }) => ({
            target: 'formatting',
            context: { rawResponse: output },
          }),
        },
      },
      fallingBack: {
        invoke: {
          src: 'fallback',
          input: ({ context }) =>
            context.selected?.tool === 'fallback'
              ? context.selected.parameters
              : { response: 'No tool selected.' },
          onDone: ({ output }) => ({
            target: 'formatting',
            context: { rawResponse: output },
          }),
        },
      },
      formatting: {
        invoke: {
          src: 'formatResult',
          input: ({ context }) => ({
            query: context.query,
            rawResponse: context.rawResponse ?? {},
          }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { finalOutput: output },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ finalOutput: context.finalOutput ?? '' }),
      },
    },
  });

  const generateText = async (request: AgentTextRequest & { tools: AgentTools }) => {
    if (request.model === 'tool-router') {
      return {
        object: {
          tool: 'queryWeather',
          parameters: { latitude: 37.77, longitude: -122.42 },
        },
      };
    }
    // request.model === 'formatter'; prompt's second line is `Data: ${JSON}`.
    const dataLine = (request.prompt ?? '').split('\n')[1] ?? 'Data: {}';
    const rawResponse = JSON.parse(dataLine.replace('Data: ', '')) as {
      forecast: string;
    };
    return `formatted:${rawResponse.forecast}`;
  };

  const result = await runAgent(machine, {
    input: { query: 'weather in San Francisco' },
    generateText,
  });

  if (result.status !== 'done') {
    throw new Error(`Tool-calling example did not complete: ${result.status}`);
  }
  assert.deepEqual(result.output, {
    finalOutput: 'formatted:sunny',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runBurrToolCallingExample();
}
