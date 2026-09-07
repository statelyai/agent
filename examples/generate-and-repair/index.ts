/**
 * Generate → validate → repair, capped.
 *
 * A model writes a small state-machine config as JSON. Nothing accepts it
 * until a host actor has parsed it: the parser extracts the fenced code block,
 * `JSON.parse`s it, and checks that every transition target names a declared
 * state. The parser is the only thing that decides whether the output is
 * usable, and it is the host's code, not the model's.
 *
 * The loop is the machine's, not the model's:
 *
 *   generating → parsing → done
 *                  ↓ (all candidates rejected)
 *          checkingRepairBudget → repairing → parsing
 *                  ↓ (budget spent)
 *                failed
 *
 * `generating` fans out explicitly: it invokes the same `generateConfig`
 * request three times, so a single bad sample does not cost a repair round.
 * The fan-out is three invokes in the machine, not a hidden option on the
 * request — the concurrency is visible in the state, and one call that fails
 * (a truncated response, say) costs one candidate, not the round. An `always`
 * transition leaves `generating` once all three slots have settled. `parsing`
 * tries the candidates that arrived, and the first one that parses wins. Only
 * when every candidate is rejected does the machine spend a repair, and
 * `checkingRepairBudget` caps how many it may spend.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/generate-and-repair/index.ts
 */
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { openai } from "@ai-sdk/openai";
import { runAgent, setupAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

/** How many repair rounds one run may spend before giving up. */
export const MAX_REPAIRS = 2;

/** How many `generateConfig` invokes `generating` fans out into per attempt. */
export const CANDIDATE_COUNT = 3;

/** The machine config the model is asked to write. */
const machineConfigSchema = z.object({
  initial: z.string(),
  states: z.record(z.string(), z.object({ on: z.record(z.string(), z.string()).optional() })),
});

export type GeneratedMachineConfig = z.infer<typeof machineConfigSchema>;

const CODE_BLOCK = /```(?:json)?\s*([\s\S]*?)```/;

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * The validation the app actually cares about: syntax first, then the semantic
 * rule that no transition may name a state that does not exist. Every failure
 * throws a message specific enough for the model to act on.
 */
export function parseGeneratedConfig(text: string): GeneratedMachineConfig {
  const block = CODE_BLOCK.exec(text)?.[1];
  // A bare object is accepted; prose with no code block is not.
  const source = (block ?? text).trim();
  if (!source.startsWith("{")) {
    throw new Error("No JSON code block found in the response.");
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `The code block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = machineConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `The config does not match the required shape — ${describeIssues(parsed.error)}`,
    );
  }

  const config = parsed.data;
  const stateNames = Object.keys(config.states);
  if (stateNames.length === 0) {
    throw new Error("The config declares no states.");
  }
  if (!stateNames.includes(config.initial)) {
    throw new Error(
      `The initial state "${config.initial}" is not one of the declared states: ${stateNames.join(", ")}.`,
    );
  }
  for (const [stateName, state] of Object.entries(config.states)) {
    for (const [eventType, target] of Object.entries(state.on ?? {})) {
      if (!stateNames.includes(target)) {
        throw new Error(
          `State "${stateName}" transitions on "${eventType}" to "${target}", which is not a declared state. ` +
            `Declared states: ${stateNames.join(", ")}.`,
        );
      }
    }
  }
  return config;
}

/**
 * The host's parser as an actor. The machine declares a placeholder under the
 * same key; the host swaps this in with `machine.provide({ actors })`, so the
 * machine artifact stays free of the app's own validation code.
 */
export const parseConfigActor = createAsyncLogic<GeneratedMachineConfig, { text: string }>({
  run: async ({ input }) => parseGeneratedConfig(input.text),
});

export const models = defineModels({
  author: openai("gpt-5.4-mini"),
  repairer: openai("gpt-5.4-mini"),
});

const SHAPE_RULES = [
  "Reply with one fenced ```json code block and nothing else.",
  'The JSON object has exactly two keys: "initial" (a state name) and "states".',
  '"states" maps each state name to an object with an optional "on" map of event type to target state name.',
  'Every target named in an "on" map must be one of the declared states.',
].join("\n");

const contextSchema = z.object({
  prompt: z.string(),
  /** The candidate currently being parsed. */
  candidate: z.string(),
  /** Candidates that arrived and have not been tried yet, in arrival order. */
  pending: z.array(z.string()),
  /** How many of the fanned-out author invokes have settled, either way. */
  settled: z.number(),
  config: machineConfigSchema.nullable(),
  /** Why the last candidate was rejected — the repair request's whole input. */
  lastError: z.string().nullable(),
  repairs: z.number(),
  maxRepairs: z.number(),
  failureReason: z.string().nullable(),
});

type GenerateAndRepairContext = z.infer<typeof contextSchema>;

/**
 * The transition arguments the fanned-out slots share. Written out because the
 * invokes are built by a `map` rather than declared inline, so there is no
 * contextual type to infer them from.
 */
type SlotArgs = { context: GenerateAndRepairContext };

/** Invoke ids for the fanned-out author calls — one per candidate slot. */
const CANDIDATE_SLOT_IDS = Array.from(
  { length: CANDIDATE_COUNT },
  (_, index) => `generateConfig${index + 1}`,
);

const outputSchema = z.object({
  summary: z.string(),
  config: machineConfigSchema.nullable(),
  repairs: z.number(),
});

/** `error.code` when the invoke failed with an `AgentError`. */
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Not exported: `setupAgent`'s return type cannot be named across module
// boundaries (an XState `unique symbol`), the same as every other example.
const generateAndRepairSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ prompt: z.string() }),
  output: outputSchema,
  emitted: {
    CANDIDATE_REJECTED: z.object({ error: z.string(), remaining: z.number() }),
    REPAIRING: z.object({ attempt: z.number(), error: z.string() }),
  },
  actors: {
    /**
     * Placeholder. The parser needs the host's own rules, so the machine
     * declares the slot and the host fills it with `parseConfigActor` through
     * `machine.provide({ actors })`.
     */
    parseConfig: createAsyncLogic<GeneratedMachineConfig, { text: string }>({
      run: async () => {
        throw new Error(
          "parseConfig is a placeholder. Supply the host implementation: " +
            "machine.provide({ actors: { parseConfig: parseConfigActor } }).",
        );
      },
    }),
  },
  requests: {
    generateConfig: {
      schemas: { input: z.object({ prompt: z.string() }), output: z.string() },
      model: "author",
      system: `You write small state-machine configs as JSON.\n${SHAPE_RULES}`,
      prompt: ({ input }) => `Write a state machine for: ${input.prompt}`,
    },
    repairConfig: {
      schemas: {
        input: z.object({ prompt: z.string(), code: z.string(), error: z.string() }),
        output: z.string(),
      },
      model: "repairer",
      system: `You fix broken state-machine configs.\n${SHAPE_RULES}`,
      prompt: ({ input }) =>
        [
          `The machine should model: ${input.prompt}`,
          "This config was rejected:",
          input.code,
          `The validator said: ${input.error}`,
          "Return the corrected config.",
        ].join("\n\n"),
    },
  },
});

