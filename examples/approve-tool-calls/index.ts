/**
 * Approval as plain states: a person approves, denies, or approves-always each
 * of a turn's proposed tool calls before it runs.
 *
 * Nothing here is a library feature. Approval is a waiting state, three events
 * tagged `meta: { actor: "human" }`, and a rule check in context:
 *
 *   - `next` looks at the call at `cursor`, in proposal order. A standing rule
 *     that matches the call's tool and arguments runs it; otherwise the machine
 *     waits in `reviewing`.
 *   - `reviewing` is idle with a `meta.interaction`, so `runAgent` settles and
 *     the host persists the snapshot until the person answers.
 *   - `APPROVE_ALWAYS` stores `{ tool, args }` for the approved call. Rules are
 *     checked again for every later call, including later calls of the same
 *     batch, and a rule never matches different arguments.
 *   - `running` invokes `runTool`, which the host supplies per run.
 *
 * Change any of these choices in your copy: concurrent execution, wider rules
 * (a glob, a command prefix), or an edit step. `index.test.ts` proves with
 * `canReach` that no call runs without a person's approval or an exact rule.
 *
 * Run: npx tsx examples/approve-tool-calls/index.ts
 */
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import {
  getInteraction,
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type EventOf,
} from "@statelyai/agent";

const callSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
});
export type ProposedCall = z.infer<typeof callSchema>;

const ruleSchema = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) });
export type ApprovalRule = z.infer<typeof ruleSchema>;

const resultSchema = z.object({
  id: z.string(),
  status: z.enum(["executed", "denied", "failed"]),
  by: z.enum(["rule", "person"]).optional(),
  value: z.unknown().optional(),
  reason: z.string().optional(),
});
export type CallResult = z.infer<typeof resultSchema>;

/**
 * Structural equality: object key order does not count, array order does, and
 * `NaN`, `null`, and `undefined` are three different values.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

/** A rule matches a call with the same tool and the same arguments, in any key order. */
export function ruleMatches(rule: ApprovalRule, call: ProposedCall): boolean {
  return rule.tool === call.tool && sameValue(rule.args, call.args);
}

/** The host's tool runner. The default only echoes the call, so importing this file runs nothing. */
const runTool = createAsyncLogic<unknown, { call: ProposedCall }>({
  run: async ({ input }) => ({ echoed: input.call }),
});

const human = { actor: "human" } as const;

const agentSetup = setupAgent({
  context: z.object({
    calls: z.array(callSchema),
    rules: z.array(ruleSchema),
    cursor: z.number(),
    results: z.array(resultSchema),
    /** Who approved the call at `cursor`. */
    by: z.enum(["rule", "person"]),
  }),
  input: z.object({ calls: z.array(callSchema), rules: z.array(ruleSchema).optional() }),
  output: z.object({ results: z.array(resultSchema), rules: z.array(ruleSchema) }),
  meta: interactionMetaSchema,
  events: {
    APPROVE: z.object({}),
    APPROVE_ALWAYS: z.object({}),
    DENY: z.object({ reason: z.string().optional() }),
  },
  actors: { runTool },
});

