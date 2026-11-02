/**
 * Declaration-portability canary (see tsconfig.json). Every export below has
 * an INFERRED type; emitting its declaration under `composite: true` makes TS
 * name each referenced type through a public entry, raising TS2742 when one is
 * only reachable through an internal `dist/*-<hash>.d.mts` chunk.
 */
import { z } from "zod";
import { createActor, createAsyncLogic } from "xstate";
import { createAgentRuntime, createAgentSchemas, runAgent, setupAgent } from "@statelyai/agent";
import { createApprovalBatchMachine, createToolLoopMachine } from "@statelyai/agent/machines";

/** A bare setupAgent result. */
export const batchSetup = setupAgent({
  models: { quick: "openai/gpt-6-luna" },
  context: z.object({ items: z.array(z.string()), done: z.number() }),
  input: z.object({ items: z.array(z.string()) }),
  output: z.object({ done: z.number() }),
  events: {
    APPROVE: z.object({ id: z.string() }),
    REJECT: z.object({ id: z.string(), reason: z.string().optional() }),
    CANCEL: z.object({}),
  },
  requests: {
    classify: {
      schemas: {
        input: z.object({ item: z.string() }),
        output: z.object({ label: z.enum(["a", "b"]) }),
      },
      model: "quick",
      prompt: ({ input }) => `Classify ${input.item}.`,
    },
  },
});

/** A setupAgent machine value. */
export const batchMachine = batchSetup.createMachine({
  id: "batch",
  context: ({ input }) => ({ items: input.items, done: 0 }),
  initial: "classifying",
  states: {
    classifying: {
      invoke: {
        src: "classify",
        input: ({ context }) => ({ item: context.items[0] ?? "" }),
        onDone: { target: "awaiting" },
      },
    },
    awaiting: {
      on: {
        APPROVE: { target: "done", context: ({ context }) => ({ ...context, done: 1 }) },
        REJECT: { target: "done" },
        CANCEL: { target: "done" },
      },
    },
    deciding: {
      invoke: {
        src: "agent.decide",
        input: () => ({ model: "quick" as const, prompt: "Approve?" }),
      },
      on: { APPROVE: { target: "done" } },
    },
    done: { type: "final" },
  },
  output: ({ context }) => ({ done: context.done }),
});

/** A createMachine factory. */
export function createBatchMachine(id: string) {
  return batchSetup.createMachine({
    id,
    context: ({ input }) => ({ items: input.items, done: 0 }),
    initial: "done",
    states: { done: { type: "final" } },
    output: ({ context }) => ({ done: context.done }),
  });
}

/** The runAgent result type of a setupAgent machine. */
export type BatchResult = Awaited<ReturnType<typeof runAgent<typeof batchMachine>>>;

/** A runAgent call with an inferred return type. */
export function runBatch() {
  return runAgent(batchMachine, { input: { items: ["x"] } });
}

/** A createAgentRuntime value. */
export const runtime = createAgentRuntime(batchMachine);

/** A plain XState actor of a setupAgent machine. */
export const actor = createActor(batchMachine, { input: { items: [] } });

/** Preset machines from /machines. */
export const approvalMachine = createApprovalBatchMachine({
  execute: createAsyncLogic({ run: async () => "ok" }),
});
export function createToolCallMachine() {
  return createApprovalBatchMachine({ execute: createAsyncLogic({ run: async () => "ok" }) });
}
export const toolLoopMachine = createToolLoopMachine({ model: "openai/gpt-6-luna" });

// A second setup exercising the rest of the config surface: a schema pack,
// payload-less `{}` events, actors, guards, delays, emitted events, and meta.
const schemas = createAgentSchemas({
  context: z.object({ count: z.number() }),
  events: { INC: {}, SET: z.object({ value: z.number() }) },
  emitted: { changed: z.object({ count: z.number() }) },
  meta: z.object({ label: z.string() }),
});
export const counterSetup = setupAgent({
  schemas,
  actors: { load: createAsyncLogic({ run: async () => 1 }) },
  guards: { isSmall: ({ context }) => context.count < 10 },
  delays: { tick: 100 },
});
export const counterMachine = counterSetup.createMachine({
  context: { count: 0 },
  initial: "idle",
  states: {
    idle: {
      invoke: { src: "load", onDone: { target: "active" } },
    },
    active: {
      after: { tick: { target: "idle" } },
      on: {
        INC: ({ context, guards }) =>
          guards.isSmall({ context }) ? { context: { count: context.count + 1 } } : undefined,
        SET: { context: ({ event }) => ({ count: event.value }) },
      },
    },
  },
});
export type CounterResult = Awaited<ReturnType<typeof runAgent<typeof counterMachine>>>;
export const counterRuntime = createAgentRuntime(counterMachine);
