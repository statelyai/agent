/**
 * Machine-as-tool: embed a whole agent machine inside one tool call of a host
 * harness (eve / Flue / an MCP server / any tool-calling loop).
 *
 * The harness owns the conversation; the machine owns one durable process. A
 * pair of tools bridges them:
 *
 *   - `startTool(input)` runs the machine to its first idle state and returns a
 *     JSON-safe handle plus the interaction the harness should present.
 *   - `resumeTool(handle, event)` revives the handle, delivers the human's
 *     event, and runs to the next idle state (or to done).
 *
 * The handle is just the persisted snapshot. There is no live actor to hold
 * between tool calls, so the pause survives a crash, a redeploy, or a
 * days-long wait — the harness stores one blob and hands it back later.
 *
 * This file simulates the harness side with plain functions; no real harness
 * dependency. The refund flow has a no-invoke HITL state (`awaitingApproval`)
 * that settles idle with a typed `meta.interaction`.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/machine-as-tool/index.ts
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic, type AnyMachineSnapshot } from "xstate";
import {
  getStateMeta,
  runAgent,
  setupAgent,
  type RunAgentOptions,
  type RunAgentResult,
} from "../../src/index.js";
import { createAiSdkExecutors } from "../../src/ai-sdk/index.js";
import { runExampleMain } from "../helpers/main.js";

// Typed interaction protocol handed to the harness. Schema-typed meta means
// the host gets a real contract, not Record<string, unknown>. This is a
// subset-compatible variant of the email-drafter interaction vocabulary: a
// `select` with choices, each optionally carrying a follow-up text `input`
// (here, REJECT's `reason`). One vocabulary, modeled across both examples.
const metaSchema = z.object({
  interaction: z
    .object({
      type: z.literal("select"),
      label: z.string(),
      choices: z.array(
        z.object({
          label: z.string(),
          eventType: z.string(),
          input: z
            .object({ type: z.literal("text"), label: z.string(), field: z.string() })
            .optional(),
        }),
      ),
    })
    .optional(),
});

const agentSetup = setupAgent({
  actorSources: {
    // Plain side-effecting actor (a stand-in for the real refund call).
    // This implementation is used as-is by runAgent; a host can override it
    // per run via runAgent(machine, { actorSources: { processRefund: ... } }).
    processRefund: createAsyncLogic({ run: async () => ({ ok: true }) }),
  },
  context: z.object({
    amount: z.number(),
    orderId: z.string(),
    reason: z.string().nullable(),
    valid: z.boolean(),
  }),
  input: z.object({ amount: z.number(), orderId: z.string() }),
  output: z.object({ refunded: z.boolean(), reason: z.string().nullable() }),
  meta: metaSchema,
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
        "plausible order id and an amount at or below the $500 auto-approval " +
        "limit. Return valid=false for anything above the limit or clearly malformed.",
      prompt: ({ input }) =>
        `Order ${input.orderId}, refund amount $${input.amount}. Is this refund valid?`,
    },
  },
});

// Refund flow: validating → awaitingApproval (idle HITL) → executing → done,
// with a REJECT path. `awaitingApproval` has no invoke, so runAgent settles
// idle there; the harness presents its `meta.interaction` and resumes with the
// human's event.
export const refundMachine = agentSetup.createMachine({
  id: "refund",
  context: ({ input }) => ({
    amount: input.amount,
    orderId: input.orderId,
    reason: null,
    valid: false,
  }),
  initial: "validating",
  states: {
    validating: {
      invoke: {
        src: "validateRefund",
        input: ({ context }) => ({ amount: context.amount, orderId: context.orderId }),
        onDone: ({ output }) => ({
          target: "awaitingApproval",
          context: { valid: output.valid },
        }),
      },
    },
    awaitingApproval: {
      // No invoke: runAgent settles idle here. `meta.interaction` is the
      // typed contract the harness renders as a tool result.
      meta: {
        interaction: {
          type: "select",
          label: "Approve this refund?",
          choices: [
            { label: "Approve", eventType: "APPROVE" },
            {
              label: "Reject",
              eventType: "REJECT",
              input: { type: "text", label: "Reason", field: "reason" },
            },
          ],
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
      },
    },
    // One final state per outcome, each with its own typed output
    // (requires xstate >= 6.0.0-alpha.17).
    rejected: {
      type: "final",
      output: ({ context }) => ({ refunded: false, reason: context.reason }),
    },
    done: {
      type: "final",
      output: () => ({ refunded: true, reason: null }),
    },
  },
});

// ─── Recommended recipe: read the current state's interaction meta ───
//
// `getStateMeta(snapshot)` merges the active state(s)' schema-typed meta into
// one typed object (the typed replacement for the old
// `Object.values(snapshot.getMeta())[0]` cast). This is the recommended way to
// pull the interaction protocol out of an idle snapshot — copy it into your host.
function readInteraction(snapshot: AnyMachineSnapshot) {
  const meta = getStateMeta<AnyMachineSnapshot, z.infer<typeof metaSchema>>(snapshot);
  return meta.interaction ?? null;
}

// A JSON-safe handle: exactly what the harness persists between tool calls.
type Handle = string;

type PendingResult = {
  status: "pending";
  handle: Handle;
  interaction: ReturnType<typeof readInteraction>;
};
type DoneResult = {
  status: "done";
  output: { refunded: boolean; reason: string | null };
};
type ToolResult = PendingResult | DoneResult;

// Executors: stand-ins for real model / side-effect calls. A host swaps these
// for `createAiSdkExecutors({ models })` and a real refund side effect.
const executors: RunAgentOptions<typeof refundMachine> = {
  generateText: async () => ({ output: { valid: true } }),
};

function toToolResult(result: RunAgentResult<typeof refundMachine>): ToolResult {
  if (result.status === "error") {
    throw result.error;
  }
  if (result.status === "done") {
    return { status: "done", output: result.output };
  }
  // idle → serialize the snapshot to a JSON-safe handle. JSON round-trip it
  // here to prove it survives any store (DB row, queue message, file).
  const handle: Handle = JSON.stringify(result.snapshot);
  return {
    status: "pending",
    handle,
    interaction: readInteraction(result.snapshot as AnyMachineSnapshot),
  };
}

/** Harness tool #1: start the workflow, run to first idle, return a handle. */
export async function startTool(
  input: { amount: number; orderId: string },
  runOptions: RunAgentOptions<typeof refundMachine> = executors,
): Promise<ToolResult> {
  const result = await runAgent(refundMachine, { ...runOptions, input });
  return toToolResult(result);
}

