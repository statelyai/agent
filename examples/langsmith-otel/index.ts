/**
 * LangSmith over OpenTelemetry: shipping `runAgent`'s trace stream to any
 * OTLP backend, LangSmith here.
 *
 * The whole integration is one `onTrace` handler that maps the versioned
 * `AgentTraceEvent` stream onto OTel spans:
 *   - run.start        -> a root span for the run
 *   - request.start    -> a child span per model call
 *   - request.end      -> attributes (state, src, output sizes) + end
 *   - request.error    -> recordException + ERROR status + end
 *   - run.end          -> status + end the root span
 *
 * No prompt or response bodies are attached by default (see OPT_IN_BODIES).
 *
 * Env-gated, dual mode:
 *   - WITH `LANGSMITH_API_KEY`: builds a NodeSDK + OTLP exporter pointed at
 *     LangSmith's OTel endpoint and ships spans there.
 *   - WITHOUT it: prints each trace event to stdout instead, so the example
 *     runs clean with no keys and no network.
 *
 * Model calls are mocked, so no OPENAI_API_KEY is needed either; the point is
 * the trace wiring, not the generation.
 *
 * Run: npx tsx examples/langsmith-otel/index.ts
 * Env: LANGSMITH_API_KEY (enables real OTLP export),
 *      LANGSMITH_PROJECT (target project; default "default").
 */
import { z } from "zod";
import { runAgent, setupAgent, type AgentTraceEvent } from "@statelyai/agent";
import type { AgentRequestExecutors } from "@statelyai/agent";
// In a real project these come from @opentelemetry/{api,sdk-node,exporter-trace-otlp-http}.
import {
  context,
  NodeSDK,
  OTLPTraceExporter,
  SpanStatusCode,
  trace,
  type Span,
} from "./otel-shims.js";

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

// ─── Keyless mock executors (the demo is about tracing, not the model) ───

const mockExecutors: Partial<AgentRequestExecutors> = {
  generateText: async () => ({ output: "State machines make illegal states unreachable." }),
  decide: async () => ({ event: { type: "WRITE" } }),
};

// Attach prompt/response bodies to spans? Off by default, since bodies can be
// large and sensitive. Flip to true (or gate on an env var) to opt in.
const OPT_IN_BODIES = false;

// ─── onTrace -> OTel spans ───

/**
 * Builds an `onTrace` handler that maps the trace stream onto OTel spans, plus
 * a `shutdown` that flushes the exporter. `tracer` comes from the caller's
 * existing OTel SDK setup; this recipe never owns the SDK lifecycle beyond the
 * flush.
 */
function createTraceToOtel(tracer: ReturnType<typeof trace.getTracer>) {
  const runSpans = new Map<string, Span>();
  const requestSpans = new Map<string, Span>();

  const onTrace = (event: AgentTraceEvent) => {
    switch (event.type) {
      case "run.start": {
        const span = tracer.startSpan("agent.run", {
          attributes: {
            "agent.run_id": event.runId,
            "agent.machine_id": event.machineId,
            "agent.machine_version": event.machineVersion,
          },
        });
        runSpans.set(event.runId, span);
        break;
      }
      case "request.start": {
        const request = event.request;
        // A decision request carries `model`; text/plan carry `src`.
        const src = "src" in request ? request.src : request.model;
        const parent = runSpans.get(event.runId);
        const ctx = parent ? trace.setSpan(context.active(), parent) : context.active();
        const span = tracer.startSpan(
          `agent.request ${src}`,
          {
            attributes: {
              "agent.run_id": event.runId,
              "agent.request_src": src,
              "agent.request_id": request.id,
              "agent.request_kind": request.kind,
            },
          },
          ctx,
        );
        if (OPT_IN_BODIES && "input" in request && request.input) {
          span.setAttribute("agent.request_input", JSON.stringify(request.input));
        }
        requestSpans.set(request.id, span);
        break;
      }
      case "request.end": {
        const span = requestSpans.get(event.request.id);
        if (!span) break;
        // Sizes, not bodies: a cheap, non-sensitive signal by default.
        span.setAttribute("agent.output_length", JSON.stringify(event.output ?? "").length);
        if (OPT_IN_BODIES) {
          span.setAttribute("agent.output", JSON.stringify(event.output ?? ""));
        }
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        requestSpans.delete(event.request.id);
        break;
      }
      case "request.error": {
        const span = requestSpans.get(event.request.id);
        if (!span) break;
        span.recordException(event.error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        requestSpans.delete(event.request.id);
        break;
      }
      case "run.end": {
        const span = runSpans.get(event.runId);
        if (!span) break;
        span.setAttribute("agent.status", event.status);
        span.setStatus({
          code: event.status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
        });
        span.end();
        runSpans.delete(event.runId);
        break;
      }
      // stream.chunk / machine.transition / emit: skipped here. seq + timestamp
      // on every event make them re-orderable if you'd rather ship them as span
      // events on the run span.
    }
  };

  return { onTrace };
}

export async function main() {
  const apiKey = process.env.LANGSMITH_API_KEY;

  let sdk: NodeSDK | undefined;
  let onTrace: (event: AgentTraceEvent) => void;

  if (apiKey) {
    // Your existing OTel setup: an OTLP exporter pointed at LangSmith. The
    // exporter appends /v1/traces to the base endpoint. Headers per LangSmith's
    // OTel ingestion docs: x-api-key + Langsmith-Project.
    const exporter = new OTLPTraceExporter({
      url: "https://api.smith.langchain.com/otel/v1/traces",
      headers: {
        "x-api-key": apiKey,
        "Langsmith-Project": process.env.LANGSMITH_PROJECT ?? "default",
      },
    });
    sdk = new NodeSDK({ traceExporter: exporter });
    sdk.start();
    onTrace = createTraceToOtel(trace.getTracer("statelyai-agent")).onTrace;
  } else {
    // Keyless: just print the trace stream, no OTel and no network.
    onTrace = (event) => console.log(`[trace] ${event.type} seq=${event.seq}`);
  }

  const result = await runAgent(blurbMachine, {
    input: { topic: "why state machines for agents" },
    executors: mockExecutors,
    onTrace,
  });

  if (result.status === "done") {
    console.log(`\nBlurb: ${result.output.blurb}`);
  } else {
    console.log(`\nRun settled: ${result.status}`);
  }

  await sdk?.shutdown();
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
