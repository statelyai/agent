/**
 * Harness ceremony shared by the runnable examples. Each example still writes
 * its own `runAgent(...)` call — that is the part worth reading. Only the
 * boilerplate *around* it lives here: the "am I the entry module?" guard, the
 * API-key check, and the dual-mode executor merge (injected mocks in tests vs
 * real `createAiSdkExecutors` on a direct run).
 */
import {
  createAiSdkExecutors,
  type AiSdkExecutors,
  type AiSdkModelMap,
} from "../../src/ai-sdk/index.js";

/** Options for {@link runExampleMain}. */
export interface RunExampleMainOptions {
  /**
   * Env var that must be set before running against real models. Pass `false`
   * to skip the check (examples that fall back to heuristics without a key).
   * Default `"OPENAI_API_KEY"`.
   */
  requireEnv?: string | false;
}

/**
 * Runs `fn` only when this module is the process entry point (`tsx
 * examples/x/index.ts`), after checking the required API key. A thrown error is
 * logged and the process exits non-zero.
 *
 * Pass `import.meta.url` so the guard compares against the module actually run.
 *
 * @example
 * ```ts
 * runExampleMain(import.meta.url, main);
 * ```
 */
export function runExampleMain(
  moduleUrl: string,
  fn: () => void | Promise<void>,
  options: RunExampleMainOptions = {},
): void {
  if (moduleUrl !== new URL(process.argv[1]!, "file:").href) return;
  const requireEnv = options.requireEnv ?? "OPENAI_API_KEY";
  if (requireEnv && !process.env[requireEnv]) {
    console.error(`Set ${requireEnv} to run this example.`);
    process.exit(1);
  }
  void (async () => {
    try {
      await fn();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  })();
}

/**
 * Dual-mode executor resolution for the new nested `executors` option. Tests
 * inject their own run options (`{ executors: { generateText, ... }, ... }` —
 * keyless CI); a direct run passes nothing, so real executors are built from
 * `models`. Either way the result is spread straight into `runAgent`:
 *
 * @example
 * ```ts
 * const result = await runAgent(machine, {
 *   input,
 *   ...resolveExecutors(models, options),
 * });
 * ```
 *
 * When `overrides` is non-empty it is forwarded verbatim (so an injected
 * `executors` plus any `onTransition`/`input` overrides all flow through);
 * otherwise only a freshly-built `{ executors }` is returned.
 */
export function resolveExecutors<TModels extends AiSdkModelMap, TOverrides extends object>(
  models: TModels,
  overrides?: TOverrides,
): TOverrides | { executors: AiSdkExecutors } {
  return overrides && Object.keys(overrides).length > 0
    ? overrides
    : { executors: createAiSdkExecutors({ models }) };
}
