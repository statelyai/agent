/**
 * The portable XState loop, with no Stately Agent runner.
 *
 * `portableLoopMachine` is the artifact. The host binds its model executor,
 * then runs XState's canonical transition/effect loop. A durable framework can
 * replace the in-memory adapter below with its own XState durable adapter
 * without changing the machine.
 *
 * Two things make this a durability demo rather than a plain loop:
 *
 *   - The loop stops on `isAgentIdle(snapshot)` — the library's definition of
 *     "resting on an external event, not on work in flight" — instead of
 *     naming the `reviewing` state. Add another wait state to the machine and
 *     the host needs no change.
 *   - The pause is then PERSISTED (`getPersistedSnapshot` → JSON → back) and
 *     the run is re-entered in a SECOND durable execution, which is what proves
 *     the wait survives a process boundary. Nothing but the snapshot crosses it.
 *
 * Run: npx tsx examples/portable-xstate-loop/index.ts
 */
import { z } from "zod";
import type { AnyEventObject, Snapshot } from "xstate";
import { createDurable, type DurableExecution } from "xstate/durable";
import {
  isAgentIdle,
  provideExecutors,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

const portableLoopSetup = setupAgent({
  context: z.object({
    topic: z.string(),
    draft: z.string(),
    failure: z.string().nullable(),
  }),
  input: z.object({ topic: z.string() }),
  output: z.object({ draft: z.string(), failure: z.string().nullable() }),
  events: { APPROVE: z.object({}) },
  requests: {
    draft: {
      model: "writer",
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      prompt: ({ input }) => `Draft a release note about ${input.topic}.`,
    },
  },
});

export const portableLoopMachine = portableLoopSetup.createMachine({
  id: "portable-loop",
  context: ({ input }) => ({ topic: input.topic, draft: "", failure: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "draft",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({
          target: "reviewing",
          context: { draft: output },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `draft failed: ${String(event.error)}` },
        }),
      },
    },
    reviewing: {
      description: "Approve the drafted release notes to finish.",
      on: { APPROVE: { target: "done" } },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ draft: context.draft, failure: null }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({ draft: context.draft, failure: context.failure }),
    },
  },
});

type LoopMachine = typeof portableLoopMachine;
type LoopSnapshot = ReturnType<LoopMachine["restoreSnapshot"]>;

/**
 * One durable execution plus the in-memory mailbox its adapter parks on. A
 * real host swaps this for its own queue; nothing above it changes.
 */
function createExecution(machine: LoopMachine): DurableExecution<LoopMachine> {
  const mailbox: AnyEventObject[] = [];
  let wake: ((event: AnyEventObject) => void) | undefined;
  const enqueue = (event: AnyEventObject) => {
    const waiting = wake;
    wake = undefined;
    if (waiting) waiting(event);
    else mailbox.push(event);
  };
  return createDurable(machine, {
    startActor: (actor) => {
      actor.start();
    },
    enqueueRootEvent: (_source, event) => enqueue(event),
    executeAction: (action, _metadata, runtime) => action.exec(runtime),
    waitForEvent: () => mailbox.shift() ?? new Promise((resolve) => (wake = resolve)),
  });
}

/** Runs one execution forward until it finishes or comes to rest on an event. */
async function advance(
  execution: DurableExecution<LoopMachine>,
  start: [LoopSnapshot, Parameters<DurableExecution<LoopMachine>["executeEffects"]>[0]],
): Promise<LoopSnapshot> {
  let [state, effects] = start;
  await execution.executeEffects(effects);
  // `isAgentIdle` is the stop condition, not a state name: an active snapshot
  // that accepts an external event is resting on the host, not on work.
  while ((state as Snapshot<unknown>).status === "active" && !isAgentIdle(state)) {
    const event = await execution.waitForEvent();
    [state, effects] = execution.transition(state, event);
    await execution.executeEffects(effects);
  }
  return state;
}

export interface PortableLoopResult {
  draft: string;
  failure: string | null;
  /** True when the run actually paused and was resumed from a stored snapshot. */
  resumedFromSnapshot: boolean;
}

/**
 * Runs the artifact using XState's transition/effect protocol, across a
 * persistence boundary. Stately Agent only binds request actors; XState and
 * the host own execution.
 */
export async function runPortableXstateLoop(
  topic: string,
  executors: AgentRequestExecutors,
  externalEvents: Array<{ type: "APPROVE" }> = [{ type: "APPROVE" }],
): Promise<PortableLoopResult> {
  const machine = provideExecutors(portableLoopMachine, executors);

  // ── Pass 1: run to the first pause (or to a terminal state). ──
  const first = createExecution(machine);
  let state = await advance(first, first.initialTransition({ topic }) as never);

  if ((state as Snapshot<unknown>).status !== "active") {
    return { ...settle(state), resumedFromSnapshot: false };
  }

  // ── The process boundary: everything but this blob is thrown away. ──
  const stored = JSON.stringify(machine.getPersistedSnapshot(state));

  // ── Pass 2: a brand new execution, rehydrated from the stored snapshot. ──
  const second = createExecution(machine);
  let resumed = machine.restoreSnapshot(JSON.parse(stored)) as LoopSnapshot;
  while ((resumed as Snapshot<unknown>).status === "active") {
    const event = externalEvents.shift();
    if (!event) throw new Error("The host has no external event to deliver.");
    resumed = await advance(second, second.transition(resumed, event) as never);
    if (isAgentIdle(resumed)) continue;
    break;
  }

  return { ...settle(resumed), resumedFromSnapshot: true };
}

/** Reads the terminal snapshot's outcome, or refuses to invent one. */
function settle(state: LoopSnapshot): { draft: string; failure: string | null } {
  if (state.status === "done") return state.output;
  if (state.status === "error") throw state.error;
  throw new Error(`Portable loop stopped with '${state.status}'.`);
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  const output = await runPortableXstateLoop("portable agent machines", {
    generateText: async (request) => ({ output: `Release note: ${request.prompt}` }),
  });
  console.log(output);
}
