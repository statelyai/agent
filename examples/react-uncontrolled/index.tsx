/**
 * React — UNCONTROLLED mode. The component owns the actor lifecycle: it builds
 * the machine with `provideExecutors(machine, executors)` (NEW core export) and
 * runs it as a plain XState actor via `createActor`. There is no `runAgent`
 * loop here — the machine drives itself, and React just observes and sends
 * events.
 *
 * Teaches the uncontrolled seam:
 *   - `provideExecutors` binds the machine's agent invokes to host executors in
 *     one call, returning a machine ready for `createActor`.
 *   - `onChunk` (a `provideExecutors` option) streams text into the UI live.
 *   - `useSyncExternalStore` subscribes React to the actor's snapshots.
 *   - the UI reads state (`snapshot.value`, context) and sends user events
 *     (`actor.send({ type: 'APPROVE' })`) — the machine owns which are legal.
 *
 * @xstate/react is NOT a dependency of this repo (and its peer range predates
 * XState v6), so the actor↔React binding is a hand-rolled `useSyncExternalStore`
 * subscription. With a matching `@xstate/react` release, swap it for
 * `useSelector` / `useActorRef`; the machine and executors are unchanged.
 *
 * Executors are a keyless mock (no network) so the file is self-contained and
 * typechecks standalone. Swap in `createAiSdkExecutors({ models })` for real
 * generations. Not mounted here (no react-dom dependency) — this is the
 * component you'd render.
 */
import { useRef, useState, useSyncExternalStore } from "react";
import { createActor, type Actor, type SnapshotFrom } from "xstate";
import { z } from "zod";
import { provideExecutors, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

// ─── The machine: stream a draft → wait for the human → publish ───

const agentSetup = setupAgent({
  context: z.object({ topic: z.string(), draft: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ draft: z.string() }),
  events: { APPROVE: z.object({}), REJECT: z.object({ reason: z.string() }) },
  requests: {
    streamDraft: {
      mode: "stream",
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      prompt: ({ input }) => `Write a short announcement about: ${input.topic}`,
    },
  },
  states: {
    reviewing: { context: { draft: z.string() } },
    published: { context: { draft: z.string() } },
  },
});

const announceMachine = agentSetup.createMachine({
  id: "react-announce",
  context: ({ input }) => ({ topic: input.topic, draft: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "streamDraft",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "reviewing", context: { draft: output } }),
      },
    },
    // No invoke: the actor rests here until the UI sends APPROVE / REJECT.
    reviewing: {
      on: {
        APPROVE: { target: "published" },
        REJECT: ({ context, event }) => ({
          target: "drafting",
          context: { topic: `${context.topic}\nRevision requested: ${event.reason}` },
        }),
      },
    },
    published: { type: "final", output: ({ context }) => ({ draft: context.draft }) },
  },
});

type AnnounceActor = Actor<typeof announceMachine>;

/**
 * Keyless mock: `streamText` yields a few chunks through onChunk (no network).
 * `generateText` is required by the executors type but unused by this machine.
 */
const mockExecutors: AgentRequestExecutors = {
  generateText: async () => ({ output: "" }),
  streamText: async (_request, info) => {
    const chunks = ["Big news: ", "the deploy pipeline ", "just got faster."];
    for (const chunk of chunks) info?.onChunk?.(chunk);
    return { output: chunks.join("") };
  },
};

/** Subscribe React to an XState actor's snapshots (the @xstate/react-free path). */
function useActorSnapshot(actor: AnnounceActor): SnapshotFrom<typeof announceMachine> {
  return useSyncExternalStore(
    (onChange) => {
      const sub = actor.subscribe(onChange);
      return () => sub.unsubscribe();
    },
    () => actor.getSnapshot(),
    () => actor.getSnapshot(),
  );
}

export interface AnnouncerProps {
  topic?: string;
  executors?: AgentRequestExecutors;
}

/**
 * The uncontrolled component. It creates the actor once (lazy `useRef`),
 * threading `onChunk` into `provideExecutors` so streamed text lands in local
 * state, and renders the current machine state.
 */
export function Announcer({
  topic = "the new deploy pipeline",
  executors = mockExecutors,
}: AnnouncerProps) {
  const [streamed, setStreamed] = useState("");

  const actorRef = useRef<AnnounceActor | null>(null);
  if (actorRef.current === null) {
    const bound = provideExecutors(announceMachine, executors, {
      onChunk: (chunk) => setStreamed((prev) => prev + chunk),
    });
    const actor = createActor(bound, { input: { topic } });
    actor.start();
    actorRef.current = actor;
  }
  const actor = actorRef.current;

  const snapshot = useActorSnapshot(actor);
  const state = String(snapshot.value);

  return (
    <section>
      <h2>Announcer — {state}</h2>

      {state === "drafting" && <p>Drafting: {streamed}</p>}

      {state === "reviewing" && (
        <div>
          <p>{snapshot.context.draft}</p>
          <button type="button" onClick={() => actor.send({ type: "APPROVE" })}>
            Approve
          </button>
          <button
            type="button"
            onClick={() => actor.send({ type: "REJECT", reason: "make it punchier" })}
          >
            Reject
          </button>
        </div>
      )}

      {state === "published" && <p>Published: {snapshot.context.draft}</p>}
    </section>
  );
}
