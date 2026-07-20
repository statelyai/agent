/**
 * MINIMAL LOCAL SHIMS for Eve (Vercel's agent framework). This repo does not
 * depend on Eve, so these keep the example typechecking standalone. DELETE this
 * file in a real Eve app: `defineAgent` comes from `"eve"` and `defineTool`
 * from `"eve/tools"` — import from those instead of `../eve-shims.js`.
 *
 * Shape mirrors https://eve.dev/docs/getting-started and https://eve.dev/docs/tools
 * as of 2026-07: folder convention (agent.ts + tools/<snake_case>.ts), a
 * zod/Standard-Schema `inputSchema`, and `execute(input, ctx)`.
 */
import type { z } from "zod";

/** The `ctx` an Eve tool `execute` receives (subset the example reads). */
export interface ToolContext {
  session: { id: string };
  callId: string;
  toolName: string;
  abortSignal: AbortSignal;
  getSandbox(): unknown;
  getSkill(id: string): unknown;
}

/** `defineTool` config: description + zod `inputSchema` + `execute(input, ctx)`. */
export interface ToolConfig<In extends z.ZodType, Out> {
  description: string;
  inputSchema: In;
  outputSchema?: z.ZodType<Out>;
  /** Optional human sign-off gate (real Eve feature; unused here). */
  approval?: boolean;
  execute(input: z.infer<In>, ctx: ToolContext): Out | Promise<Out>;
}

/** Validates a tool; the file name (snake_case) becomes the model-facing name. */
export function defineTool<In extends z.ZodType, Out>(
  config: ToolConfig<In, Out>,
): ToolConfig<In, Out> {
  return config;
}

/** `agent.ts` runtime config. `instructions.md` is loaded by convention. */
export interface AgentConfig {
  model: string;
}

export function defineAgent(config: AgentConfig): AgentConfig {
  return config;
}
