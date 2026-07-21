/**
 * TanStack Start server functions — the demo's HTTP boundary.
 *
 * `startScenario` runs a machine from a prompt; `resumeScenario` delivers a
 * human event to a persisted idle snapshot. Both validate input with zod and
 * delegate to the stateless runner in `agent-runner.ts`. The snapshot lives on
 * the client between calls, so the server holds no per-run state.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Snapshot } from "xstate";
import {
  resumeScenario as resumeScenarioRun,
  startScenario as startScenarioRun,
  type ResumeEvent,
} from "./agent-runner";
import type { ScenarioId } from "./scenarios";

export type { ScenarioResult, TraceEntry, IdlePayload, RunMode } from "./agent-runner";

const scenarioId = z.enum([
  "refund",
  "approval",
  "routing",
  "research",
  "pipeline",
  "retry",
  "tools",
  "reflection",
]);

const startInput = z.object({
  scenarioId,
  prompt: z.string().trim().min(1, "Enter a prompt").max(4000, "Prompt too long"),
});

const resumeInput = z.object({
  scenarioId,
  // The persisted snapshot is opaque JSON produced by persistSnapshot.
  snapshot: z.custom<Snapshot<unknown>>((value) => value != null && typeof value === "object"),
  event: z.union([
    z.object({ kind: z.literal("interpret"), text: z.string().trim().min(1).max(4000) }),
    z.object({ type: z.string().min(1) }).passthrough(),
  ]),
});

export const startScenario = createServerFn({ method: "POST" })
  .validator((input: unknown) => startInput.parse(input))
  .handler(async ({ data }) => startScenarioRun(data.scenarioId as ScenarioId, data.prompt));

export const resumeScenario = createServerFn({ method: "POST" })
  .validator((input: unknown) => resumeInput.parse(input))
  .handler(async ({ data }) =>
    resumeScenarioRun(data.scenarioId as ScenarioId, data.snapshot, data.event as ResumeEvent),
  );
