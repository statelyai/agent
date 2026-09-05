/**
 * The portable XState loop, with no Stately Agent runner.
 *
 * `portableLoopMachine` is the artifact. The host binds its model executor,
 * then runs XState's canonical transition/effect loop. A durable framework can
 * replace the in-memory adapter below with its own XState durable adapter
 * without changing the machine.
 *
 * Run: npx tsx examples/portable-xstate-loop/index.ts
 */
import { z } from "zod";
import type { AnyEventObject, Snapshot } from "xstate";
import { createDurable } from "xstate/durable";
import { provideExecutors, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

const portableLoopSetup = setupAgent({
  context: z.object({ topic: z.string(), draft: z.string() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ draft: z.string() }),
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
  context: ({ input }) => ({ topic: input.topic, draft: "" }),
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
      },
    },
    reviewing: { on: { APPROVE: { target: "done" } } },
    done: {
      type: "final",
      output: ({ context }) => ({ draft: context.draft }),
    },
  },
});

/**
 * Runs the artifact using XState's transition/effect protocol. Stately Agent
 * only binds request actors; XState and the host own execution.
 */
export async function runPortableXstateLoop(
  topic: string,
  executors: AgentRequestExecutors,
  externalEvents: Array<{ type: "APPROVE" }> = [{ type: "APPROVE" }],
): Promise<{ draft: string }> {
  const machine = provideExecutors(portableLoopMachine, executors);
  const mailbox: AnyEventObject[] = [];
  let wake: ((event: AnyEventObject) => void) | undefined;
  const enqueue = (event: AnyEventObject) => {
    const waiting = wake;
    wake = undefined;
    if (waiting) waiting(event);
    else mailbox.push(event);
  };
  const execution = createDurable(machine, {
    startActor: (actor) => {
      actor.start();
    },
    enqueueRootEvent: (_source, event) => enqueue(event),
    executeAction: (action, _metadata, runtime) => action.exec(runtime),
    waitForEvent: () => mailbox.shift() ?? new Promise((resolve) => (wake = resolve)),
  });

  let [state, effects] = execution.initialTransition({ topic });
  await execution.executeEffects(effects);

  while ((state as Snapshot<unknown>).status === "active") {
    if (state.matches("reviewing")) {
      const event = externalEvents.shift();
      if (!event) throw new Error("The host has no external event to deliver.");
      enqueue(event);
    }
    const event = await execution.waitForEvent();
    [state, effects] = execution.transition(state, event);
    await execution.executeEffects(effects);
  }

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
