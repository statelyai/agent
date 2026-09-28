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
 * The crash is staged, not the model: the example wraps the host's real
 * executors so the `draft` call hangs and the process "dies" mid-flight.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/crash-recovery/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import {
  runAgent,
  setupAgent,
  type AgentEventLogStore,
  type AgentRequestExecutors,
  type RunAgentOptions,
} from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";
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
  // Named requests: the crash below is staged on the `draft` name, not on call
  // order, so a replayed run cannot stage it on the wrong call.
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

/** The host's real executors: one OpenAI model behind the `writer` ref. */
function liveExecutors(): Partial<AgentRequestExecutors> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY to run the crash-recovery example.");
  }
  return createAiSdkExecutors({ models: { writer: openai("gpt-6-luna") } });
}

/**
 * Wraps a host's `generateText` so one process can count its model calls and
 * see the `callKey` each `draft` call carried; `onDraft` may take the call
 * over (the crash leg hangs it) instead of passing it through.
 */
function observeCalls(
  executors: Partial<AgentRequestExecutors>,
  onDraft?: () => Promise<never>,
): {
  executors: Partial<AgentRequestExecutors>;
  calls: () => number;
  draftCallKey: () => string | undefined;
} {
  const generateText = executors.generateText;
  if (!generateText) throw new Error("crash-recovery needs a generateText executor.");
  let calls = 0;
  let draftCallKey: string | undefined;
  return {
    executors: {
      ...executors,
      generateText: (request, info) => {
        calls += 1;
        if (request.name === "draft") {
          draftCallKey = info?.callKey;
          if (onDraft) return onDraft();
        }
        return generateText(request, info);
      },
    },
    calls: () => calls,
    draftCallKey: () => draftCallKey,
  };
}

/**
 * First process: answers the outline call, hangs on the draft call, then
 * "crashes" — everything it journaled up to that point is in the store.
 */
export async function runUntilCrash({
  store,
  topic = "state machines",
  threadId = crypto.randomUUID(),
  executors = liveExecutors(),
  signal,
  ...observers
}: {
  store: AgentEventLogStore;
  topic?: string;
  threadId?: string;
} & ExampleRunOptions) {
  // The staged crash has its own controller; the host's cancellation rides
  // alongside it, so a cancel stops the in-flight model call too.
  const abort = new AbortController();
  const runSignal = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;

  // The draft call never resolves; the process dies while it is in flight, so
  // no completion for it is ever journaled.
  const observed = observeCalls(executors, () => {
    setTimeout(() => abort.abort(new Error("process crashed")), 10);
    return new Promise<never>(() => {});
  });

  // Write-ahead: each entry reaches the store as it is appended, and the outline
  // call cannot start until the entries before it are durable.
  const crashed = await runAgent(crashRecoveryMachine, {
    ...(observers as object),
    input: { topic },
    store,
    threadId,
    executors: observed.executors,
    signal: runSignal,
  });

  console.log(`crashed with status '${crashed.status}'`);
  console.log(`model calls before the crash: ${observed.calls()}`); // 2 — one completed
  console.log(`journaled entries: ${crashed.events.length}`);
  return { threadId, inFlightCallKey: observed.draftCallKey(), calls: observed.calls() };
}

/**
 * Second process: read the log back and resume from it. No snapshot is passed
 * — nothing but the journal crossed the process boundary.
 */
export async function recover({
  store,
  threadId,
  executors = liveExecutors(),
  signal,
  ...observers
}: {
  store: AgentEventLogStore;
  threadId: string;
} & ExampleRunOptions) {
  // The journaled `outline` call is replayed from the log, so only `draft`
  // reaches the model here.
  const observed = observeCalls(executors);

  // No `events`, no snapshot: the store's thread IS the resume, and the run
  // keeps appending to it, so the thread stays replayable end to end.
  const recovered = await runAgent(crashRecoveryMachine, {
    ...(observers as object),
    store,
    threadId,
    executors: observed.executors,
    ...(signal ? { signal } : {}),
  });

  console.log(`recovered with status '${recovered.status}'`);
  console.log(`model calls during recovery: ${observed.calls()}`); // 1 — only the draft
  console.log(`full log length: ${recovered.events.length}`);
  if (recovered.status === "done") {
    console.log(`topic: ${recovered.output.topic}`);
    console.log(`article: ${recovered.output.article}`);
  }
  return { recovered, replayedCallKey: observed.draftCallKey(), calls: observed.calls() };
}

/**
 * Both halves in one call: crash, then recover from the log alone. The
 * interesting part is the boundary BETWEEN them, so a host that drives a
 * single machine cannot show it — see {@link ExampleRunOptions}.
 */
export async function runCrashRecoveryExample(options: ExampleRunOptions = {}) {
  const { signal, ...observers } = options;
  // Stands in for the host's database: an append-only log per thread.
  const store = createInMemoryEventLogStore();
  const {
    threadId,
    inFlightCallKey,
    calls: callsBeforeCrash,
  } = await runUntilCrash({
    store,
    ...(signal ? { signal } : {}),
    ...observers,
  });
  // A host cancel is not the staged crash: stop here instead of recovering.
  signal?.throwIfAborted();
  const {
    recovered,
    replayedCallKey,
    calls: callsDuringRecovery,
  } = await recover({
    store,
    threadId,
    ...(signal ? { signal } : {}),
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
