import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, toPromise } from "xstate";
import { createAgentSchemas, createTextLogic, setupAgent, provideExecutors } from "./index.js";

describe("provideExecutors", () => {
  test("binds a mode:'generate' text source to generateText (end-to-end createActor run, typed output)", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ topic: z.string(), draft: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ draft: z.string() }),
    });
    const draftText = createTextLogic({
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "test-model",
      prompt: ({ input }) => input.topic,
    });
    const agent = setupAgent({ schemas, actorSources: { draftText } });
    const machine = agent.createMachine({
      context: ({ input }) => ({ topic: input.topic, draft: null }),
      initial: "drafting",
      states: {
        drafting: {
          invoke: {
            src: "draftText",
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({ target: "done", context: { draft: output } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ draft: context.draft ?? "" }) },
      },
    });

    const seen: string[] = [];
    const bound = provideExecutors(machine, {
      generateText: async (request) => {
        seen.push(request.prompt ?? "");
        return { output: "a draft about cats" };
      },
    });

    const actor = createActor(bound, { input: { topic: "cats" } });
    actor.start();
    const output = await toPromise(actor);

    expect(output).toEqual({ draft: "a draft about cats" });
    expect(seen).toEqual(["cats"]);
  });

  test("binds a mode:'stream' text source to streamText and threads onChunk", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ topic: z.string(), streamed: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ streamed: z.string() }),
    });
    const streamDraft = createTextLogic({
      mode: "stream",
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "test-model",
      prompt: ({ input }) => input.topic,
    });
    const agent = setupAgent({ schemas, actorSources: { streamDraft } });
    const machine = agent.createMachine({
      context: ({ input }) => ({ topic: input.topic, streamed: null }),
      initial: "streaming",
      states: {
        streaming: {
          invoke: {
            src: "streamDraft",
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({ target: "done", context: { streamed: output as string } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ streamed: context.streamed ?? "" }) },
      },
    });

    const chunks: string[] = [];
    const bound = provideExecutors(
      machine,
      {
        generateText: async () => ({ output: "" }),
        streamText: async (_request, info) => {
          info?.onChunk?.("he");
          info?.onChunk?.("llo");
          return { output: "hello" };
        },
      },
      { onChunk: (chunk) => chunks.push(chunk) },
    );

    const actor = createActor(bound, { input: { topic: "dogs" } });
    actor.start();
    const output = await toPromise(actor);

    expect(output).toEqual({ streamed: "hello" });
    expect(chunks).toEqual(["he", "llo"]);
  });

  test("binds an agent.decide source to decide and auto-delivers the chosen event", async () => {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      events: { ATTACK: z.object({}), FLEE: z.object({}) },
    });
    const agent = setupAgent({ schemas });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            src: "agent.decide",
            input: { model: "test-model", allowedEvents: ["ATTACK", "FLEE"] as const },
          },
          on: { ATTACK: { target: "attacked" }, FLEE: { target: "fled" } },
        },
        attacked: { type: "final" },
        fled: { type: "final" },
      },
    });

    const bound = provideExecutors(machine, {
      generateText: async () => ({ output: "" }),
      decide: async () => ({ event: { type: "ATTACK" } }),
    });

    const actor = createActor(bound, { input: {} });
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().value).toBe("attacked");
  });

  test("throws at bind time when a required executor kind is missing", () => {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      events: { ATTACK: z.object({}) },
    });
    const agent = setupAgent({ schemas });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            src: "agent.decide",
            input: { model: "test-model", allowedEvents: ["ATTACK"] as const },
          },
          on: { ATTACK: { target: "done" } },
        },
        done: { type: "final" },
      },
    });

    expect(() =>
      provideExecutors(machine, { generateText: async () => ({ output: "" }) }),
    ).toThrow(/no 'decide' executor/);
  });

  test("merges options.actorSources before binding; an executor-bound override is left as-is", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ draft: z.string().nullable() }),
      input: z.object({}),
      output: z.object({ draft: z.string() }),
    });
    const draftText = createTextLogic({
      schemas: { input: z.object({}), output: z.string() },
      model: "test-model",
      prompt: "draft",
    });
    const agent = setupAgent({ schemas, actorSources: { draftText } });
    const machine = agent.createMachine({
      context: () => ({ draft: null }),
      initial: "drafting",
      states: {
        drafting: {
          invoke: {
            src: "draftText",
            input: {},
            onDone: ({ output }) => ({ target: "done", context: { draft: output as string } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ draft: context.draft ?? "" }) },
      },
    });

    // The override carries its own executor, so provideExecutors must leave it
    // untouched rather than rebinding it to `executors.generateText`.
    const bound = provideExecutors(
      machine,
      { generateText: async () => ({ output: "from executors.generateText" }) },
      { actorSources: { draftText: draftText.withExecutor(async () => ({ output: "overridden" })) } },
    );

    const actor = createActor(bound, { input: {} });
    actor.start();
    const output = await toPromise(actor);

    expect(output).toEqual({ draft: "overridden" });
  });
});
