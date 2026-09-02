import { describe, expect, test } from "vitest";
import { createActor, toPromise } from "xstate";
import { z } from "zod";
import { createScriptedExecutors, provideExecutors, runAgent, setupAgent } from "./index.js";

const outcomeSchema = z.enum(["published", "flagged", "blocked"]);

const moderationSetup = setupAgent({
  context: z.object({
    comment: z.string(),
    trust: z.number(),
    outcome: outcomeSchema,
    reason: z.string().nullable(),
  }),
  input: z.object({ comment: z.string(), trust: z.number() }),
  output: z.object({ outcome: outcomeSchema, reason: z.string().nullable() }),
  events: {
    PUBLISH: {},
    FLAG: z.object({ reason: z.string() }),
    BLOCK: {},
  },
});

const moderationMachine = moderationSetup.createMachine({
  context: ({ input }) => ({ ...input, outcome: "flagged" as const, reason: null }),
  output: ({ context }) => ({ outcome: context.outcome, reason: context.reason }),
  initial: "reviewing",
  states: {
    reviewing: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "fast",
          prompt: `Comment: ${context.comment}\nAuthor trust score: ${context.trust}`,
          allowedEvents: ["PUBLISH", "FLAG", "BLOCK"],
        }),
      },
      on: {
        PUBLISH: ({ context }) =>
          context.trust >= 50
            ? { target: "published", context: { outcome: "published" as const } }
            : undefined,
        FLAG: ({ event }) => ({ target: "flagged", context: { reason: event.reason } }),
        BLOCK: () => ({ target: "blocked", context: { outcome: "blocked" as const } }),
      },
    },
    published: { type: "final" },
    flagged: { type: "final" },
    blocked: { type: "final" },
  },
});

/** Two sequential text requests, so text FIFO order is observable. */
const writerSetup = setupAgent({
  context: z.object({ outline: z.string().nullable(), article: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ outline: z.string(), article: z.string() }),
  requests: {
    outline: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      prompt: ({ input }) => `Outline an article about ${input.topic}.`,
    },
    draft: {
      schemas: { input: z.object({ outline: z.string() }), output: z.string() },
      model: "writer",
      prompt: ({ input }) => `Write the article for: ${input.outline}`,
    },
  },
});

const writerMachine = writerSetup.createMachine({
  context: () => ({ outline: null, article: null }),
  output: ({ context }) => ({ outline: context.outline ?? "", article: context.article ?? "" }),
  initial: "outlining",
  states: {
    outlining: {
      invoke: {
        src: "outline",
        input: ({ context: _c, event: _e }) => ({ topic: "state machines" }),
        onDone: ({ output }) => ({ target: "drafting", context: { outline: output } }),
      },
    },
    drafting: {
      invoke: {
        src: "draft",
        input: ({ context }) => ({ outline: context.outline ?? "" }),
        onDone: ({ output }) => ({ target: "done", context: { article: output } }),
      },
    },
    done: { type: "final" },
  },
});

