/**
 * Crash recovery — resume a run from its event log, with no snapshot.
 *
 * The log is the source of truth: `runAgent({ store, threadId })` writes every
 * external input the machine accepted straight to durable storage — before the
 * next model call — and reads it back to resume, folding the journal into state
 * without executing anything it already recorded. A request that was still in
 * flight at the crash has no recorded completion, so it — and only it — runs
 * again, under the same `info.callKey` the first attempt used, which is the
 * idempotency key a real host would send to the provider.
 *
 * No API key needed: executors are scripted. Run:
 * npx tsx examples/crash-recovery/index.ts
 */
import { z } from "zod";
import {
  runAgent,
  setupAgent,
  type AgentEventLogStore,
  type RunAgentOptions,
} from "@statelyai/agent";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";
import { createScriptedExecutors } from "@statelyai/agent/testing";
import type { AnyStateMachine } from "xstate";

/**
 * The seams a host threads through every leg of a multi-run example: its
 * executors, its cancellation signal, and the observers that make one story
 * out of several `runAgent` calls. Declared here, not imported, so the example
 * stays a single self-contained file (see CONTRIBUTING).
 */
type ExampleRunOptions = Pick<
  RunAgentOptions<AnyStateMachine>,
  "executors" | "signal" | "onTransition" | "on" | "onTrace" | "inspect"
>;

const crashRecoverySetup = setupAgent({
  context: z.object({
    topic: z.string(),
    outline: z.string().nullable(),
    article: z.string().nullable(),
  }),
  input: z.object({ topic: z.string() }),
  output: z.object({ topic: z.string(), outline: z.string(), article: z.string() }),
  // Named requests: the scripted executors below route on these names, not on
  // call order, so a replayed run cannot pick up the wrong answer.
  requests: {
    outline: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      prompt: ({ input }) => `Outline a short article about ${input.topic}.`,
    },
    draft: {
      schemas: {
        input: z.object({ topic: z.string(), outline: z.string() }),
        output: z.string(),
      },
      model: "writer",
      prompt: ({ input }) =>
        `Write the article about ${input.topic} for this outline: ${input.outline}`,
    },
  },
});

export const crashRecoveryMachine = crashRecoverySetup.createMachine({
  // Named so inspected actors read `crash-recovery.outlining` rather than
  // XState's `(machine)` placeholder for an anonymous root.
  id: "crash-recovery",
  context: ({ input }) => ({ topic: input.topic, outline: null, article: null }),
  initial: "outlining",
  states: {
    outlining: {
      invoke: {
        src: "outline",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "drafting", context: { outline: output.result } }),
        onError: { target: "failed" },
      },
    },
    drafting: {
      invoke: {
        src: "draft",
        input: ({ context }) => ({ topic: context.topic, outline: context.outline ?? "" }),
        onDone: ({ output }) => ({ target: "done", context: { article: output.result } }),
        onError: { target: "failed" },
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
    // A crash is recoverable; a provider error is not. The run lands in its own
    // terminal state, so a host reads the difference off `snapshot.matches`
    // rather than guessing from an empty string.
    failed: {
      type: "final",
      output: ({ context }) => ({
        topic: context.topic,
        outline: context.outline ?? "",
        article: "The writer request failed.",
      }),
    },
  },
});

/**
 * First process: answers the outline call, hangs on the draft call, then
 * "crashes" — everything it journaled up to that point is in the store.
 */
export async function runUntilCrash({
  store,
  topic = "state machines",
  threadId = crypto.randomUUID(),
  ...observers
}: {
  store: AgentEventLogStore;
  topic?: string;
  threadId?: string;
  // Executors are the example's own: the script is what stages the crash.
} & Omit<ExampleRunOptions, "executors" | "signal">) {
  const abort = new AbortController();
  let inFlightCallKey: string | undefined;

  const executors = createScriptedExecutors({
    text: {
      outline: [() => `1. Intro to ${topic} 2. Body on ${topic} 3. Outro`],
      draft: [
        (_request, info) => {
          inFlightCallKey = info?.callKey;
          // The draft call never resolves; the process dies while it is in flight,
          // so no completion for it is ever journaled.
          setTimeout(() => abort.abort(new Error("process crashed")), 10);
          return new Promise<string>(() => {});
        },
      ],
    },
  });

  // Write-ahead: each entry reaches the store as it is appended, and the outline
  // call cannot start until the entries before it are durable.
  const crashed = await runAgent(crashRecoveryMachine, {
    ...(observers as object),
    input: { topic },
    store,
    threadId,
    executors,
    signal: abort.signal,
  });

  console.log(`crashed with status '${crashed.status}'`);
  console.log(`model calls before the crash: ${executors.calls.length}`); // 2 — one completed
  console.log(`journaled entries: ${crashed.events.length}`);
  return { threadId, inFlightCallKey, calls: executors.calls.length };
}

/**
 * Second process: read the log back and resume from it. No snapshot is passed
 * — nothing but the journal crossed the process boundary.
 */
export async function recover({
  store,
  threadId,
  ...observers
}: {
  store: AgentEventLogStore;
  threadId: string;
} & Omit<ExampleRunOptions, "executors" | "signal">) {
  let replayedCallKey: string | undefined;

  // Only the `draft` request is scripted: if the recovered run re-executed the
  // journaled `outline` call, the script would have no route for it and throw.
  const executors = createScriptedExecutors({
    text: {
      draft: [
        (request, info) => {
          replayedCallKey = info?.callKey;
          return `Draft based on: ${request.prompt}`;
        },
      ],
    },
  });

  // No `events`, no snapshot: the store's thread IS the resume, and the run
  // keeps appending to it, so the thread stays replayable end to end.
  const recovered = await runAgent(crashRecoveryMachine, {
    ...(observers as object),
    store,
    threadId,
    executors,
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

/**
 * Both halves in one call: crash, then recover from the log alone. The
 * interesting part is the boundary BETWEEN them, so a host that drives a
 * single machine cannot show it — see {@link ExampleRunOptions}.
 */
export async function runCrashRecoveryExample(options: ExampleRunOptions = {}) {
  const { executors: _executors, signal: _signal, ...observers } = options;
  // Stands in for the host's database: an append-only log per thread.
  const store = createInMemoryEventLogStore();
  const {
    threadId,
    inFlightCallKey,
    calls: callsBeforeCrash,
  } = await runUntilCrash({
    store,
    ...observers,
  });
  const {
    recovered,
    replayedCallKey,
    calls: callsDuringRecovery,
  } = await recover({
    store,
    threadId,
    ...observers,
  });
  return {
    // The headline: the in-flight call re-executes under the SAME key, so the
    // retry is safe to dedupe at the provider.
    callKeyMatched: inFlightCallKey === replayedCallKey,
    status: recovered.status,
    callsBeforeCrash,
    callsDuringRecovery,
    journalEntries: recovered.events.length,
    article: recovered.status === "done" ? recovered.output.article : null,
  };
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  // Created here, not at module scope, so importing this file shares no state.
  const store = createInMemoryEventLogStore();
  const { threadId, inFlightCallKey } = await runUntilCrash({ store });
  const { replayedCallKey } = await recover({ store, threadId });
  // Same key both times: the retry is safe to dedupe at the provider.
  console.log(`callKey matched: ${inFlightCallKey === replayedCallKey}`);
}