/** Harness tool #2: revive the handle, deliver the event, run to next idle/done. */
export async function resumeTool(
  handle: Handle,
  event: { type: "APPROVE" } | { type: "REJECT"; reason: string },
  runOptions: RunAgentOptions<typeof refundMachine> = executors,
): Promise<ToolResult> {
  const snapshot = JSON.parse(handle);
  const result = await runAgent(refundMachine, { ...runOptions, snapshot, event });
  return toToolResult(result);
}

// Illegal events are refused up front by `runAgent` itself: `resumeTool`'s
// `runAgent(refundMachine, { snapshot, event })` throws `IllegalResumeEventError`
// when the restored state can't take the event, so the harness needs no
// hand-rolled legality check before resuming.

// Demo: happy path through the harness bridge.
export async function runMachineAsToolExample() {
  const started = await startTool({ amount: 42, orderId: "ord-1" });
  assert.equal(started.status, "pending");
  assert.deepEqual(
    started.status === "pending" ? started.interaction?.label : undefined,
    "Approve this refund?",
  );

  const finished =
    started.status === "pending" ? await resumeTool(started.handle, { type: "APPROVE" }) : started;
  assert.equal(finished.status, "done");
  assert.deepEqual(finished.status === "done" ? finished.output : undefined, {
    refunded: true,
    reason: null,
  });
}

// Direct run: drive the harness bridge with a real validation model. Prints
// the interaction the harness would show a human, then auto-approves — exactly
// the round-trip a real tool-calling loop performs, minus the human.
export async function main() {
  const realExecutors: RunAgentOptions<typeof refundMachine> = {
    ...createAiSdkExecutors({ models: { validator: openai("gpt-5.4-mini") } }),
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  };

  const started = await startTool({ amount: 42, orderId: "ord-1" }, realExecutors);
  if (started.status !== "pending") {
    console.log("Refund resolved without approval:", started);
    return;
  }

  // What a human operator would see rendered from the typed interaction.
  console.log(`\n${started.interaction?.label}`);
  for (const choice of started.interaction?.choices ?? []) {
    console.log(`  - ${choice.label} (${choice.eventType})`);
  }
  console.log("\n[harness auto-approves]\n");

  const finished = await resumeTool(started.handle, { type: "APPROVE" }, realExecutors);
  console.log("Result:", finished);
}

runExampleMain(import.meta.url, main);
