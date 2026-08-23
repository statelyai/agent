/**
 * Verification — proving that invalid agent actions are impossible.
 *
 * A refund-approval agent with one business rule: a refund over $100 can never
 * be issued without passing through an explicit human `approving` gate. Prompts
 * cannot promise that; a guard can, and the verification suite proves it
 * without a single model call.
 *
 * Demonstrates the whole keyless suite over one small machine:
 *   - `lintAgentMachine` — static structural checks (dead states, decisions
 *     whose chosen event can never be delivered, output-contract gaps).
 *   - `canReach` — the reachability argument, both directions: `issued` IS
 *     reachable (with a witness path), and the violation sentinel
 *     `illegallyIssued` is NOT, for any amount. The same violation is also
 *     checked as a snapshot predicate — no sentinel state required.
 *   - `explorePaths` — every decision and human branch enumerated to a bounded
 *     depth, with guard-rejected candidates counted rather than walked.
 *   - `simulateAgent` — scripted playthroughs with live-run parity: an
 *     adversarial "model" that insists on issuing a $500 refund outright has
 *     its guard-rejected decision retried and exhausted, landing in `refused`
 *     through the invoke's `onError` — exactly as a live run would. A second
 *     script escalates and then crosses the human gate with an external
 *     APPROVE event from the script's `events` queue.
 *   - `matchesTrajectory` — the simulated state path scored against an expected
 *     one, hit and miss.
 *
 * The violation is encoded as a state, not a runtime assertion: `issuing` has
 * an `always` monitor that targets `illegallyIssued` whenever it is entered
 * over the threshold without approval. `canReach` proving that state
 * unreachable IS the safety proof. (Static lint cannot make this call — the
 * monitor is a dynamic transition, so lint conservatively treats the sentinel
 * as reachable. Semantic exploration is what settles it.)
 *
 * No API key needed: nothing here calls a model. Run:
 * npx tsx examples/verification/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import {
  canReach,
  createAgentSchemas,
  explorePaths,
  lintAgentMachine,
  matchesTrajectory,
  setupAgent,
  simulateAgent,
  type AgentPathReport,
  type SimulateAgentResult,
} from "@statelyai/agent";
import { defineModels } from "@statelyai/agent/ai-sdk";

// Declared so the machine is playable against a real model; the report below
// never calls it.
const models = defineModels({
  reviewer: openai("gpt-5.4-mini"),
});

/** The business rule, in one number. Refunds above this need a human. */
export const APPROVAL_THRESHOLD = 100;

export const verificationSchemas = createAgentSchemas({
  context: z.object({
    amount: z.number(),
    reason: z.string(),
    // Set only by the human gate's APPROVE. Nothing else can write it.
    approved: z.boolean(),
  }),
  input: z.object({
    amount: z.number(),
    reason: z.string().default("Duplicate charge"),
  }),
  output: z.object({
    outcome: z.enum(["issued", "refused", "rejected", "illegal"]),
    amount: z.number(),
    approved: z.boolean(),
    summary: z.string(),
  }),
  meta: z.object({
    interaction: z
      .object({
        label: z.string(),
        events: z
          .record(
            z.string(),
            z.object({
              label: z.string().optional(),
              style: z.enum(["primary", "danger", "default"]).optional(),
            }),
          )
          .optional(),
        textEvent: z.string().optional(),
      })
      .optional(),
  }),
  events: {
    ISSUE: z.object({ reasoning: z.string() }),
    ESCALATE: z.object({ reasoning: z.string() }),
    REFUSE: z.object({ reasoning: z.string() }),
    APPROVE: z.object({ approver: z.string().default("ops") }),
    REJECT: z.object({ reason: z.string().default("Not eligible") }),
  },
});

const agentSetup = setupAgent({
  schemas: verificationSchemas,
  models,
  // The gate is an idle state: runAgent settles `idle` there and waits for a
  // human event rather than hanging.
  isIdle: (snapshot) => snapshot.hasTag("awaiting-approval"),
});

const CLASSIFY_SYSTEM_PROMPT =
  "You triage refund requests. Choose exactly one event: ISSUE to pay it out, " +
  "ESCALATE to send it to a human approver, or REFUSE to decline it.";

