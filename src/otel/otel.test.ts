import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { beforeEach, describe, expect, test } from "vitest";
import { createActor, toPromise } from "xstate";
import { z } from "zod";
import {
  createScriptedExecutors,
  provideExecutors,
  runAgent,
  setupAgent,
  traceTransitions,
} from "../index.js";
import { createOtelTraceHandler } from "./index.js";

const setup = setupAgent({
  models: { quick: "openai/gpt-5.4-mini" },
  context: z.object({ topic: z.string(), draft: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ draft: z.string() }),
  events: { WRITE: {}, SKIP: {} },
  requests: {
    draft: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "quick",
      prompt: ({ input }) => `Draft ${input.topic}.`,
    },
  },
});

const machine = setup.createMachine({
  id: "drafter",
  version: "1.2.3",
  context: ({ input }) => ({ topic: input.topic, draft: null }),
  output: ({ context }) => ({ draft: context.draft ?? "" }),
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "quick" as const,
          prompt: `Write about ${context.topic}?`,
          allowedEvents: ["WRITE", "SKIP"],
        }),
      },
      on: {
        WRITE: { target: "drafting" },
        SKIP: { target: "done" },
      },
    },
    drafting: {
      invoke: {
        src: "draft",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: {
          target: "done",
          context: ({ event }) => ({ draft: event.output }),
        },
      },
    },
    done: { type: "final" },
  },
});

const script = {
  decisions: [{ event: { type: "WRITE" as const }, usage: { inputTokens: 11, outputTokens: 3 } }],
  text: [{ output: "a draft", usage: { inputTokens: 20, outputTokens: 40, totalTokens: 60 } }],
};

// What a real Node SDK registers; without it `context.active()` is always ROOT
// and nothing the bridge does can nest under a caller's span.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer("test");

/** Spans by name, in export order. */
const named = (name: string): ReadableSpan[] =>
  exporter.getFinishedSpans().filter((span) => span.name === name);

beforeEach(() => {
  exporter.reset();
});

