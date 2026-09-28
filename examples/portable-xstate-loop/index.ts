/**
 * The agent loop in a stateless host: a request handler that runs the machine
 * until nothing is in flight, persists, and returns.
 *
 * `portableLoopMachine` is the artifact. `handleTurn` is the whole host — the
 * same five-call loop a script, a queue worker, or an HTTP route writes:
 *
 *   start → execute → (nextEvent → transition → execute)* → finish
 *
 * Two things make this a durability demo rather than a plain loop:
 *
 *   - The loop stops on QUIESCENCE — `nextEvent()` returning `undefined`
 *     because no request, child, or timer is still working — not on a state
 *     name. The machine resting in `reviewing` is simply what is left when the
 *     draft is done. Add a wait state, or a parallel region still working
 *     while the person reads, and the host needs no change.
 *   - The pause is PERSISTED (`result.persist()` → JSON) and the next turn is
 *     a brand-new runtime, rehydrated from that blob — which is what proves
 *     the wait survives a process boundary. Nothing but the snapshot crosses it.
 *
 * Run: npx tsx examples/portable-xstate-loop/index.ts
 */
import { z } from "zod";
import { createAgentRuntime, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

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
          context: { draft: output.result },
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

/** What a turn hands back: finished, or paused with the blob to store. */
export type TurnResult =
  | { status: "done"; draft: string; failure: string | null }
  | { status: "paused"; stored: string };

/**
 * One turn of a stateless host: start fresh (`input`) or from the stored blob
 * plus the event that ended the wait, run until nothing is in flight, then
 * persist and return. This is the whole host.
 */
export async function handleTurn(
  turn: { input: { topic: string } } | { stored: string; event: { type: "APPROVE" } },
  executors: AgentRequestExecutors,
): Promise<TurnResult> {
  const runtime = createAgentRuntime(portableLoopMachine, { executors });
  let [state, effects] = await runtime.start(
    "input" in turn ? { input: turn.input } : { snapshot: JSON.parse(turn.stored) },
  );
  await runtime.execute(effects);
  if ("event" in turn) {
    [state, effects] = runtime.transition(state, turn.event);
    await runtime.execute(effects);
  }
  // `undefined` means quiescent: only the outside world can move it now.
  for (let event; (event = await runtime.nextEvent()); ) {
    [state, effects] = runtime.transition(state, event);
    await runtime.execute(effects);
  }

  const result = await runtime.finish();
  if (result.status === "done") return { status: "done", ...result.output };
  if (result.status === "error") throw result.error;
  return { status: "paused", stored: JSON.stringify(result.persist()) };
}

export interface PortableLoopResult {
  draft: string;
  failure: string | null;
  /** True when the run actually paused and was resumed from a stored snapshot. */
  resumedFromSnapshot: boolean;
}

/**
 * Drives `handleTurn` the way a host would across requests: the first turn
 * pauses on review, only the stored blob survives, and the next turn delivers
 * the approval to a fresh runtime.
 */
export async function runPortableXstateLoop(
  topic: string,
  executors: AgentRequestExecutors,
  externalEvents: Array<{ type: "APPROVE" }> = [{ type: "APPROVE" }],
): Promise<PortableLoopResult> {
  let turn = await handleTurn({ input: { topic } }, executors);
  let resumedFromSnapshot = false;
  while (turn.status === "paused") {
    const event = externalEvents.shift();
    if (!event) throw new Error("The host has no external event to deliver.");
    // ── The process boundary: everything but `turn.stored` is thrown away. ──
    turn = await handleTurn({ stored: turn.stored, event }, executors);
    resumedFromSnapshot = true;
  }
  return { draft: turn.draft, failure: turn.failure, resumedFromSnapshot };
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  const output = await runPortableXstateLoop("portable agent machines", {
    generateText: async (request) => ({ result: `Release note: ${request.prompt}` }),
  });
  console.log(output);
}