export const refundMachine = agentSetup.createMachine({
  id: "refund-approval",
  context: ({ input }) => ({
    amount: input.amount,
    reason: input.reason,
    approved: false,
  }),
  initial: "classifying",
  states: {
    classifying: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "reviewer",
          system: CLASSIFY_SYSTEM_PROMPT,
          prompt:
            `Refund request: ${context.reason}\nAmount: $${context.amount}\n` +
            `Refunds over $${APPROVAL_THRESHOLD} require human approval.`,
          allowedEvents: ["ISSUE", "ESCALATE", "REFUSE"],
          maxRetries: 3,
        }),
        onError: { target: "refused" },
      },
      on: {
        // The rule, as a v6 function transition: over the threshold without an
        // approval on record, ISSUE returns `undefined` and is not a legal
        // transition at all. `resolveDecision` rejects the choice
        // (`failure: 'rejected-by-guard'`) and asks again; `explorePaths`
        // counts it in `prunedByGuard` instead of walking it.
        ISSUE: ({ context }) =>
          context.amount > APPROVAL_THRESHOLD && !context.approved
            ? undefined
            : { target: "issuing" },
        ESCALATE: { target: "approving" },
        REFUSE: { target: "refused" },
      },
    },
    // Idle human gate. No invoke, so the run settles here; `meta.interaction`
    // tells a host what to render.
    approving: {
      tags: ["awaiting-approval"],
      meta: {
        interaction: {
          label: "This refund is over the auto-issue limit. Approve or reject it.",
          events: {
            APPROVE: { label: "Approve refund", style: "primary" },
            REJECT: { label: "Reject refund", style: "danger" },
          },
          textEvent: "REJECT",
        },
      },
      on: {
        // The only writer of `approved`.
        APPROVE: () => ({ target: "issuing", context: { approved: true } }),
        REJECT: { target: "rejected" },
      },
    },
    // The monitor. Every route into payout passes through here, so the
    // invariant is checked in one place: entering over the threshold without
    // approval means the guard leaked, and the run lands in a state that exists
    // only to be proven unreachable.
    issuing: {
      always: ({ context }: { context: { amount: number; approved: boolean } }) =>
        context.amount > APPROVAL_THRESHOLD && !context.approved
          ? { target: "illegallyIssued" }
          : { target: "issued" },
    },
    issued: {
      type: "final",
      output: ({ context }) => ({
        outcome: "issued" as const,
        amount: context.amount,
        approved: context.approved,
        summary: context.approved
          ? `Issued $${context.amount} after human approval.`
          : `Issued $${context.amount} automatically (at or under the $${APPROVAL_THRESHOLD} limit).`,
      }),
    },
    refused: {
      type: "final",
      output: ({ context }) => ({
        outcome: "refused" as const,
        amount: context.amount,
        approved: context.approved,
        summary: `Declined the $${context.amount} refund.`,
      }),
    },
    rejected: {
      type: "final",
      output: ({ context }) => ({
        outcome: "rejected" as const,
        amount: context.amount,
        approved: context.approved,
        summary: `A human rejected the $${context.amount} refund.`,
      }),
    },
    // Unreachable by construction; `canReach` is what turns "by construction"
    // into a checked claim.
    illegallyIssued: {
      type: "final",
      output: ({ context }) => ({
        outcome: "illegal" as const,
        amount: context.amount,
        approved: context.approved,
        summary: `INVARIANT VIOLATED: issued $${context.amount} without approval.`,
      }),
    },
  },
});

// ─── The verification report ───

const LARGE = { amount: 500, reason: "Duplicate annual charge" };
const SMALL = { amount: 40, reason: "Late delivery credit" };

const check = (ok: boolean) => (ok ? "✓" : "✗");

function section(title: string): void {
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
}

/** `[ISSUE → ESCALATE]`, or `(none)` for an empty witness. */
function formatPath(events: readonly { type: string }[]): string {
  return events.length === 0 ? "(none)" : `[${events.map((event) => event.type).join(" → ")}]`;
}

