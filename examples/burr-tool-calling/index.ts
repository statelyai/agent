import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

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

  const actor = createActor(
    machine.provide({
      actorSources: {
        selectTool: agent.requests.selectTool.withExecutor(async () => ({
          tool: 'queryWeather',
          parameters: { latitude: 37.77, longitude: -122.42 },
        })),
        formatResult: agent.requests.formatResult.withExecutor(
          async ({ input }) => `formatted:${input.rawResponse.forecast}`,
        ),
      },
    }),
    { input: { query: 'weather in San Francisco' } },
  );
  actor.start();
  await toPromise(actor);

  assert.deepEqual(actor.getSnapshot().output, {
    finalOutput: 'formatted:sunny',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runBurrToolCallingExample();
}
