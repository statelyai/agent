import { z } from "zod";
import type { AgentMessage } from "../types.js";

/**
 * A zod schema for an `AgentMessage[]` context/input field — the typed,
 * dependency-light replacement for the hand-rolled
 * `z.custom<AgentMessage[]>((value) => Array.isArray(value))` recipe repeated
 * across machines that carry a message transcript in context.
 *
 * `AgentMessage` is a structural union (see `src/types.ts`), not something to
 * re-declare as a zod object, so this stays a `z.custom` under the hood while
 * exposing the precise `z.ZodType<AgentMessage[]>` type. Validation checks that
 * the value is an array; element shape is trusted (the library's own message
 * builders and adapters produce well-formed `AgentMessage`s).
 *
 * `zod` is an optional peer of `@statelyai/agent` — this subpath is the only
 * place it's imported, mirroring how `./ai-sdk` gates on `ai`.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { zodAgentMessages } from '@statelyai/agent/zod';
 *
 * const context = z.object({ messages: zodAgentMessages() });
 * ```
 */
export function zodAgentMessages(): z.ZodType<AgentMessage[]> {
  return z.custom<AgentMessage[]>((value) => Array.isArray(value));
}