/** `done issued ×2` per distinct terminal, sorted for a stable report. */
function summarizeTerminals(report: AgentPathReport): string[] {
  const counts = new Map<string, number>();
  for (const terminal of report.terminals) {
    const key = `${terminal.status} ${JSON.stringify(terminal.state)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort().map(([key, count]) => `${key} ×${count}`);
}

/** One labelled playthrough: status, resting state, then event → state per step. */
function printTrail(label: string, result: SimulateAgentResult): void {
  console.log(`${label}: ${result.status} at ${JSON.stringify(result.snapshot.value)}`);
  for (const entry of result.trail) {
    const applied = entry.appliedEvent
      ? `${entry.appliedEvent.type}${entry.external ? " (external)" : ""} → `
      : "";
    const rejected = entry.rejectedEvents?.length
      ? ` [rejected: ${entry.rejectedEvents.map((event) => event.type).join(", ")}]`
      : "";
    console.log(`  ${applied}${JSON.stringify(entry.state)}${rejected}`);
  }
}

export async function main() {
  console.log(`Verification report — ${refundMachine.id}`);
  console.log(`Rule: a refund over $${APPROVAL_THRESHOLD} may not be issued without approval.`);

  // 1. Lint — static structure, no execution.
  section("1. Lint");
  const diagnostics = lintAgentMachine(refundMachine);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  console.log(
    `${check(errors.length === 0)} ${diagnostics.length} diagnostic(s), ${errors.length} error(s)`,
  );
  for (const diagnostic of diagnostics) {
    console.log(`  ${diagnostic.severity}  ${diagnostic.code}  ${diagnostic.path}`);
  }
  // A finding reads like:
  //   error  decide-without-events  classifying
  //   State 'classifying' invokes decision source 'agent.decide', but neither
  //   it nor any ancestor handles any event (no 'on:') ...
  console.log("  (lint is structural: it cannot decide the $100 rule — that is step 2)");

  // 2. Reachability — the safety argument, both directions.
  section("2. Reachability");
  const goodPath = await canReach(refundMachine, "issued", { input: LARGE });
  console.log(
    `${check(goodPath.reachable)} 'issued' IS reachable at $${LARGE.amount}: ${formatPath(goodPath.witness ?? [])}`,
  );

  // The violation is a state (`issuing`'s always-monitor targets it), so
  // "cannot happen" is a reachability query rather than a runtime assertion.
  for (const input of [LARGE, SMALL]) {
    const violation = await canReach(refundMachine, "illegallyIssued", { input });
    console.log(
      `${check(!violation.reachable)} 'illegallyIssued' is UNREACHABLE at $${input.amount}` +
        (violation.reachable ? ` — witness ${formatPath(violation.witness ?? [])}` : ""),
    );
  }

  // The sentinel state is optional: the same violation stated as a snapshot
  // predicate — "issued, over the threshold, without approval" — needs no
  // extra state in the machine at all.
  const predicateViolation = await canReach(
    refundMachine,
    (snapshot) =>
      snapshot.matches("issued") &&
      (snapshot.context as { amount: number; approved: boolean }).amount > APPROVAL_THRESHOLD &&
      !(snapshot.context as { amount: number; approved: boolean }).approved,
    { input: LARGE },
  );
  console.log(
    `${check(!predicateViolation.reachable)} the same violation, as a snapshot predicate: UNREACHABLE`,
  );

  // 3. Path enumeration — every branch, terminal by terminal.
  section("3. Paths");
  for (const input of [LARGE, SMALL]) {
    const report = await explorePaths(refundMachine, { input });
    console.log(
      `$${input.amount}: ${report.pathsExplored} path(s), ${report.prunedByGuard} pruned by guard`,
    );
    for (const line of summarizeTerminals(report)) {
      console.log(`  ${line}`);
    }
    if (report.prunedByGuard > 0) {
      console.log("  (the pruned branch is ISSUE — the guard, counted not walked)");
    }
  }

  // 4. Scripted simulations — the same ISSUE choice, above and below the line.
  section("4. Simulation");
  // Adversarial: a "model" that goes straight for a $500 payout. The guard
  // makes ISSUE an illegal transition, so simulateAgent retries the decision
  // exactly as a live run re-asks the model; a queue that only ever says ISSUE
  // exhausts the attempt budget, and the exhaustion error routes through the
  // invoke's `onError` to `refused` — which is the point: it never touches
  // `issuing`.
  const adversarial = await simulateAgent(refundMachine, {
    input: LARGE,
    script: { decisions: { "agent.decide": [{ type: "ISSUE", reasoning: "just pay it" }] } },
  });
  printTrail(`adversarial ($${LARGE.amount})`, adversarial);
  const blocked = adversarial.status === "done" && adversarial.snapshot.matches("refused");
  console.log(`${check(blocked)} ISSUE was rejected until exhaustion: refused, no payout`);

  // Legal: the identical script under the threshold runs clean to `issued`.
  const legal = await simulateAgent(refundMachine, {
    input: SMALL,
    script: { decisions: { "agent.decide": [{ type: "ISSUE", reasoning: "small, auto-issue" }] } },
  });
  printTrail(`legal ($${SMALL.amount})`, legal);
  console.log(
    `${check(legal.status === "done" && legal.snapshot.matches("issued"))} the same choice is allowed below the limit`,
  );

  // The legitimate large-refund route: ESCALATE, then the human gate crossed
  // by an external APPROVE from the script's `events` queue — a simulation of
  // what a live host does with `actor.send(...)`.
  const escalated = await simulateAgent(refundMachine, {
    input: LARGE,
    script: {
      decisions: { "agent.decide": [{ type: "ESCALATE", reasoning: "over the limit" }] },
      events: [{ type: "APPROVE", approver: "ops" }],
    },
  });
  printTrail(`escalated ($${LARGE.amount})`, escalated);
  console.log(
    `${check(escalated.status === "done" && escalated.snapshot.matches("issued"))} the human gate, crossed in simulation`,
  );

  // 5. Trajectory matching — score the runs' state paths. The trail begins
  // with the initial state, so it is a complete state path as-is.
  section("5. Trajectory");
  const legalPath = legal.trail.map((entry) => entry.state);
  const hit = matchesTrajectory(legalPath, ["classifying", "issued"]);
  console.log(
    `${check(hit.matched)} legal run matches ['classifying', 'issued'] (score ${hit.score})`,
  );
  const adversarialPath = adversarial.trail.map((entry) => entry.state);
  const miss = matchesTrajectory(adversarialPath, ["classifying", "issued"]);
  console.log(
    `${check(!miss.matched)} adversarial run does NOT match ['classifying', 'issued'] — ` +
      `first miss at index ${miss.firstMiss?.index} (score ${miss.score.toFixed(2)})`,
  );

  console.log("\nInvalid actions are not discouraged here; they are unreachable.");
}

// Run directly (`tsx index.ts`); skipped when a test imports this module. No
// API-key check: the whole report is keyless and offline.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
