/**
 * LangSmith over OpenTelemetry — a real, one-step vendor config.
 *
 * There is no adapter and no shim here. `@statelyai/agent/otel` turns the
 * versioned `AgentTraceEvent` stream into GenAI-semconv spans; everything else
 * is stock OpenTelemetry (`NodeTracerProvider` + `OTLPTraceExporter`). Pointing
 * the same run at Braintrust, Langfuse, Honeycomb, or Grafana Tempo is a
 * different `url` + `headers` on the exporter, nothing else.
 *
 * Two modes, chosen by env:
 *   - `LANGSMITH_API_KEY` set: OTLP/HTTP export to LangSmith
 *     (`https://api.smith.langchain.com/otel/v1/traces`, headers `x-api-key`
 *     and optional `Langsmith-Project`). Endpoint and header names verified
 *     against https://docs.langchain.com/langsmith/trace-with-opentelemetry on
 *     2026-08-01. HONEST CAVEAT: this example is written and tested without a
 *     LangSmith account, so the config matches the published docs but the live
 *     upload has never been executed. Check your LangSmith project after the
 *     first run.
 *   - no key: spans go to an in-memory exporter and the finished span tree is
 *     printed, so a keyless run still shows the whole shape of what would be
 *     uploaded.
 *
 * Model calls are scripted (`createScriptedExecutors`), so no provider key is
 * needed either — the subject is the trace wiring, not the generation.
 *
 * Run: npx tsx examples/langsmith-otel/index.ts
 * Env: LANGSMITH_API_KEY (enables real OTLP export), LANGSMITH_PROJECT,
 *      LANGSMITH_OTEL_ENDPOINT (override for EU/APAC/AWS hosts).
 */
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { z } from "zod";
import { createScriptedExecutors, runAgent, setupAgent } from "@statelyai/agent";
import { createOtelTraceHandler, type OtelTraceHandler } from "@statelyai/agent/otel";

/**
 * LangSmith's OTLP/HTTP trace endpoint (US, the default host). Swap the host
 * for another region: `eu.api.smith.langchain.com`, `apac.api.smith.langchain.com`,
 * or `aws.api.smith.langchain.com`.
 */
const LANGSMITH_TRACES_URL = "https://api.smith.langchain.com/otel/v1/traces";

// ─── A small agent: decide whether to write, then write ───

const agentSetup = setupAgent({
  context: z.object({ topic: z.string(), blurb: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ blurb: z.string() }),
  events: { WRITE: z.object({}), SKIP: z.object({}) },
  requests: {
    writeBlurb: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      system: "Write a one-sentence blurb.",
      prompt: ({ input }) => `Write a blurb about: ${input.topic}`,
    },
  },
});

export const blurbMachine = agentSetup.createMachine({
  id: "langsmith-blurb",
  context: ({ input }) => ({ topic: input.topic, blurb: null }),
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        id: "decide",
        src: "agent.decide",
        input: ({ context: ctx }) => ({
          model: "writer",
          system: "WRITE if the topic is worth a blurb, else SKIP.",
          prompt: ctx.topic,
          allowedEvents: ["WRITE", "SKIP"],
        }),
      },
      on: { WRITE: { target: "writing" }, SKIP: { target: "skipped" } },
    },
    writing: {
      invoke: {
        id: "write",
        src: "writeBlurb",
        input: ({ context: ctx }) => ({ topic: ctx.topic }),
        onDone: ({ output }) => ({ target: "done", context: { blurb: output } }),
      },
    },
    done: { type: "final", output: ({ context: ctx }) => ({ blurb: ctx.blurb ?? "" }) },
    skipped: { type: "final", output: () => ({ blurb: "" }) },
  },
});

/** Keyless, deterministic stand-in for a model host. */
export const scriptedExecutors = () =>
  createScriptedExecutors({
    decisions: [{ type: "WRITE" }],
    text: ["State machines make illegal states unreachable."],
  });

// ─── OpenTelemetry setup: the whole vendor integration ───

/** What {@link createTracing} hands back: a handler, a sink, and a shutdown. */
export interface Tracing {
  /** Pass straight to `runAgent`'s `onTrace`. Dispose it when the run settles. */
  onTrace: OtelTraceHandler;
  /** Where spans went, for the summary line. */
  destination: string;
  /**
   * The finished spans, in keyless mode only, valid after `shutdown()`.
   * Snapshotted there because shutting an `InMemorySpanExporter` down clears it.
   */
  readonly spans: ReadableSpan[];
  /** Flushes the exporter and stops the provider. */
  shutdown(): Promise<void>;
}

