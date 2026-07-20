/**
 * MINIMAL LOCAL SHIMS for Flue (@flue/runtime). This repo does not depend on
 * Flue, so these keep the example typechecking standalone. DELETE this file in
 * a real Flue app: import `defineAgent`, `defineTool`, and `local` from
 * `"@flue/runtime"`, and import the real Valibot as `import * as v from "valibot"`.
 *
 * Shape mirrors https://flueframework.com/docs/guide/tools/ and
 * https://flueframework.com/docs/api/agent-api/ as of 2026-07: a Valibot
 * `input`/`output` schema and `run({ input, signal })`, tools passed to
 * `defineAgent` as an array.
 *
 * `v` here is a tiny Valibot stand-in — just enough of `object`/`string`/
 * `number`/`nullable`/`pipe`/`description` for the example's schemas to infer.
 */

/** Opaque schema carrying its inferred output type. */
export interface Schema<T> {
  readonly __type?: T;
}
type Infer<S> = S extends Schema<infer T> ? T : never;

export const v = {
  string: (): Schema<string> => ({}),
  number: (): Schema<number> => ({}),
  boolean: (): Schema<boolean> => ({}),
  nullable: <T>(_schema: Schema<T>): Schema<T | null> => ({}),
  /** Metadata action (real Valibot returns a pipe action); typed as a no-op. */
  description: (_text: string): { readonly __action: "description" } => ({ __action: "description" }),
  /** Pipe a schema through actions; the output type is the base schema's type. */
  pipe: <T>(schema: Schema<T>, ..._actions: unknown[]): Schema<T> => schema,
  object: <Shape extends Record<string, Schema<unknown>>>(
    _shape: Shape,
  ): Schema<{ [K in keyof Shape]: Infer<Shape[K]> }> => ({}),
};

/** A Flue tool: name (model-facing) + Valibot `input`/`output` + `run`. */
export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  input: Schema<I>;
  output?: Schema<O>;
  run(args: { input: I; signal?: AbortSignal }): O | Promise<O>;
}

/** Validates a custom model-callable tool and returns a frozen definition. */
export function defineTool<I, O>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return Object.freeze(def);
}

/** Runtime config an agent initializer returns. */
export interface AgentRuntimeConfig {
  model: string;
  instructions?: string;
  tools?: ToolDefinition[];
  skills?: unknown[];
  sandbox?: unknown;
}

export interface AgentInitializerContext<Env = Record<string, unknown>> {
  env: Env;
}

export interface AgentDefinition {
  initialize: (ctx: AgentInitializerContext) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>;
}

export function defineAgent(
  initialize: (ctx: AgentInitializerContext) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>,
): AgentDefinition {
  return { initialize };
}

/** The `local()` sandbox adapter (runs tools in-process). */
export const local = (): { readonly type: "local" } => ({ type: "local" });
