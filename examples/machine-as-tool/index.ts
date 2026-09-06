/**
 * Machine-as-tool: embed a whole agent machine inside one tool call of a host
 * harness (eve / Flue / an MCP server / any tool-calling loop).
 *
 * The harness owns the conversation; the machine owns one durable process. A
 * pair of tools bridges them:
 *
 *   - `startTool(input, runOptions)` runs the machine to its first idle state
 *     and returns a JSON-safe handle plus the interaction to present.
 *   - `resumeTool(handle, event, runOptions)` revives the handle, delivers the
 *     human's event, and runs to the next idle state (or to done).
 *
 * The handle is just `result.persist()`, stringified. There is no live actor
 * and no host-side store to hold between tool calls, so the pause survives a
 * crash, a redeploy, or a days-long wait — the harness passes one blob around.
 *
 * Same bridge as ../mastra-host, minus the framework and minus the storage:
 * that example wires these two tools into a real Mastra agent and keys an
 * opaque handle into a run store; this one is the framework-free, stateless
 * version, and both use the same `persist()` / `getInteraction` /
 * `AgentIllegalResumeEventError` protocol. Read this one first.
 *
 * This file simulates the harness side with plain functions; no real harness
 * dependency. `runOptions` is a required parameter of both tools: the example
 * ships no stub executors, so every caller (test, demo, real host) states which
 * model and side effects it is running against.
 *
 * The policy check decides whether a human is needed at all: a refund at or
 * under the auto-approval limit goes straight to `executing`, and only a refund
 * over it pauses at `awaitingApproval`. That branch lives in a `choice` state
 * so `explorePaths`/`canReach` can see both arms.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/machine-as-tool/index.ts
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import {
  getInteraction,
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type AgentInteraction,
  type EventOf,
  type RunAgentOptions,
  type RunAgentResult,
  type SnapshotOf,
} from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

/** Refunds at or under this amount need no human approval. */
export const AUTO_APPROVAL_LIMIT = 500;

export const models = defineModels({
  validator: openai("gpt-5.4-mini"),
});

const agentSetup = setupAgent({
  models,
  actors: {
    // Plain side-effecting actor (a stand-in for the real refund call).
    // This implementation is used as-is by runAgent; a host can override it
    // per run via runAgent(machine, { actors: { processRefund: ... } }).
    processRefund: createAsyncLogic({ run: async () => ({ ok: true }) }),
  },
  context: z.object({
    amount: z.number(),
    orderId: z.string(),
    reason: z.string().nullable(),
    /** The policy model's verdict; `null` until `validating` returns. */
    check: z.object({ valid: z.boolean() }).nullable(),
  }),
  input: z.object({ amount: z.number(), orderId: z.string() }),
  output: z.object({ refunded: z.boolean(), reason: z.string().nullable() }),
  // The shipped interaction protocol: a `label` for the pause, an `events` map
  // giving each accepted event a button label and style, and `textEvent`
  // naming the ONE event free-typed text is delivered to. Declaring
  // `textEvent` matters here: without it, a host that auto-maps text to "the
  // only event with a single string field" would silently reject the refund
  // whenever the operator types anything.
  meta: interactionMetaSchema,
  events: {
    APPROVE: z.object({}),
    REJECT: z.object({ reason: z.string() }),
  },
  requests: {
    // Stands in for a real validation model call (fraud check, policy, …).
    validateRefund: {
      schemas: {
        input: z.object({ amount: z.number(), orderId: z.string() }),
        output: z.object({ valid: z.boolean() }),
      },
      model: "validator",
      system:
        "You are a refund policy checker. A refund is valid when it has a " +
        `plausible order id and an amount at or below the $${AUTO_APPROVAL_LIMIT} auto-approval ` +
        "limit. Return valid=false for anything above the limit or clearly malformed.",
      prompt: ({ input }) =>
        `Order ${input.orderId}, refund amount $${input.amount}. Is this refund valid?`,
    },
  },
});

