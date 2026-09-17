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
import { nextDeclaration } from "./declaration-ticket";
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
  "email-drafter-v1",
  "email-drafter-v2",
]);

const startInput = z.object({
  scenarioId,
  prompt: z.string().trim().min(1, "Enter a prompt").max(4000, "Prompt too long"),
});

const resumeInput = z.object({
  scenarioId,
  // The persisted snapshot is the opaque JSON an idle settle hands back.
  snapshot: z.custom<Snapshot<unknown>>((value) => value != null && typeof value === "object"),
  event: z.union([
    z.object({ kind: z.literal("interpret"), text: z.string().trim().min(1).max(4000) }),
    z.object({ type: z.string().min(1) }).passthrough(),
  ]),
});

/**
 * Publishes the selected scenario's machine to the inspection room before any
 * run exists, so the visualizer draws its statechart instead of waiting. The
 * payload matches what the root actor registers with once a run starts.
 */
export const declareScenarioMachine = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ scenarioId }).parse(input))
  .handler(async ({ data }): Promise<{ declared: boolean }> => {
    // Claimed before the first await, so a slower earlier selection cannot
    // land on top of a newer one.
    const declaration = nextDeclaration();
    const [{ machineFor }, { scenarioSource }, inspection] = await Promise.all([
      import("./agent-runner"),
      import("./scenarios"),
      import("./inspection.server"),
    ]);
    await inspection.ensureInspectionRelay();
    const id = data.scenarioId as ScenarioId;
    return {
      declared: inspection.declareInspectionMachine(
        inspection.rootMachinePayload(machineFor(id), scenarioSource[id]),
        declaration,
      ),
    };
  });

/** Request abort (Cancel / closed tab) OR the default time budget. */
async function requestRunSignal(): Promise<AbortSignal> {
  const [{ getRequest }, { runSignal }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("./machine-chat.server"),
  ]);
  return runSignal({ signal: getRequest().signal });
}

export const startScenario = createServerFn({ method: "POST" })
  .validator((input: unknown) => startInput.parse(input))
  .handler(async ({ data }) =>
    startScenarioRun(data.scenarioId as ScenarioId, data.prompt, await requestRunSignal()),
  );

export const resumeScenario = createServerFn({ method: "POST" })
  .validator((input: unknown) => resumeInput.parse(input))
  .handler(async ({ data }) =>
    resumeScenarioRun(
      data.scenarioId as ScenarioId,
      data.snapshot,
      data.event as ResumeEvent,
      await requestRunSignal(),
    ),
  );