const agentMachine = generateAndRepairSetup.createMachine({
  id: "generate-and-repair",
  context: ({ input }) => ({
    prompt: input.prompt,
    candidate: "",
    pending: [],
    settled: 0,
    config: null,
    lastError: null,
    repairs: 0,
    maxRepairs: MAX_REPAIRS,
    failureReason: null,
  }),
  initial: "generating",
  states: {
    generating: {
      // The fan-out, written out: three invokes of the same request, running
      // concurrently because one state invokes all three. Each appends its
      // draft to `pending` as it arrives, and none of them names a target —
      // these are targetless transitions, so `generating` is not re-entered
      // and the other two calls keep running.
      invoke: CANDIDATE_SLOT_IDS.map((id) => ({
        id,
        src: "generateConfig" as const,
        input: ({ context }: SlotArgs) => ({ prompt: context.prompt }),
        onDone: ({ context, output }: SlotArgs & { output: string }) => ({
          context: { pending: [...context.pending, output], settled: context.settled + 1 },
        }),
        // One failed call costs ONE candidate, not the round: the slot settles
        // with nothing in it and the others carry on. `AgentTruncatedError`
        // carries the code `'truncated'`, so the branch needs no `instanceof`
        // check across bundles. The reason is kept in case every slot fails.
        onError: ({ context, event }: SlotArgs & { event: { error: unknown } }) => ({
          context: {
            settled: context.settled + 1,
            failureReason:
              errorCode(event.error) === "truncated"
                ? "The model ran out of output tokens before finishing a config. Ask for a smaller machine, or raise maxOutputTokens."
                : `Generating a config failed: ${errorMessage(event.error)}`,
          },
        }),
      })),
      // Nothing leaves `generating` until every slot has settled. With at
      // least one candidate the machine parses; with none, every call failed
      // and there is nothing to repair from.
      always: ({ context }) => {
        if (context.settled < CANDIDATE_COUNT) {
          return;
        }
        const [candidate, ...rest] = context.pending;
        return candidate === undefined
          ? { target: "failed" as const }
          : {
              target: "parsing" as const,
              context: { candidate, pending: rest },
            };
      },
    },
    parsing: {
      invoke: {
        id: "parseConfig",
        src: "parseConfig",
        input: ({ context }) => ({ text: context.candidate }),
        onDone: ({ output }) => ({ target: "done", context: { config: output } }),
        // One function transition, not a guard array: it needs the error
        // message, the remaining candidates, and an emit in the same place.
        onError: ({ context, event }, enq) => {
          const error = errorMessage(event.error);
          const [next, ...rest] = context.pending;
          enq.emit({ type: "CANDIDATE_REJECTED", error, remaining: context.pending.length });
          // Another candidate is left: try it before spending a repair.
          return next === undefined
            ? { target: "checkingRepairBudget", context: { lastError: error } }
            : {
                target: "parsing",
                reenter: true,
                context: { candidate: next, pending: rest, lastError: error },
              };
        },
      },
    },
    checkingRepairBudget: {
      type: "choice",
      choice: ({ context }) =>
        context.repairs < context.maxRepairs
          ? { target: "repairing" }
          : {
              target: "failed",
              context: {
                failureReason: `No valid config after ${context.maxRepairs} repair ${
                  context.maxRepairs === 1 ? "round" : "rounds"
                }. Last validator error: ${context.lastError ?? "unknown"}`,
              },
            },
    },
    repairing: {
      invoke: {
        id: "repairConfig",
        src: "repairConfig",
        input: ({ context }) => ({
          prompt: context.prompt,
          code: context.candidate,
          error: context.lastError ?? "unknown error",
        }),
        onDone: ({ context, output }, enq) => {
          enq.emit({
            type: "REPAIRING",
            attempt: context.repairs + 1,
            error: context.lastError ?? "unknown error",
          });
          return {
            target: "parsing",
            context: { candidate: output, pending: [], repairs: context.repairs + 1 },
          };
        },
        onError: {
          target: "failed",
          context: ({ event }) => ({
            failureReason: `The repair request failed: ${errorMessage(event.error)}`,
          }),
        },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        summary: [
          `Validated a machine config for "${context.prompt}" after ${context.repairs} repair ${
            context.repairs === 1 ? "round" : "rounds"
          }.`,
          `Initial state: ${context.config?.initial ?? "unknown"}. States: ${Object.keys(
            context.config?.states ?? {},
          ).join(", ")}.`,
        ].join("\n\n"),
        config: context.config,
        repairs: context.repairs,
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        summary: `No usable config for "${context.prompt}". ${
          context.failureReason ?? "The run gave up."
        }`,
        config: null,
        repairs: context.repairs,
      }),
    },
  },
});

/**
 * The machine the app runs: the artifact above with the host's parser bound.
 * The machine never imports the parser; `provide` is the seam.
 */
export const generateAndRepairMachine = agentMachine.provide({
  actors: { parseConfig: parseConfigActor },
});

export async function runGenerateAndRepairExample(prompt: string) {
  const result = await runAgent(generateAndRepairMachine, {
    input: { prompt },
    executors: createAiSdkExecutors({ models }),
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
    on: {
      CANDIDATE_REJECTED: (e) =>
        console.log(`[rejected] ${e.error} (${e.remaining} candidates left)`),
      REPAIRING: (e) => console.log(`[repairing] attempt ${e.attempt}: ${e.error}`),
    },
  });
  if (result.status !== "done") {
    throw new Error(`Generate-and-repair example did not complete: ${result.status}`);
  }
  return result.output;
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    console.log(await runGenerateAndRepairExample("a turnstile that locks and unlocks"));
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