// Refund flow: validating → checked (choice) → executing (auto-approved) or
// awaitingApproval (idle HITL) → executing / rejected. `awaitingApproval` has
// no invoke, so runAgent settles idle there; the harness presents its
// `meta.interaction` and resumes with the human's event.
export const refundMachine = agentSetup.createMachine({
  id: "refund",
  context: ({ input }) => ({
    amount: input.amount,
    orderId: input.orderId,
    reason: null,
    check: null,
  }),
  initial: "validating",
  states: {
    validating: {
      invoke: {
        src: "validateRefund",
        input: ({ context }) => ({ amount: context.amount, orderId: context.orderId }),
        onDone: ({ output }) => ({
          target: "checked",
          context: { check: { valid: output.valid } },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { reason: `Policy check failed: ${String(event.error)}` },
        }),
      },
    },
    // Choice state: the branch is its own routing state, not a decision hidden
    // inside `onDone`, so path exploration reaches both arms.
    checked: {
      type: "choice",
      choice: ({ context }) =>
        context.check?.valid ? { target: "executing" } : { target: "awaitingApproval" },
    },
    awaitingApproval: {
      tags: ["awaiting-approval"],
      // No invoke: runAgent settles idle here. `meta.interaction` is the
      // typed contract the harness renders as a tool result.
      meta: {
        interaction: {
          // `{amount}` / `{orderId}` resolve against the snapshot's context
          // when `getInteraction` renders the label. Nothing punctuates a
          // placeholder directly: a missing or blank value resolves to "" and
          // whitespace collapses, so "{orderId}," would render as
          // "order , or type…" whenever the order id is blank.
          label: "Approve the ${amount} refund on order {orderId} or type a reason to reject it.",
          events: {
            APPROVE: { label: "Approve refund of ${amount}", style: "primary" },
            REJECT: { label: "Reject refund", style: "danger" },
          },
          // Free text is a rejection reason, never a silent approval.
          textEvent: "REJECT",
        },
      },
      on: {
        APPROVE: { target: "executing" },
        REJECT: ({ event }) => ({
          target: "rejected",
          context: { reason: event.reason },
        }),
      },
    },
    executing: {
      invoke: {
        src: "processRefund",
        onDone: { target: "done" },
        onError: ({ event }) => ({
          target: "failed",
          context: { reason: `Refund call failed: ${String(event.error)}` },
        }),
      },
    },
    // One final state per outcome, each with its own typed output
    // (requires xstate >= 6.0.0-alpha.17).
    rejected: {
      type: "final",
      output: ({ context }) => ({ refunded: false, reason: context.reason }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({ refunded: false, reason: context.reason }),
    },
    done: {
      type: "final",
      output: () => ({ refunded: true, reason: null }),
    },
  },
});

export type RefundSnapshot = SnapshotOf<typeof refundMachine>;
export type RefundEvent = EventOf<typeof refundMachine>;
export type RefundRunOptions = RunAgentOptions<typeof refundMachine>;

// ─── Recommended recipe: read the current state's interaction ───
//
// `getInteraction(snapshot)` reads the active state's `meta.interaction`,
// interpolates `{context.path}` placeholders, collapses whitespace, and drops
// any choice XState will not currently accept. It replaces the hand-rolled
// "read meta, resolve the label, filter by accepted events" trio — copy it
// into your host.

// A JSON-safe handle: exactly what the harness persists between tool calls.
type Handle = string;

type PendingResult = {
  status: "pending";
  handle: Handle;
  interaction: AgentInteraction<RefundEvent> | undefined;
};
type DoneResult = {
  status: "done";
  output: { refunded: boolean; reason: string | null };
};
type ToolResult = PendingResult | DoneResult;

function toToolResult(result: RunAgentResult<typeof refundMachine>): ToolResult {
  if (result.status === "error") {
    throw result.error;
  }
  if (result.status === "done") {
    return { status: "done", output: result.output };
  }
  // idle → `result.persist()` is the durable projection of the run (the same
  // call ../mastra-host makes before writing to its store); JSON.stringify it
  // to prove it survives any transport (DB row, queue message, file).
  //
  // THE ONE DEVIATION from ../mastra-host's bridge: there, the handle is an
  // opaque id and the persisted snapshot goes in a host-owned store; here the
  // handle *is* the persisted snapshot, so the bridge is stateless and the host
  // needs no storage at all. Everything else — `persist()`, `getInteraction`,
  // resuming via `runAgent(machine, { snapshot, event })`, and letting
  // `AgentIllegalResumeEventError` police legality — is identical.
  const handle: Handle = JSON.stringify(result.persist());
  return {
    status: "pending",
    handle,
    interaction: getInteraction(result.snapshot),
  };
}

/** Harness tool #1: start the workflow, run to first idle, return a handle. */
export async function startTool(
  input: { amount: number; orderId: string },
  runOptions: RefundRunOptions,
): Promise<ToolResult> {
  const result = await runAgent(refundMachine, { ...runOptions, input });
  return toToolResult(result);
}

/** Harness tool #2: revive the handle, deliver the event, run to next idle/done. */
export async function resumeTool(
  handle: Handle,
  event: RefundEvent,
  runOptions: RefundRunOptions,
): Promise<ToolResult> {
  const snapshot = JSON.parse(handle);
  const result = await runAgent(refundMachine, { ...runOptions, snapshot, event });
  return toToolResult(result);
}

// Illegal events are refused up front by `runAgent` itself: `resumeTool`'s
// `runAgent(refundMachine, { snapshot, event })` throws `AgentIllegalResumeEventError`
// when the restored state can't take the event, so the harness needs no
// hand-rolled legality check before resuming.

/**
 * Demo: an over-limit refund through the harness bridge — start pauses with an
 * interaction, the harness approves, the machine finishes. Executors are the
 * caller's, so this runs keyless in tests and against a model from `main`.
 */
export async function runMachineAsToolExample(runOptions: RefundRunOptions) {
  const started = await startTool({ amount: 780, orderId: "ORD-9002" }, runOptions);
  assert.equal(started.status, "pending");
  assert.deepEqual(
    started.status === "pending" ? started.interaction?.events.map(({ type }) => type) : undefined,
    ["APPROVE", "REJECT"],
  );

  const finished =
    started.status === "pending"
      ? await resumeTool(started.handle, { type: "APPROVE" }, runOptions)
      : started;
  assert.equal(finished.status, "done");
  assert.deepEqual(finished.status === "done" ? finished.output : undefined, {
    refunded: true,
    reason: null,
  });
  return finished;
}

// Direct run: drive the harness bridge with a real validation model. Prints
// the interaction the harness would show a human, then auto-approves — exactly
// the round-trip a real tool-calling loop performs, minus the human.
export async function main() {
  const runOptions: RefundRunOptions = {
    executors: createAiSdkExecutors({ models }),
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  };

  const started = await startTool({ amount: 780, orderId: "ORD-9002" }, runOptions);
  if (started.status !== "pending") {
    console.log("Refund resolved without approval:", started);
    return;
  }

  // What a human operator would see: `getInteraction` already resolved the
  // `{amount}` / `{orderId}` placeholders against the handle's context.
  console.log(`\n${started.interaction?.label ?? ""}`);
  for (const choice of started.interaction?.events ?? []) {
    console.log(`  - ${choice.label} (${choice.type})`);
  }
  console.log("\n[harness auto-approves]\n");

  const finished = await resumeTool(started.handle, { type: "APPROVE" }, runOptions);
  console.log("Result:", finished);
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
