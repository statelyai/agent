/**
 * Server functions for the auto-discovered examples library. The registry
 * itself (Vite globs over `examples/*`, server-side dynamic imports) lives in
 * `example-library.server.ts` and is only imported inside handlers so example
 * modules never reach the client bundle.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Snapshot } from "xstate";

import type { ExampleDetail } from "./example-library.server";
import type { MachineChatResult } from "./machine-chat.server";

export type { ExampleDetail, ExampleMachine, ExampleSummary } from "./example-library.server";
export type { MachineChatResult } from "./machine-chat.server";

export const listExamples = createServerFn({ method: "GET" }).handler(async () => {
  const { listExampleSummaries } = await import("./example-library.server");
  return listExampleSummaries();
});

export type InspectionInfo = { relayUrl: string; roomId: string };

/** Returns hosted inspection info, starting a local relay only when opted in. */
export const getInspection = createServerFn({ method: "GET" }).handler(
  async (): Promise<InspectionInfo> => {
    const { ensureInspectionRelay, inspectionRelayUrl, inspectionRoomId } =
      await import("./inspection.server");
    await ensureInspectionRelay();
    return { relayUrl: inspectionRelayUrl(), roomId: inspectionRoomId() };
  },
);

const detailInput = z.object({ id: z.string().regex(/^[a-z0-9-]+$/) });

const declareInput = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  exportName: z.string().regex(/^\w+$/),
});

/**
 * Publishes the selected example's machine to the inspection room before any
 * run exists, so the visualizer draws its statechart instead of waiting.
 *
 * The payload is the one the root actor will register with once a run starts,
 * so the graph on screen does not change when the first turn begins.
 */
export const declareExampleMachine = createServerFn({ method: "POST" })
  .validator((input: unknown) => declareInput.parse(input))
  .handler(async ({ data }): Promise<{ declared: boolean }> => {
    const [
      { getExampleMachine, getExampleMachineSource },
      { declareInspectionMachine, ensureInspectionRelay, nextDeclaration, rootMachinePayload },
    ] = await Promise.all([import("./example-library.server"), import("./inspection.server")]);
    // Claimed before the machine loads: two quick selections must land in the
    // order they were asked for, not the order their modules finished.
    const declaration = nextDeclaration();
    await ensureInspectionRelay();
    const [machine, source] = await Promise.all([
      getExampleMachine(data.id, data.exportName),
      getExampleMachineSource(data.id, data.exportName),
    ]);
    return {
      declared: declareInspectionMachine(rootMachinePayload(machine, source), declaration),
    };
  });

/**
 * Runs an example whose story spans several runs. The demo cannot drive these
 * as a machine — the interesting part happens between runs — so the example
 * exports one function and this calls it, threading the same observers a
 * single-machine run gets.
 */
export const runExample = createServerFn({ method: "POST" })
  .validator((input: unknown) => declareInput.parse(input))
  .handler(async ({ data }): Promise<MachineChatResult> => {
    const [{ getExampleRunner, exampleBudgetMs }, { runExampleRunner }, { getRequest }] =
      await Promise.all([
        import("./example-library.server"),
        import("./machine-chat.server"),
        import("@tanstack/react-start/server"),
      ]);
    const runner = await getExampleRunner(data.id, data.exportName);
    return runExampleRunner(runner, {
      signal: getRequest().signal,
      budgetMs: exampleBudgetMs(data.id),
    });
  });

export const getExample = createServerFn({ method: "GET" })
  .validator((input: unknown) => detailInput.parse(input))
  .handler(async ({ data }): Promise<ExampleDetail> => {
    const { getExampleDetail } = await import("./example-library.server");
    return getExampleDetail(data.id);
  });

const machineRef = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  exportName: z.string().regex(/^\w+$/),
});

const startExampleInput = machineRef.extend({
  // The machine's `input`, built by the client from chat text or the input form.
  input: z.record(z.string(), z.unknown()),
});

const resumeExampleInput = machineRef.extend({
  snapshot: z.custom<Snapshot<unknown>>((value) => value != null && typeof value === "object"),
  event: z.object({ type: z.string().min(1) }).passthrough(),
});

export const startExample = createServerFn({ method: "POST" })
  .validator((input: unknown) => startExampleInput.parse(input))
  .handler(async ({ data }): Promise<MachineChatResult> => {
    const [
      { getExampleMachine, getExampleMachineSource, exampleBudgetMs },
      { startMachineChat },
      { getRequest },
    ] = await Promise.all([
      import("./example-library.server"),
      import("./machine-chat.server"),
      import("@tanstack/react-start/server"),
    ]);
    const [machine, machineSource] = await Promise.all([
      getExampleMachine(data.id, data.exportName),
      getExampleMachineSource(data.id, data.exportName),
    ]);
    return startMachineChat(machine, data.input, {
      signal: getRequest().signal,
      budgetMs: exampleBudgetMs(data.id),
      machineSource,
    });
  });

export const resumeExample = createServerFn({ method: "POST" })
  .validator((input: unknown) => resumeExampleInput.parse(input))
  .handler(async ({ data }): Promise<MachineChatResult> => {
    const [
      { getExampleMachine, getExampleMachineSource, exampleBudgetMs },
      { resumeMachineChat },
      { getRequest },
    ] = await Promise.all([
      import("./example-library.server"),
      import("./machine-chat.server"),
      import("@tanstack/react-start/server"),
    ]);
    const [machine, machineSource] = await Promise.all([
      getExampleMachine(data.id, data.exportName),
      getExampleMachineSource(data.id, data.exportName),
    ]);
    return resumeMachineChat(
      machine,
      data.snapshot,
      data.event as { type: string } & Record<string, unknown>,
      {
        signal: getRequest().signal,
        budgetMs: exampleBudgetMs(data.id),
          machineSource,
      },
    );
  });
