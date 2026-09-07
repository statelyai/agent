/**
 * Base class for every error this package throws. Carries a stable, kebab-case
 * `code` so hosts can branch on the failure without `instanceof` (useful across
 * bundle/realm boundaries and after serialization).
 *
 * @example
 * ```ts
 * catch (error) {
 *   if (error instanceof AgentError && error.code === 'agent-idle') { ... }
 * }
 * ```
 */
export class AgentError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentError";
    this.code = code;
  }
}

/**
 * A model call ran out of output tokens before it produced anything usable.
 * Core never throws this: it is the adapter's signal that a `'length'` finish
 * reason left nothing to return — a structured request whose envelope never
 * closed, say. A text request that WAS cut off still returns its text, with
 * `finishReason: 'length'`.
 *
 * The code is `'truncated'`, so an invoke's `onError` can branch on it without
 * `instanceof`:
 *
 * @example
 * ```ts
 * onError: [
 *   { guard: ({ event }) => event.error.code === 'truncated', target: 'retryShorter' },
 *   { target: 'failed' },
 * ]
 * ```
 */
export class AgentTruncatedError extends AgentError {
  /** The request that was cut off — `AgentTextRequest.name`. */
  readonly requestName: string;
  /** The durable invoke id of the request, when the host knows it. */
  readonly requestId?: string;
  /** Whatever the model did produce before it hit the limit, if anything. */
  readonly partialOutput?: unknown;

  constructor(
    message: string,
    options: {
      requestName: string;
      requestId?: string;
      partialOutput?: unknown;
      cause?: unknown;
    },
  ) {
    super("truncated", message, { cause: options.cause });
    this.name = "AgentTruncatedError";
    this.requestName = options.requestName;
    if (options.requestId !== undefined) {
      this.requestId = options.requestId;
    }
    if (options.partialOutput !== undefined) {
      this.partialOutput = options.partialOutput;
    }
  }
}
