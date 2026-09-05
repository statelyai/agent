/**
 * Crash recovery — resume a run from its event log, with no snapshot.
 *
 * The log is the source of truth: `onEvent` hands the host every external input
 * the machine accepted, and `runAgent({ events })` folds that journal back into
 * state without executing anything it already recorded. A request that was
 * still in flight at the crash has no recorded completion, so it — and only it
 * — runs again, under the same `info.callKey` the first attempt used, which is
 * the idempotency key a real host would send to the provider.
 *
 * No API key needed: executors are scripted. Run:
 * npx tsx examples/crash-recovery/index.ts
 */
import { z } from "zod";
import {
  createInMemoryEventLogStore,
  createScriptedExecutors,
  runAgent,
  setupAgent,
} from "@statelyai/agent";
import type { AgentLogEntry } from "@statelyai/agent";

const crashRecoverySetup = setupAgent({
  context: z.object({
    topic: z.string(),
    outline: z.string().nullable(),
    article: z.string().nullable(),
  }),
  input: z.object({ topic: z.string() }),
  output: z.object({ topic: z.string(), outline: z.string(), article: z.string() }),
});

export const crashRecoveryMachine = crashRecoverySetup.createMachine({
  context: ({ input }) => ({ topic: input.topic, outline: null, article: null }),
  initial: "outlining",
  states: {
    outlining: {
      invoke: {
        src: "agent.generateText",
        input: ({ context }) => ({
          model: "writer",
          prompt: `Outline a short article about ${context.topic}.`,
        }),
        onDone: ({ event }) => ({
          target: "drafting",
          context: { outline: String(event.output) },
        }),
      },
    },
    drafting: {
      invoke: {
        src: "agent.generateText",
        input: ({ context }) => ({
          model: "writer",
          prompt: `Write the article about ${context.topic} for this outline: ${context.outline}`,
        }),
        onDone: ({ event }) => ({
          target: "done",
          context: { article: String(event.output) },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        topic: context.topic,
        outline: context.outline ?? "",
        article: context.article ?? "",
      }),
    },
  },
});

/** Stands in for the host's database: an append-only log per thread. */
export const store = createInMemoryEventLogStore();

/**
 * First process: answers the outline call, hangs on the draft call, then
 * "crashes" — everything it journaled up to that point is in the store.
 */
export async function runUntilCrash(topic = "state machines", threadId = crypto.randomUUID()) {
  const abort = new AbortController();
  let inFlightCallKey: string | undefined;

  const executors = createScriptedExecutors({
    text: [
      () => `1. Intro to ${topic} 2. Body on ${topic} 3. Outro`,
      (_request, info) => {
        inFlightCallKey = info?.callKey;
        // The draft call never resolves; the process dies while it is in flight,
        // so no completion for it is ever journaled.
        setTimeout(() => abort.abort(new Error("process crashed")), 10);
        return new Promise<string>(() => {});
      },
    ],
  });

  // `onEvent` is synchronous, so it buffers; the buffer is flushed to the store
  // once the leg settles (a real host may flush on its own cadence).
  const journal: AgentLogEntry[] = [];

  const crashed = await runAgent(crashRecoveryMachine, {
    input: { topic },
    executors,
    signal: abort.signal,
    onEvent: (entry) => journal.push(entry),
  });

  await store.append({ threadId, expectedIndex: 0, entries: journal });

  console.log(`crashed with status '${crashed.status}'`);
  console.log(`model calls before the crash: ${executors.calls.length}`); // 2 — one completed
  console.log(`journaled entries: ${journal.length}`);
  return { threadId, inFlightCallKey, calls: executors.calls.length };
}

/**
 * Second process: read the log back and resume from it. No snapshot is passed
 * — nothing but the journal crossed the process boundary.
 */
export async function recover(threadId: string) {
  let replayedCallKey: string | undefined;

  // Exactly ONE scripted answer: if the recovered run re-executed the outline
  // call, the script would run dry and throw.
  const executors = createScriptedExecutors({
    text: [
      (request, info) => {
        replayedCallKey = info?.callKey;
        return `Draft based on: ${request.prompt}`;
      },
    ],
  });

  const events = await store.read(threadId);
  const recovered = await runAgent(crashRecoveryMachine, { events, executors });

  // The resumed result's `events` extends the same log, so the thread stays
  // replayable end to end.
  await store.append({
    threadId,
    expectedIndex: events.length,
    entries: recovered.events.slice(events.length),
  });

  console.log(`recovered with status '${recovered.status}'`);
  console.log(`model calls during recovery: ${executors.calls.length}`); // 1 — only the draft
  console.log(`full log length: ${recovered.events.length}`);
  if (recovered.status === "done") {
    console.log(`topic: ${recovered.output.topic}`);
    console.log(`article: ${recovered.output.article}`);
  }
  return { recovered, replayedCallKey, calls: executors.calls.length };
}

const isMain = process.argv[1]?.endsWith("crash-recovery/index.ts");
if (isMain) {
  const { threadId, inFlightCallKey } = await runUntilCrash();
  const { replayedCallKey } = await recover(threadId);
  // Same key both times: the retry is safe to dedupe at the provider.
  console.log(`callKey matched: ${inFlightCallKey === replayedCallKey}`);
}
