/**
 * MINIMAL LOCAL SHIMS for OpenTelemetry. This repo does not depend on
 * `@opentelemetry/*`, so these keep the example typechecking (and running
 * keylessly) standalone. DELETE this file in a real project and install the
 * real packages instead:
 *
 *   pnpm add @opentelemetry/api @opentelemetry/sdk-node \
 *            @opentelemetry/exporter-trace-otlp-http
 *
 * then swap the imports in index.ts:
 *   import { NodeSDK } from "@opentelemetry/sdk-node";
 *   import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
 *   import { trace, context, SpanStatusCode, type Span } from "@opentelemetry/api";
 *
 * The recipe in index.ts uses only the stable, long-lived OTel API surface, so
 * the code is identical against the real packages. These stand-ins run a tiny
 * in-process tracer (spans log when they end) and a no-op SDK, so the keyed
 * path runs clean too, but nothing actually ships to LangSmith until you
 * install the real exporter above.
 */

export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;
export type SpanStatusCode = (typeof SpanStatusCode)[keyof typeof SpanStatusCode];

export type SpanAttributeValue = string | number | boolean;
export interface SpanAttributes {
  [key: string]: SpanAttributeValue | undefined;
}

/** The subset of the OTel `Span` the recipe touches. */
export interface Span {
  setAttribute(key: string, value: SpanAttributeValue): void;
  recordException(error: unknown): void;
  setStatus(status: { code: SpanStatusCode; message?: string }): void;
  end(): void;
}

/** The subset of the OTel `Tracer` the recipe touches. */
export interface Tracer {
  startSpan(name: string, options?: { attributes?: SpanAttributes }, ctx?: OtelContext): Span;
}

/** Opaque context handle (in real OTel this carries the active span). */
export interface OtelContext {
  readonly span?: Span;
}

class ShimSpan implements Span {
  private readonly attributes: SpanAttributes = {};
  private status: SpanStatusCode = SpanStatusCode.UNSET;
  constructor(
    private readonly name: string,
    attributes?: SpanAttributes,
  ) {
    if (attributes) Object.assign(this.attributes, attributes);
  }
  setAttribute(key: string, value: SpanAttributeValue): void {
    this.attributes[key] = value;
  }
  recordException(error: unknown): void {
    this.attributes["exception.message"] = error instanceof Error ? error.message : String(error);
  }
  setStatus(status: { code: SpanStatusCode; message?: string }): void {
    this.status = status.code;
  }
  end(): void {
    // A real exporter ships the span here; the shim just prints it.
    console.log(`[span] ${this.name} status=${this.status}`, this.attributes);
  }
}

const shimTracer: Tracer = {
  startSpan: (name, options) => new ShimSpan(name, options?.attributes),
};

/** Stand-in for `@opentelemetry/api`'s `trace`. */
export const trace = {
  getTracer: (_name: string): Tracer => shimTracer,
  /** Returns a child context whose active span is `span`. */
  setSpan: (_ctx: OtelContext, span: Span): OtelContext => ({ span }),
};

/** Stand-in for `@opentelemetry/api`'s `context`. */
export const context = {
  active: (): OtelContext => ({}),
};

/** Stand-in for `@opentelemetry/exporter-trace-otlp-http`'s `OTLPTraceExporter`. */
export class OTLPTraceExporter {
  constructor(_config: { url: string; headers: Record<string, string> }) {}
}

/** Stand-in for `@opentelemetry/sdk-node`'s `NodeSDK`. */
export class NodeSDK {
  constructor(_config: { traceExporter: OTLPTraceExporter }) {}
  start(): void {}
  async shutdown(): Promise<void> {}
}