/**
 * Builds the tracer provider, the exporter, and the bridge handler.
 *
 * The keyed branch is the part worth copying: a stock `OTLPTraceExporter` with
 * the vendor's URL and headers, and `createOtelTraceHandler` on top of the
 * provider's tracer. Nothing about the agent changes per vendor.
 */
export function createTracing(env: NodeJS.ProcessEnv = process.env): Tracing {
  const apiKey = env.LANGSMITH_API_KEY;
  const collected = apiKey ? undefined : new InMemorySpanExporter();

  const processor = apiKey
    ? new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: env.LANGSMITH_OTEL_ENDPOINT ?? LANGSMITH_TRACES_URL,
          headers: {
            "x-api-key": apiKey,
            ...(env.LANGSMITH_PROJECT ? { "Langsmith-Project": env.LANGSMITH_PROJECT } : {}),
          },
        }),
      )
    : // Keyless: keep the spans in process so the run can print them.
      new SimpleSpanProcessor(collected!);

  const provider = new NodeTracerProvider({ spanProcessors: [processor] });

  const onTrace = createOtelTraceHandler({
    // A tracer straight off the provider — no global registration needed, since
    // the bridge parents its own spans explicitly.
    tracer: provider.getTracer("langsmith-otel-example"),
    agentName: "blurb-writer",
    providerName: "openai",
    attributes: { "deployment.environment.name": env.NODE_ENV ?? "development" },
  });

  const spans: ReadableSpan[] = [];

  return {
    onTrace,
    spans,
    destination: apiKey
      ? `LangSmith (${env.LANGSMITH_OTEL_ENDPOINT ?? LANGSMITH_TRACES_URL})`
      : "in-memory exporter (no LANGSMITH_API_KEY)",
    shutdown: async () => {
      await provider.forceFlush();
      spans.push(...(collected?.getFinishedSpans() ?? []));
      await provider.shutdown();
    },
  };
}

// ─── Printing the span tree ───

const spanId = (span: ReadableSpan) => span.spanContext().spanId;
const durationMs = (span: ReadableSpan) => span.duration[0] * 1e3 + span.duration[1] / 1e6;

/**
 * Renders finished spans as an indented tree: the same parent/child shape a
 * vendor UI draws, so a keyless run shows exactly what would be uploaded.
 */
export function formatSpanTree(spans: readonly ReadableSpan[]): string {
  const byParent = new Map<string | undefined, ReadableSpan[]>();
  for (const span of spans) {
    const parent = span.parentSpanContext?.spanId;
    // A parent outside this batch is a root as far as the rendering goes.
    const key = parent && spans.some((other) => spanId(other) === parent) ? parent : undefined;
    byParent.set(key, [...(byParent.get(key) ?? []), span]);
  }

  const lines: string[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    const children = [...(byParent.get(parent) ?? [])].sort(
      (a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1],
    );
    for (const span of children) {
      const indent = "  ".repeat(depth);
      lines.push(
        `${indent}${depth > 0 ? "└─ " : ""}${span.name}  (${durationMs(span).toFixed(1)}ms)`,
      );
      const model = span.attributes["gen_ai.request.model"];
      const operation = span.attributes["gen_ai.operation.name"];
      lines.push(`${indent}   ${operation}${model ? ` · model=${String(model)}` : ""}`);
      for (const event of span.events) {
        lines.push(
          `${indent}   • ${event.name} ${String(event.attributes?.["agent.event_type"] ?? "")}`,
        );
      }
      walk(spanId(span), depth + 1);
    }
  };
  walk(undefined, 0);
  return lines.join("\n");
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const tracing = createTracing(env);
  console.log(`Exporting spans to: ${tracing.destination}\n`);

  let result;
  try {
    result = await runAgent(blurbMachine, {
      input: { topic: "why state machines for agents" },
      executors: scriptedExecutors(),
      onTrace: tracing.onTrace,
    });
  } finally {
    // Closes any span still open, even on a throw; then flush the exporter.
    tracing.onTrace.dispose();
    await tracing.shutdown();
  }

  console.log(
    result.status === "done" ? `Blurb: ${result.output.blurb}` : `Run settled: ${result.status}`,
  );

  if (tracing.spans.length > 0) {
    console.log(`\nSpan tree (${tracing.spans.length} spans):\n`);
    console.log(formatSpanTree(tracing.spans));
  }
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
