/**
 * OpenTelemetry bridge — maps the versioned `AgentTraceEvent` stream onto
 * GenAI-semconv spans.
 *
 * `createOtelTraceHandler({ tracer })` returns a plain `onTrace` handler, so
 * every OTLP-ingesting backend (Braintrust, Langfuse, LangSmith, Honeycomb,
 * Datadog, Grafana Tempo) is an endpoint + headers away. The bridge is the
 * MAPPING only: it ships no exporter and owns no SDK lifecycle. You bring the
 * `Tracer` from your own OpenTelemetry setup.
 *
 * `@opentelemetry/api` (^1) is an optional peer dependency — installed only by
 * apps that import this subpath.
 */
import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import type { AgentUsageEvent } from "../effects.js";
import type { AgentTraceEvent } from "../run-agent.js";
import type { AgentStepRequest } from "../steps.js";
import type { AgentCallUsage } from "../text-logic.js";

/** Instrumentation scope name used when the handler resolves its own tracer. */
const TRACER_NAME = "@statelyai/agent";

/** Options for {@link createOtelTraceHandler}. */
export interface OtelTraceHandlerOptions {
  /** The tracer to record with. Pass this OR {@link tracerProvider}. */
  tracer?: Tracer;
  /** A provider to take a `@statelyai/agent`-scoped tracer from. */
  tracerProvider?: TracerProvider;
  /**
   * `gen_ai.provider.name` for model-call spans (`openai`, `anthropic`,
   * `aws.bedrock`, …). Semconv requires it on inference spans, but the trace
   * stream only carries a model ref, so the bridge cannot infer it — set it
   * when your run targets one provider, leave it off otherwise.
   */
  providerName?: string;
  /** `gen_ai.agent.name`, and the run span's name. Defaults to the machine's `id`. */
  agentName?: string;
  /**
   * Record prompts and outputs on spans (`gen_ai.input.messages`,
   * `gen_ai.output.messages`, `gen_ai.system_instructions`), JSON-stringified.
   * Off by default: semconv marks message content Opt-In, and bodies are large
   * and frequently sensitive. Sizes (`agent.output_length`) are always recorded.
   */
  captureContent?: boolean;
  /** Extra attributes set on every span the bridge creates. */
  attributes?: Attributes;
}

/**
 * An `onTrace` handler that writes OpenTelemetry spans, plus `dispose()` to
 * close any span still open (a run that never emitted `run.end`).
 */
export type OtelTraceHandler = ((event: AgentTraceEvent) => void) & {
  /**
   * Ends every span the handler still holds open and drops its state. Idempotent.
   * Required on the uncontrolled path, where no `run.end` ever arrives.
   */
  dispose(): void;
};

interface RunState {
  span: Span;
  /** Active context with `span` as parent, for child request spans. */
  context: Context;
}

interface RequestState {
  span: Span;
  chunks: number;
}

/** `AgentCallUsage` → `gen_ai.usage.*`. `totalTokens` has no semconv key. */
const USAGE_ATTRIBUTES = {
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  reasoningTokens: "gen_ai.usage.reasoning.output_tokens",
  cachedInputTokens: "gen_ai.usage.cache_read.input_tokens",
  totalTokens: "agent.usage.total_tokens",
} as const satisfies Record<keyof AgentCallUsage, string>;

function usageAttributes(usage: AgentCallUsage | undefined): Attributes {
  const attributes: Attributes = {};
  if (!usage) {
    return attributes;
  }
  for (const [field, key] of Object.entries(USAGE_ATTRIBUTES)) {
    const value = usage[field as keyof AgentCallUsage];
    if (typeof value === "number") {
      attributes[key] = value;
    }
  }
  return attributes;
}

/** The model ref a request targets: text carries it on `input`, a decision inline. */
function requestModel(request: AgentStepRequest): string | undefined {
  const model = request.kind === "decision" ? request.model : request.input?.model;
  return typeof model === "string" ? model : undefined;
}

