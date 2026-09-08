/**
 * Registry-level guard for example idle semantics.
 *
 * Human waits are ordinary resting XState states with accepted events and
 * interaction metadata. They should use `isAgentIdle` by default. Exactly one
 * example carries an explicit predicate to demonstrate additive composition.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AnyStateMachine, AnyStateNode } from "xstate";
import { isAgentIdle, setupAgent } from "../src/index.js";
// Internal import on purpose: the public surface exposes `isAgentIdle` (the
// default predicate) but no way to ask a machine which predicate it was
// configured with, which is exactly what this test has to inspect.
import { getMachineIdlePredicate } from "../src/internal/registry.js";

const examplesDir = fileURLToPath(new URL(".", import.meta.url));

function isMachine(value: unknown): value is AnyStateMachine {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { transition?: unknown; root?: unknown; config?: unknown };
  if (typeof candidate.transition !== "function" || !candidate.root) return false;
  const config = candidate.config;
  return !!config && typeof config === "object" && ("states" in config || "initial" in config);
}

function humanWaitStates(machine: AnyStateMachine): string[] {
  const found: string[] = [];
  const walk = (node: AnyStateNode) => {
    const config = node.config as { after?: object; always?: unknown };
    const waits =
      node.type !== "final" &&
      Object.keys(node.on ?? {}).length > 0 &&
      (node.invoke ?? []).length === 0 &&
      !config?.always &&
      !(config?.after && Object.keys(config.after).length > 0);
    if (waits && (node.meta as { interaction?: unknown } | undefined)?.interaction) {
      found.push(node.id);
    }
    for (const child of Object.values(node.states ?? {})) walk(child);
  };
  walk(machine.root);
  return found;
}

function runnableExampleIds(): string[] {
  return readdirSync(examplesDir)
    .filter((id) => existsSync(path.join(examplesDir, id, "index.ts")))
    .filter((id) => {
      const metadataPath = path.join(examplesDir, id, "metadata.json");
      if (!existsSync(metadataPath)) return true;
      return JSON.parse(readFileSync(metadataPath, "utf-8")).manual !== true;
    })
    .sort();
}

describe("example suspension predicates", () => {
  it("uses structural idle by default and preserves it in custom predicates", async () => {
    const humanWaits: string[] = [];
    const customPredicates: Array<{
      key: string;
      predicate: NonNullable<ReturnType<typeof getMachineIdlePredicate>>;
    }> = [];

    for (const id of runnableExampleIds()) {
      const module = (await import(path.join(examplesDir, id, "index.ts"))) as Record<
        string,
        unknown
      >;
      for (const [exportName, value] of Object.entries(module)) {
        if (!isMachine(value) || !humanWaitStates(value).length) continue;
        const key = `${id}#${exportName}`;
        humanWaits.push(key);
        const predicate = getMachineIdlePredicate(value);
        if (predicate) customPredicates.push({ key, predicate });
      }
    }

    // The exact set, not a lower bound: adding or removing a human wait should
    // be a deliberate edit here, and a wait that silently disappears from an
    // example is a regression this test exists to catch.
    expect([...humanWaits].sort()).toEqual([
      "booking-compensation#bookingCompensationMachine",
      "chameleon#chameleonMachine",
      "chat-with-pdf#chatWithPdfMachine",
      "consensus-review#consensusReviewMachine",
      "context-compaction#contextCompactionMachine",
      "customer-support#customerSupportMachine",
      "email-drafter#emailDrafter",
      "game-agent#rpsMachine",
      "game-loop-agent#gameMachine",
      "human-in-the-loop#humanInTheLoopMachine",
      "json-agent#jsonAgentMachine",
      "just-one#justOneMachine",
      "long-running-onboarding#longRunningOnboardingMachine",
      "machine-as-tool#refundMachine",
      "retrofit#supportMachine",
      "review-tool-calls#reviewToolCallsMachine",
      "review-tool-calls#toolCallingMachine",
      "sql-agent#sqlAgentMachine",
      "swarm-handoff#swarmHandoffMachine",
      "todo-nl#todoMachine",
      "triage#triageMachine",
      "twenty-questions#twentyQuestionsMachine",
      "verification#refundMachine",
    ]);
    // "Exactly one example carries an explicit predicate", as the docstring
    // above claims — asserted as one, not as "more than zero".
    expect(customPredicates.map(({ key }) => key)).toEqual([
      "human-in-the-loop#humanInTheLoopMachine",
    ]);

    const idleFixture = setupAgent({
      context: z.object({}),
      events: { CONTINUE: z.object({}) },
      meta: z.object({
        interaction: z.object({ label: z.string() }).optional(),
      }),
    });
    const eventWait = idleFixture
      .createMachine({
        context: {},
        initial: "waiting",
        states: {
          waiting: { on: { CONTINUE: { target: "done" } } },
          done: { type: "final" },
        },
      })
      .getInitialSnapshot();
    const interactionWait = idleFixture
      .createMachine({
        context: {},
        initial: "waiting",
        states: {
          waiting: { meta: { interaction: { label: "Continue" } } },
        },
      })
      .getInitialSnapshot();

    expect(isAgentIdle(eventWait)).toBe(true);
    expect(isAgentIdle(interactionWait)).toBe(true);
    for (const { key, predicate } of customPredicates) {
      expect(predicate(eventWait), `${key} replaced event-based idle semantics`).toBe(true);
      expect(predicate(interactionWait), `${key} replaced interaction idle semantics`).toBe(true);
    }
  }, 60_000);
});