export const approveToolCallsMachine = agentSetup.createMachine({
  id: "approve-tool-calls",
  version: "1",
  context: ({ input }) => ({
    calls: input.calls,
    rules: input.rules ?? [],
    cursor: 0,
    results: [],
    by: "person" as const,
  }),
  initial: "next",
  states: {
    next: {
      type: "choice",
      choice: ({ context }) => {
        const call = context.calls[context.cursor];
        if (!call) return { target: "done" };
        if (context.rules.some((rule) => ruleMatches(rule, call))) {
          return { target: "running", context: { by: "rule" as const } };
        }
        return { target: "reviewing", context: { by: "person" as const } };
      },
    },
    reviewing: {
      meta: {
        interaction: {
          label: ({ context }) => {
            const call = context.calls[context.cursor]!;
            // The result is still interpolated, so keep `{` and `}` out of it.
            const args = Object.entries(call.args).map(
              ([key, value]) => `${key}=${JSON.stringify(value)}`,
            );
            return `Run ${call.tool}(${args.join(", ")})?`;
          },
          events: {
            APPROVE: { label: "Approve", style: "primary" },
            APPROVE_ALWAYS: { label: "Always approve this call" },
            DENY: { label: "Deny", style: "danger" },
          },
          textEvent: { type: "DENY", field: "reason" },
        },
      },
      on: {
        APPROVE: { target: "running", meta: human },
        APPROVE_ALWAYS: {
          target: "running",
          meta: human,
          context: ({ context }) => {
            const { tool, args } = context.calls[context.cursor]!;
            // A copy: xstate freezes context only in development builds, and a
            // runner that mutates its input must not change what was approved.
            return { rules: [...context.rules, { tool, args: structuredClone(args) }] };
          },
        },
        DENY: {
          target: "next",
          meta: human,
          context: ({ context, event }) => ({
            cursor: context.cursor + 1,
            results: [
              ...context.results,
              {
                id: context.calls[context.cursor]!.id,
                status: "denied" as const,
                reason: event.reason,
              },
            ],
          }),
        },
      },
    },
    running: {
      invoke: {
        src: "runTool",
        input: ({ context }) => ({ call: context.calls[context.cursor]! }),
        onDone: ({ context, output }) => ({
          target: "next",
          context: {
            cursor: context.cursor + 1,
            results: [
              ...context.results,
              {
                id: context.calls[context.cursor]!.id,
                status: "executed" as const,
                by: context.by,
                value: output,
              },
            ],
          },
        }),
        onError: ({ context, event }) => ({
          target: "next",
          context: {
            cursor: context.cursor + 1,
            results: [
              ...context.results,
              {
                id: context.calls[context.cursor]!.id,
                status: "failed",
                reason: String(event.error),
              },
            ],
          },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ results: context.results, rules: context.rules }),
    },
  },
});

type Verdict = Extract<
  EventOf<typeof approveToolCallsMachine>,
  { type: "APPROVE" | "APPROVE_ALWAYS" | "DENY" }
>;

export interface RunApproveToolCallsOptions {
  calls?: ProposedCall[];
  rules?: ApprovalRule[];
  /** One verdict per call that needs a person, in order. Each resume crosses a JSON round-trip. */
  verdicts?: Verdict[];
  run?: (call: ProposedCall) => Promise<unknown>;
}

export async function runApproveToolCallsExample(options: RunApproveToolCallsOptions = {}) {
  const {
    calls = [
      { id: "c1", tool: "runCommand", args: { cmd: "npm test" } },
      { id: "c2", tool: "runCommand", args: { cmd: "npm test" } },
      { id: "c3", tool: "runCommand", args: { cmd: "rm -rf ~" } },
    ],
    rules = [],
    verdicts = [{ type: "APPROVE_ALWAYS" }, { type: "DENY", reason: "never" }],
    run,
  } = options;
  const actors = run
    ? {
        runTool: createAsyncLogic<unknown, { call: ProposedCall }>({
          run: ({ input }) => run(input.call),
        }),
      }
    : undefined;

  const asked: string[] = [];
  let result = await runAgent(approveToolCallsMachine, { input: { calls, rules }, actors });
  for (const verdict of verdicts) {
    if (result.status !== "idle") break;
    asked.push(getInteraction(result.snapshot)?.label ?? "");
    const snapshot = JSON.parse(JSON.stringify(result.persist()));
    result = await runAgent(approveToolCallsMachine, { snapshot, event: verdict, actors });
  }
  if (result.status !== "done") throw new Error(`Expected done, got ${result.status}`);
  return { asked, ...result.output };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await runApproveToolCallsExample(), null, 2));
}