describe("createScriptedExecutors", () => {
  test("plays decisions FIFO through runAgent with no API key", async () => {
    const result = await runAgent(moderationMachine, {
      input: { comment: "honestly this update is terrible", trust: 20 },
      executors: createScriptedExecutors({
        decisions: [{ type: "FLAG", reason: "Borderline tone." }],
      }),
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output).toEqual({ outcome: "flagged", reason: "Borderline tone." });
  });

  test("plays text answers FIFO, one per request, in order", async () => {
    const result = await runAgent(writerMachine, {
      input: { topic: "state machines" },
      executors: createScriptedExecutors({
        text: ["1. Intro 2. Body 3. Outro", "The article itself."],
      }),
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output).toEqual({
      outline: "1. Intro 2. Body 3. Outro",
      article: "The article itself.",
    });
  });

  test("function entries see the request (route on `name`, on candidate events)", async () => {
    const prompts: string[] = [];
    const result = await runAgent(writerMachine, {
      input: { topic: "state machines" },
      executors: createScriptedExecutors({
        text: [
          (request) => {
            prompts.push(request.prompt ?? "");
            return `outline for ${request.name}`;
          },
          async (request) => `draft for ${request.name}`,
        ],
      }),
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output).toEqual({ outline: "outline for outline", article: "draft for draft" });
    expect(prompts[0]).toContain("Outline an article about state machines.");
  });

  test("routes text scripts by request name and records resolved inputs", async () => {
    const scripted = createScriptedExecutors({
      text: {
        draft: ({ input }) => `draft for ${(input as { outline: string }).outline}`,
        outline: ["named outline"],
      },
    });

    const result = await runAgent(writerMachine, {
      input: { topic: "state machines" },
      executors: scripted,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output).toEqual({
      outline: "named outline",
      article: "draft for named outline",
    });
    expect(scripted.calls.map(({ kind, name, input }) => ({ kind, name, input }))).toEqual([
      { kind: "generateText", name: "outline", input: { topic: "state machines" } },
      { kind: "generateText", name: "draft", input: { outline: "named outline" } },
    ]);
  });

  test("supports named decision scripts, wildcard fallback, repeat, and default usage", async () => {
    const scripted = createScriptedExecutors({
      decisions: {
        moderateComment: [{ type: "BLOCK" }],
        "*": [{ type: "FLAG", reason: "fallback" }],
      },
      repeat: true,
      usage: { totalTokens: 3 },
    });

    const request = {
      kind: "decision" as const,
      id: "decision-1",
      name: "moderateComment",
      input: { comment: "spam" },
      model: "fast",
      events: [
        { type: "BLOCK", toolName: "send_event_BLOCK" },
        { type: "FLAG", toolName: "send_event_FLAG" },
      ],
      attempts: [],
    };

    await expect(scripted.decide(request)).resolves.toMatchObject({
      event: { type: "BLOCK" },
      usage: { totalTokens: 3 },
    });
    await expect(scripted.decide(request)).resolves.toMatchObject({
      event: { type: "BLOCK" },
      usage: { totalTokens: 3 },
    });
    expect(scripted.calls).toHaveLength(2);
  });

  test("scripts stream chunks separately from generateText answers", async () => {
    const scripted = createScriptedExecutors({
      stream: { writeDraft: ["hello ", "world"] },
    });
    const chunks: string[] = [];

    const result = await scripted.streamText(
      {
        name: "writeDraft",
        input: { topic: "state machines" },
        model: "fast",
        prompt: "write",
        tools: {},
      },
      { onChunk: (chunk) => chunks.push(chunk) },
    );

    expect(result.output).toBe("hello world");
    expect(chunks).toEqual(["hello ", "world"]);
    expect(scripted.calls[0]).toMatchObject({
      kind: "streamText",
      name: "writeDraft",
      input: { topic: "state machines" },
    });
  });

  test("a decision function entry can pick from the request's candidate events", async () => {
    const result = await runAgent(moderationMachine, {
      input: { comment: "great post", trust: 90 },
      executors: createScriptedExecutors({
        decisions: [
          (request) => {
            expect(request.events.map((event) => event.type).sort()).toEqual([
              "BLOCK",
              "FLAG",
              "PUBLISH",
            ]);
            return { type: "PUBLISH" };
          },
        ],
      }),
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output.outcome).toBe("published");
  });

  test("guard-rejected choices retry against the next scripted decision", async () => {
    // Trust 20 makes PUBLISH illegal, so the first entry is rejected by the
    // guard and the decision retries with the second.
    const result = await runAgent(moderationMachine, {
      input: { comment: "meh", trust: 20 },
      executors: createScriptedExecutors({
        decisions: [{ type: "PUBLISH" }, { type: "BLOCK" }],
      }),
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output.outcome).toBe("blocked");
  });

  test("an entry may be the `{ output, usage }` envelope; usage reaches the run total", async () => {
    const result = await runAgent(writerMachine, {
      input: { topic: "state machines" },
      executors: createScriptedExecutors({
        text: [
          { output: "an outline", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
          { output: "an article", usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 } },
        ],
      }),
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output).toEqual({ outline: "an outline", article: "an article" });
    expect(result.usage).toMatchObject({
      modelCalls: 2,
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
    });
  });

  test("a decision entry may be the `{ event, usage }` envelope", async () => {
    const result = await runAgent(moderationMachine, {
      input: { comment: "spam", trust: 10 },
      executors: createScriptedExecutors({
        decisions: [
          { event: { type: "BLOCK" }, reason: "Obvious spam.", usage: { totalTokens: 7 } },
        ],
      }),
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output.outcome).toBe("blocked");
    expect(result.usage).toMatchObject({ modelCalls: 1, totalTokens: 7 });
  });

  test("a chosen event may carry an `event` payload field", async () => {
    const choice = { type: "FORWARD", event: { type: "NESTED" } };
    const executors = createScriptedExecutors({ decisions: [choice] });

    await expect(
      executors.decide({
        kind: "decision",
        id: "forward",
        name: "forward",
        model: "fast",
        events: [{ type: "FORWARD", toolName: "send_event_FORWARD" }],
        attempts: [],
      }),
    ).resolves.toEqual({ event: choice });
  });

  test("structured output is scripted as the object itself", async () => {
    const noteSetup = setupAgent({
      context: z.object({ note: z.string().nullable() }),
      input: z.object({ comment: z.string() }),
      output: z.object({ note: z.string() }),
      requests: {
        moderatorNote: {
          schemas: {
            input: z.object({ comment: z.string() }),
            output: z.object({ note: z.string() }),
          },
          model: "fast",
          prompt: ({ input }) => `Write a note for: ${input.comment}`,
        },
      },
    });
    const machine = noteSetup.createMachine({
      context: () => ({ note: null }),
      output: ({ context }) => ({ note: context.note ?? "" }),
      initial: "writing",
      states: {
        writing: {
          invoke: {
            src: "moderatorNote",
            input: ({ context: _c }) => ({ comment: "spam" }),
            onDone: ({ output }) => ({ target: "done", context: { note: output.note } }),
          },
        },
        done: { type: "final" },
      },
    });

    const result = await runAgent(machine, {
      input: { comment: "spam" },
      executors: createScriptedExecutors({ text: [{ note: "Repeat offender." }] }),
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output).toEqual({ note: "Repeat offender." });
  });

  test("a structured output with its own `output` key keeps its sibling keys", async () => {
    const executors = createScriptedExecutors({
      // Only `{ output, usage?, raw? }` is the envelope. This object owns a
      // sibling key, so it is the output VALUE — `confidence` must survive.
      text: [{ output: "draft", confidence: 0.9 }],
    });

    const result = await executors.generateText({
      name: "test",
      model: "fast",
      prompt: "hi",
      tools: {},
    });

    expect(result.output).toEqual({ output: "draft", confidence: 0.9 });
    expect(result.usage).toBeUndefined();
  });

  test("an object owning only envelope keys is still read as the envelope", async () => {
    const executors = createScriptedExecutors({
      text: [{ output: "draft", usage: { totalTokens: 5 } }],
    });

    const result = await executors.generateText({
      name: "test",
      model: "fast",
      prompt: "hi",
      tools: {},
    });

    expect(result.output).toBe("draft");
    expect(result.usage).toEqual({ totalTokens: 5 });
  });

  test("an inherited `output` property is not an envelope", async () => {
    const inherited = Object.create({ output: "from the prototype" }) as { note: string };
    inherited.note = "mine";
    const executors = createScriptedExecutors({ text: [inherited] });

    const result = await executors.generateText({
      name: "test",
      model: "fast",
      prompt: "hi",
      tools: {},
    });

    expect(result.output).toBe(inherited);
  });

  test("works with provideExecutors and a plain createActor", async () => {
    const actor = createActor(
      provideExecutors(
        moderationMachine,
        createScriptedExecutors({ decisions: [{ type: "FLAG", reason: "Borderline." }] }),
      ),
      { input: { comment: "hmm", trust: 20 } },
    );
    actor.start();

    await expect(toPromise(actor)).resolves.toEqual({
      outcome: "flagged",
      reason: "Borderline.",
    });
  });

  test("streamText replays the scripted text and forwards it as a chunk", async () => {
    const executors = createScriptedExecutors({ text: ["hello world"] });
    const chunks: string[] = [];
    const result = await executors.streamText(
      { name: "test", model: "fast", prompt: "hi", tools: {} },
      { onChunk: (chunk) => chunks.push(chunk) },
    );

    expect(result).toMatchObject({ output: "hello world" });
    expect(chunks).toEqual(["hello world"]);
  });

  test("throws a descriptive error when the text queue runs dry", async () => {
    const result = await runAgent(writerMachine, {
      input: { topic: "state machines" },
      executors: createScriptedExecutors({ text: ["only one answer"] }),
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(String(result.error)).toContain("script ran dry on a pending text request 'draft'");
    expect(String(result.error)).toContain("`text` queue");
  });

  test("throws a descriptive error naming the candidate events when decisions run dry", async () => {
    const executors = createScriptedExecutors();
    await expect(
      executors.decide({
        kind: "decision",
        id: "0.(machine).reviewing",
        name: "review",
        model: "fast",
        events: [
          { type: "PUBLISH", toolName: "send_event_PUBLISH" },
          { type: "BLOCK", toolName: "send_event_BLOCK" },
        ],
        attempts: [],
      }),
    ).rejects.toThrow(/decision request \(id '0\.\(machine\)\.reviewing'\)[\s\S]*PUBLISH, BLOCK/);
  });

  test("does not mutate the caller's script arrays, so one script seeds many runs", async () => {
    const script = { decisions: [{ type: "BLOCK" }] };
    const run = () =>
      runAgent(moderationMachine, {
        input: { comment: "spam", trust: 10 },
        executors: createScriptedExecutors(script),
      });

    expect((await run()).status).toBe("done");
    expect((await run()).status).toBe("done");
    expect(script.decisions).toHaveLength(1);
  });
});

describe("createScriptedExecutors — userInput", () => {
  const feedbackSetup = setupAgent({
    context: z.object({ feedback: z.string().nullable() }),
    input: z.object({}),
    output: z.object({ feedback: z.string() }),
    events: {},
  });

  const feedbackMachine = feedbackSetup.createMachine({
    context: () => ({ feedback: null }),
    output: ({ context }) => ({ feedback: context.feedback ?? "" }),
    initial: "asking",
    states: {
      asking: {
        invoke: {
          id: "ask",
          src: "agent.userInput",
          input: { prompt: "How was it?" },
          onDone: ({ output }) => ({ target: "done", context: { feedback: output } }),
        },
      },
      done: { type: "final" },
    },
  });

  test("plays the userInput queue back to runAgent's userInput handler", async () => {
    const scripted = createScriptedExecutors({ userInput: ["great"] });
    const result = await runAgent(feedbackMachine, {
      input: {},
      executors: scripted,
      userInput: scripted.userInput,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output.feedback).toBe("great");
  });

  test("entries may be functions of the request", async () => {
    const scripted = createScriptedExecutors({
      userInput: [({ prompt }) => `answering: ${prompt}`],
    });
    await expect(scripted.userInput({ prompt: "How was it?" })).resolves.toBe(
      "answering: How was it?",
    );
  });

  test("a dry userInput queue throws, naming the queue to add to", async () => {
    const scripted = createScriptedExecutors();
    await expect(scripted.userInput({ prompt: "How was it?" })).rejects.toThrow(
      /ran dry on a pending userInput request[\s\S]*`userInput` queue/,
    );
  });
});
