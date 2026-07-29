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