/** The `src` a text invoke was declared with; a decision has none. */
function requestSrc(request: AgentStepRequest): string | undefined {
  return "src" in request && typeof request.src === "string" ? request.src : undefined;
}

/** Best-effort JSON, never throws — content capture must not break a run. */
function toJson(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : undefined;
  } catch {
    return undefined;
  }
}

function errorType(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : error.name;
  }
  return typeof error;
}

/** `recordException` wants an `Exception`; trace errors are `unknown`. */
function toException(error: unknown): Error | { name: string; message: string } {
  return error instanceof Error ? error : { name: "Error", message: String(error) };
}

/**
 * Builds an `onTrace` handler that maps the trace stream onto OpenTelemetry
 * GenAI spans: one `invoke_agent` span per run, one child span per model call,
 * transitions and emissions as span events.
 *
 * Works on both paths. On the controlled path (`runAgent`) the run span opens
 * on `run.start` and closes on `run.end`. On the uncontrolled path
 * (`provideExecutors` + `traceTransitions`) there is no run boundary, so the
 * run span opens lazily on the first event of a `runId` and stays open until
 * you call `dispose()` — always dispose when the actor stops.
 *
 * @example
 * ```ts
 * import { trace } from '@opentelemetry/api';
 * import { createOtelTraceHandler } from '@statelyai/agent/otel';
 *
 * const onTrace = createOtelTraceHandler({ tracer: trace.getTracer('my-app') });
 * try {
 *   await runAgent(machine, { input, executors, onTrace });
 * } finally {
 *   onTrace.dispose();
 * }
 * ```
 */
