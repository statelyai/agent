import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import { blurbMachine, createTracing, formatSpanTree, main, scriptedExecutors } from "./index.js";

/**
 * Every test passes an explicit empty env, so a developer's real
 * `LANGSMITH_API_KEY` can never turn these into live uploads: the keyless
 * branch is what runs, and the in-memory exporter is what gets asserted.
 */
const keyless = async () => {
  const tracing = createTracing({});
  const result = await runAgent(blurbMachine, {
    input: { topic: "why state machines for agents" },
    executors: scriptedExecutors(),
    onTrace: tracing.onTrace,
  });
  tracing.onTrace.dispose();
  await tracing.shutdown();
  return { result, spans: tracing.spans };
};

describe("langsmith-otel", () => {
  test("a keyless run exports a run span with one child per model call", async () => {
    const { result, spans } = await keyless();

    expect(result.status).toBe("done");

    const run = spans.find((span) => span.attributes["gen_ai.operation.name"] === "invoke_agent");
    const calls = spans.filter((span) => span.attributes["gen_ai.operation.name"] === "chat");

    expect(run?.name).toBe("invoke_agent blurb-writer");
    expect(run?.kind).toBe(SpanKind.INTERNAL);
    expect(run?.status.code).toBe(SpanStatusCode.OK);
    // The decision and the text request, each its own CLIENT span under the run.
    expect(calls).toHaveLength(2);
    expect(calls.map((span) => span.name)).toEqual(["chat writer", "chat writer"]);
    expect(calls.every((span) => span.kind === SpanKind.CLIENT)).toBe(true);
    expect(calls.map((span) => span.attributes["agent.request_kind"]).sort()).toEqual([
      "decision",
      "text",
    ]);
  });

  test("the child spans really parent onto the run span", async () => {
    const { spans } = await keyless();

    const run = spans.find((span) => span.attributes["gen_ai.operation.name"] === "invoke_agent")!;
    const runId = run.spanContext().spanId;
    const calls = spans.filter((span) => span.attributes["gen_ai.operation.name"] === "chat");

    expect(run.parentSpanContext).toBeUndefined();
    expect(calls.map((span) => span.parentSpanContext?.spanId)).toEqual([runId, runId]);
    // One trace, not three disconnected ones.
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
  });

  test("run and request spans carry the semconv and agent attributes", async () => {
    const { spans } = await keyless();

    const run = spans.find((span) => span.attributes["gen_ai.operation.name"] === "invoke_agent")!;
    expect(run.attributes["gen_ai.agent.name"]).toBe("blurb-writer");
    expect(run.attributes["agent.machine_id"]).toBe("langsmith-blurb");
    expect(run.attributes["agent.status"]).toBe("done");
    // The `attributes` option lands on every span the bridge creates.
    expect(run.attributes["deployment.environment.name"]).toBe("development");

    const call = spans.find((span) => span.attributes["agent.request_kind"] === "text")!;
    expect(call.attributes["gen_ai.request.model"]).toBe("writer");
    expect(call.attributes["gen_ai.provider.name"]).toBe("openai");
    expect(call.attributes["deployment.environment.name"]).toBe("development");
    // Sizes, not bodies: `captureContent` is off, so no message content ships.
    expect(call.attributes["agent.output_length"]).toBeGreaterThan(0);
    expect(call.attributes["gen_ai.output.messages"]).toBeUndefined();
  });

  test("machine transitions ride the run span as span events", async () => {
    const { spans } = await keyless();

    const run = spans.find((span) => span.attributes["gen_ai.operation.name"] === "invoke_agent")!;
    const transitions = run.events.filter((event) => event.name === "agent.transition");

    expect(transitions.map((event) => event.attributes?.["agent.event_type"])).toContain("WRITE");
    // Every span event carries `seq`, so a consumer can re-order downstream.
    expect(transitions.every((event) => typeof event.attributes?.["agent.seq"] === "number")).toBe(
      true,
    );
  });

  test("the span tree renders the run with its model calls nested under it", async () => {
    const { spans } = await keyless();
    const tree = formatSpanTree(spans);

    const [first, ...rest] = tree.split("\n");
    expect(first).toContain("invoke_agent blurb-writer");
    // The two model calls are indented children, not siblings of the run.
    expect(rest.filter((line) => line.includes("└─ chat writer"))).toHaveLength(2);
  });

  test("the demo runs end to end with no API key", async () => {
    await expect(main({})).resolves.toBeUndefined();
  });
});
