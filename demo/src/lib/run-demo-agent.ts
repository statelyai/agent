/**
 * TanStack Start server functions — the demo's HTTP boundary.
 *
 * `startScenario` runs a machine from a prompt; `resumeScenario` delivers a
 * human event to a persisted idle snapshot. Both validate input with zod,
 * delegate to the stateless runner in `agent-runner.ts`, and stream the run
 * back (see `run-stream.ts`). The snapshot lives on the client between calls,
 * so the server holds no per-run state.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Snapshot } from "xstate";
import type { ResumeEvent, ScenarioResult } from "./agent-runner";
import { nextDeclaration } from "./declaration-ticket";
import { streamRun, type RunStreamEvent } from "./run-stream";
import type { ScenarioId } from "./scenarios";

export type { ScenarioResult, TraceEntry, IdlePayload } from "./agent-runner";

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

/** The browser session's inspection room, from `getInspection`; absent without live inspection. */
const room = z
  .string()
  .regex(/^[0-9a-f-]{36}$/)
  .optional();

const startInput = z.object({
  scenarioId,
  room,
  prompt: z.string().trim().min(1, "Enter a prompt").max(4000, "Prompt too long"),
});

const resumeInput = z.object({
  scenarioId,
  room,
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
  .validator((input: unknown) => z.object({ scenarioId, room: room.unwrap() }).parse(input))
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
        data.room,
        inspection.rootMachinePayload(machineFor(id), scenarioSource[id]),
        declaration,
      ),
    };
  });

/** Whether the server has both model keys, and which are missing; without them the shell runs nothing. */
export const getApiKeyStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { hasApiKey, missingApiKeys } = await import("./machine-chat.server");
  return { hasApiKey: hasApiKey(), missing: missingApiKeys() };
});

/** A scenario run's streamed chunks and steps, then its result. */
export type ScenarioStream = ReadableStream<RunStreamEvent<ScenarioResult>>;

/** The runner, the budget, and the request's signal — what every scenario run needs. */
async function runContext() {
  const [runner, { runSignal }, { getRequest }] = await Promise.all([
    import("./agent-runner"),
    import("./machine-chat.server"),
    import("@tanstack/react-start/server"),
  ]);
  return { runner, runSignal, requestSignal: getRequest().signal };
}

export const startScenario = createServerFn({ method: "POST" })
  .validator((input: unknown) => startInput.parse(input))
  .handler(async ({ data }): Promise<ScenarioStream> => {
    const { runner, runSignal, requestSignal } = await runContext();
    // The stream's signal is the request's OR a cancelled read; the budget
    // rides on top of it.
    return streamRun(
      ({ signal, onChunk, onStep }) =>
        runner.startScenario(data.scenarioId as ScenarioId, data.prompt, runSignal({ signal }), {
          onChunk,
          onStep,
          inspectionRoom: data.room,
        }),
      requestSignal,
    );
  });

export const resumeScenario = createServerFn({ method: "POST" })
  .validator((input: unknown) => resumeInput.parse(input))
  .handler(async ({ data }): Promise<ScenarioStream> => {
    const { runner, runSignal, requestSignal } = await runContext();
    return streamRun(
      ({ signal, onChunk, onStep }) =>
        runner.resumeScenario(
          data.scenarioId as ScenarioId,
          data.snapshot,
          data.event as ResumeEvent,
          runSignal({ signal }),
          undefined,
          { onChunk, onStep, inspectionRoom: data.room },
        ),
      requestSignal,
    );
  });