export function createOtelTraceHandler(options: OtelTraceHandlerOptions): OtelTraceHandler {
  const tracer = options.tracer ?? options.tracerProvider?.getTracer(TRACER_NAME);
  if (!tracer) {
    throw new TypeError(
      "createOtelTraceHandler: pass a `tracer` (or a `tracerProvider` to take one from).",
    );
  }
  const baseAttributes = options.attributes ?? {};
  const runs = new Map<string, RunState>();
  const requests = new Map<string, RequestState>();

  /**
   * The run span for an event, created on first sight. Lazy rather than
   * `run.start`-only so the uncontrolled path (no run boundary) and any
   * out-of-order delivery still produce a well-formed tree.
   */
  const runFor = (event: AgentTraceEvent): RunState => {
    const existing = runs.get(event.runId);
    if (existing) {
      return existing;
    }
    const agentName = options.agentName ?? event.machineId;
    const span = tracer.startSpan(
      agentName ? `invoke_agent ${agentName}` : "invoke_agent",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          ...baseAttributes,
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": agentName,
          "gen_ai.agent.version": event.machineVersion,
          "agent.run_id": event.runId,
          "agent.machine_id": event.machineId,
          "agent.machine_version": event.machineVersion,
          "agent.trace_schema_version": event.schemaVersion,
        },
      },
      // Root of its own trace only if nothing is active; a run inside an HTTP
      // handler nests under that request's span.
      otelContext.active(),
    );
    const state: RunState = { span, context: trace.setSpan(otelContext.active(), span) };
    runs.set(event.runId, state);
    return state;
  };

  /** Span events all carry `seq`, so a consumer can re-order them downstream. */
  const addRunEvent = (event: AgentTraceEvent, name: string, attributes: Attributes) => {
    runFor(event).span.addEvent(name, { "agent.seq": event.seq, ...attributes });
  };

  const endRequest = (id: string, finish: (span: Span) => void) => {
    const state = requests.get(id);
    if (!state) {
      return;
    }
    requests.delete(id);
    if (state.chunks > 0) {
      state.span.setAttribute("agent.stream_chunks", state.chunks);
    }
    finish(state.span);
    state.span.end();
  };

  const handler = (event: AgentTraceEvent): void => {
    switch (event.type) {
      case "run.start": {
        const { span } = runFor(event);
        if (options.captureContent && event.input !== undefined) {
          const input = toJson(event.input);
          if (input !== undefined) {
            span.setAttribute("agent.input", input);
          }
        }
        if (event.snapshot) {
          span.setAttribute("agent.resumed", true);
        }
        break;
      }

      case "request.start": {
        const request = event.request;
        // A decision retry re-uses the durable invoke id.
        // Close any span still open under it rather than leaking or colliding.
        endRequest(request.id, () => {});
        const model = requestModel(request);
        const attributes: Attributes = {
          ...baseAttributes,
          "gen_ai.operation.name": "chat",
          "agent.run_id": event.runId,
          "agent.request_id": request.id,
          "agent.request_kind": request.kind,
        };
        if (model !== undefined) {
          attributes["gen_ai.request.model"] = model;
        }
        if (options.providerName !== undefined) {
          attributes["gen_ai.provider.name"] = options.providerName;
        }
        const src = requestSrc(request);
        if (src !== undefined) {
          attributes["agent.request_src"] = src;
        }
        if (request.kind === "decision" && request.attempts.length > 0) {
          attributes["agent.request_attempt"] = request.attempts.length;
        }
        if (options.captureContent) {
          const input = request.kind === "decision" ? request : request.input;
          const system = (input as { system?: unknown }).system;
          if (typeof system === "string") {
            attributes["gen_ai.system_instructions"] = system;
          }
          const messages =
            (input as { messages?: unknown }).messages ?? (input as { prompt?: unknown }).prompt;
          const json = toJson(messages);
          if (json !== undefined) {
            attributes["gen_ai.input.messages"] = json;
          }
        }
        // A text/decision span wraps the executor's provider call, which
        // semconv names CLIENT.
        const span = tracer.startSpan(
          `chat ${model ?? request.kind}`,
          { kind: SpanKind.CLIENT, attributes },
          runFor(event).context,
        );
        requests.set(request.id, { span, chunks: 0 });
        break;
      }

      case "stream.chunk": {
        const state = requests.get(event.request.id);
        if (state) {
          state.chunks += 1;
        }
        break;
      }

      case "request.end": {
        endRequest(event.request.id, (span) => {
          span.setAttributes(usageAttributes(event.usage));
          span.setAttribute("agent.output_length", toJson(event.output ?? "")?.length ?? 0);
          if (options.captureContent) {
            const output = toJson(event.output);
            if (output !== undefined) {
              span.setAttribute("gen_ai.output.messages", output);
            }
          }
          span.setStatus({ code: SpanStatusCode.OK });
        });
        break;
      }

      case "request.error": {
        endRequest(event.request.id, (span) => {
          span.recordException(toException(event.error));
          span.setAttribute("error.type", errorType(event.error));
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: event.error instanceof Error ? event.error.message : undefined,
          });
        });
        break;
      }

      case "machine.transition": {
        const attributes: Attributes = {
          "agent.event_type": event.event.type,
          "agent.state": toJson(event.snapshot.value) ?? "",
        };
        if (event.eventId !== undefined) {
          attributes["agent.event_id"] = event.eventId;
        }
        addRunEvent(event, "agent.transition", attributes);
        break;
      }

      case "emit": {
        addRunEvent(event, "agent.emit", { "agent.event_type": event.event.type });
        break;
      }

      case "usage.dropped": {
        const dropped = event.event as AgentUsageEvent;
        addRunEvent(event, "agent.usage.dropped", {
          "agent.drop_reason": event.reason,
          ...usageAttributes(dropped.usage),
        });
        break;
      }

      case "run.end": {
        const { span } = runFor(event);
        runs.delete(event.runId);
        span.setAttribute("agent.status", event.status);
        if (event.status === "error") {
          span.recordException(toException(event.error));
          span.setAttribute("error.type", errorType(event.error));
          span.setAttribute("agent.error_cause", event.cause);
          span.setStatus({ code: SpanStatusCode.ERROR });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end();
        break;
      }
    }
  };

  handler.dispose = () => {
    for (const [id] of requests) {
      endRequest(id, (span) => span.setAttribute("agent.unfinished", true));
    }
    for (const { span } of runs.values()) {
      span.setAttribute("agent.unfinished", true);
      span.end();
    }
    runs.clear();
  };

  return handler;
}