describe("createOtelTraceHandler", () => {
  test("maps a full scripted run onto a GenAI span tree", async () => {
    const onTrace = createOtelTraceHandler({ tracer, providerName: "openai" });

    const result = await runAgent(machine, {
      input: { topic: "state machines" },
      executors: createScriptedExecutors(script),
      onTrace,
    });
    onTrace.dispose();

    expect(result.status).toBe("done");

    const spans = exporter.getFinishedSpans();
    const [runSpan] = named("invoke_agent drafter");
    expect(runSpan).toBeDefined();
    // Children close before the run span, so the run span exports last.
    expect(spans.at(-1)).toBe(runSpan);
    expect(runSpan!.kind).toBe(SpanKind.INTERNAL);
    expect(runSpan!.status.code).toBe(SpanStatusCode.OK);
    expect(runSpan!.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "drafter",
      "gen_ai.agent.version": "1.2.3",
      "agent.machine_id": "drafter",
      "agent.machine_version": "1.2.3",
      "agent.status": "done",
      "agent.trace_schema_version": 1,
    });
    expect(runSpan!.attributes["agent.run_id"]).toEqual(expect.any(String));
    expect(runSpan!.attributes["agent.unfinished"]).toBeUndefined();

    // One child span per model call, both parented to the run span.
    const modelSpans = named("chat quick");
    expect(modelSpans).toHaveLength(2);
    for (const span of modelSpans) {
      expect(span.parentSpanContext?.spanId).toBe(runSpan!.spanContext().spanId);
      expect(span.spanContext().traceId).toBe(runSpan!.spanContext().traceId);
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes).toMatchObject({
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "quick",
        "gen_ai.provider.name": "openai",
      });
    }

    const [decisionSpan, textSpan] = modelSpans as [ReadableSpan, ReadableSpan];
    expect(decisionSpan.attributes).toMatchObject({
      "agent.request_kind": "decision",
      "gen_ai.usage.input_tokens": 11,
      "gen_ai.usage.output_tokens": 3,
    });
    expect(decisionSpan.attributes["agent.request_src"]).toBeUndefined();
    expect(textSpan.attributes).toMatchObject({
      "agent.request_kind": "text",
      "agent.request_src": "draft",
      "gen_ai.usage.input_tokens": 20,
      "gen_ai.usage.output_tokens": 40,
      "agent.usage.total_tokens": 60,
    });

    // Transitions land as span events on the run span, each carrying `seq`.
    const transitions = runSpan!.events.filter((e) => e.name === "agent.transition");
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions[0]!.attributes).toMatchObject({
      "agent.event_type": expect.any(String),
      "agent.seq": expect.any(Number),
    });
    expect(transitions.some((e) => e.attributes?.["agent.event_type"] === "WRITE")).toBe(true);
  });

  test("omits prompts and outputs unless captureContent is set", async () => {
    const onTrace = createOtelTraceHandler({ tracer });
    await runAgent(machine, {
      input: { topic: "privacy" },
      executors: createScriptedExecutors(script),
      onTrace,
    });
    onTrace.dispose();

    for (const span of named("chat quick")) {
      expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
      expect(span.attributes["gen_ai.output.messages"]).toBeUndefined();
      // Sizes are always safe to record.
      expect(span.attributes["agent.output_length"]).toEqual(expect.any(Number));
    }

    exporter.reset();

    const capturing = createOtelTraceHandler({ tracer, captureContent: true });
    await runAgent(machine, {
      input: { topic: "privacy" },
      executors: createScriptedExecutors(script),
      onTrace: capturing,
    });
    capturing.dispose();

    const textSpan = named("chat quick").at(-1)!;
    expect(textSpan.attributes["gen_ai.input.messages"]).toContain("Draft privacy.");
    expect(textSpan.attributes["gen_ai.output.messages"]).toBe('"a draft"');
  });

  test("records a failed model call as an exception and error status", async () => {
    const onTrace = createOtelTraceHandler({ tracer });
    const boom = new Error("model exploded");

    const result = await runAgent(machine, {
      input: { topic: "failure" },
      executors: createScriptedExecutors({
        decisions: [
          () => {
            throw boom;
          },
        ],
      }),
      onTrace,
    });
    onTrace.dispose();

    expect(result.status).toBe("error");

    const modelSpan = named("chat quick").at(-1)!;
    expect(modelSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(modelSpan.attributes["error.type"]).toBe("Error");
    expect(modelSpan.events.some((e) => e.name === "exception")).toBe(true);

    const runSpan = named("invoke_agent drafter").at(-1)!;
    expect(runSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(runSpan.attributes["agent.status"]).toBe("error");
    expect(runSpan.attributes["agent.error_cause"]).toEqual(expect.any(String));
  });

  test("nests the run span under whatever span is active when the run starts", async () => {
    const onTrace = createOtelTraceHandler({ tracer });

    await tracer.startActiveSpan("http.request", async (active) => {
      await runAgent(machine, {
        input: { topic: "nesting" },
        executors: createScriptedExecutors(script),
        onTrace,
      });
      active.end();
    });
    onTrace.dispose();

    const runSpan = named("invoke_agent drafter").at(-1)!;
    const handlerSpan = named("http.request").at(-1)!;
    expect(runSpan.parentSpanContext?.spanId).toBe(handlerSpan.spanContext().spanId);
    expect(runSpan.spanContext().traceId).toBe(handlerSpan.spanContext().traceId);
  });

  test("degrades gracefully with no run boundary (uncontrolled path)", async () => {
    const onTrace = createOtelTraceHandler({ tracer });
    const bound = provideExecutors(machine, createScriptedExecutors(script), { onTrace });
    const actor = createActor(bound, {
      input: { topic: "uncontrolled" },
      inspect: traceTransitions(onTrace),
    });
    actor.start();
    await toPromise(actor);

    // No run.start/run.end on this path: the run span opens on the first event
    // and stays open until dispose().
    expect(named("invoke_agent drafter")).toHaveLength(0);
    onTrace.dispose();

    const runSpan = named("invoke_agent drafter").at(-1)!;
    expect(runSpan).toBeDefined();
    expect(runSpan.attributes["agent.unfinished"]).toBe(true);
    expect(runSpan.attributes["agent.status"]).toBeUndefined();
    for (const span of named("chat quick")) {
      expect(span.parentSpanContext?.spanId).toBe(runSpan.spanContext().spanId);
    }
    expect(runSpan.events.some((e) => e.name === "agent.transition")).toBe(true);
  });

  test("takes a tracer from a provider, and rejects neither", () => {
    const onTrace = createOtelTraceHandler({ tracerProvider: provider });
    onTrace({
      schemaVersion: 1,
      runId: "run_x",
      seq: 0,
      timestamp: new Date().toISOString(),
      machineId: "m",
      machineVersion: "v1",
      type: "run.start",
    });
    onTrace.dispose();
    expect(named("invoke_agent m")).toHaveLength(1);

    expect(() => createOtelTraceHandler({})).toThrow(/tracer/);
  });

  test("dispose() is idempotent and closes an unfinished model span", () => {
    const onTrace = createOtelTraceHandler({ tracer });
    const envelope = {
      schemaVersion: 1,
      runId: "run_y",
      seq: 0,
      timestamp: new Date().toISOString(),
      machineId: "m",
      machineVersion: "v1",
    } as const;
    onTrace({
      ...envelope,
      type: "request.start",
      request: {
        kind: "decision",
        id: "d1",
        model: "quick",
        events: [],
        attempts: [],
      },
    });
    onTrace.dispose();
    onTrace.dispose();

    expect(named("chat quick")).toHaveLength(1);
    expect(named("chat quick")[0]!.attributes["agent.unfinished"]).toBe(true);
    expect(named("invoke_agent m")).toHaveLength(1);
  });
});
