/**
 * Time travel — rewind a finished run, edit its state, and branch from there.
 *
 * Thread A outlines, rests in `outlined` until the host sends `DRAFT`, then
 * drafts in one tone. The host then reads A's log, replays it up to the rest in
 * `outlined` (a pure fold: no model call), edits `context.tone` on the replayed
 * snapshot, and resumes that snapshot as a new thread B. B keeps A's outline
 * and redrafts it in the new tone. A's log is never touched.
 *
 * The branch point is a state at rest. A request in flight at the branch point
 * is restored with the input it started with, so an edit to context would not
 * reach it.
 *
 * LangGraph shape:
 *
 *   graph.get_state_history(config)        → pick a checkpoint
 *   graph.update_state(checkpoint, values) → a new checkpoint with edited values
 *   graph.invoke(None, new_config)         → continue from it
 *
 * Here:
 *
 *   store.read(threadA)                        → the log
 *   replay(machine, log.slice(0, n))           → the state at entry n
 *   { ...persistedSnapshot, context: edited }  → the edited state
 *   runAgent(machine, { threadId: threadB, snapshot, event }) → continue from it
 *
 * Differences from LangGraph worth calling out:
 *   - The edit is not written into A's history. B is a new thread whose init
 *     entry carries the edited snapshot, under a new execution id.
 *   - The branch point is an index into the log, not a checkpoint id.
 *
 * Dual-mode: `runTimeTravelExample(options?)` takes an injectable
 * `generateText` (tests script it); the direct run uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/time-travel/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import {
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  createInMemoryEventLogStore,
  getLogExecutionId,
  replay,
  type AgentLogEntry,
} from "@statelyai/agent/log";

const timeTravelSetup = setupAgent({
  models: { writer: openai("gpt-5.4-mini") },
  // `meta.interaction` labels the rest in `outlined` for a host UI.
  meta: interactionMetaSchema,
  context: z.object({
    topic: z.string(),
    tone: z.string(),
    outline: z.string().nullable(),
    draft: z.string().nullable(),
  }),
  input: z.object({ topic: z.string(), tone: z.string() }),
  events: { DRAFT: z.object({}) },
  output: z.object({ outline: z.string(), draft: z.string(), tone: z.string() }),
  requests: {
    outline: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      prompt: ({ input }) => `Outline a short piece about ${input.topic} in three bullets.`,
    },
    draft: {
      schemas: {
        input: z.object({ topic: z.string(), tone: z.string(), outline: z.string() }),
        output: z.string(),
      },
      model: "writer",
      system: ({ input }) => `Write in a ${input.tone} tone.`,
      prompt: ({ input }) =>
        `Write the piece about ${input.topic} from this outline:\n${input.outline}`,
    },
  },
});

export const timeTravelMachine = timeTravelSetup.createMachine({
  id: "time-travel",
  context: ({ input }) => ({ topic: input.topic, tone: input.tone, outline: null, draft: null }),
  initial: "outlining",
  states: {
    outlining: {
      invoke: {
        src: "outline",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "outlined", context: { outline: output.result } }),
        onError: { target: "failed" },
      },
    },
    // At rest: no request in flight, so the snapshot here is safe to edit.
    // Every model input after this point is computed from context afresh.
    outlined: {
      meta: {
        interaction: {
          label: "Outline ready for '{topic}'. Draft it in a {tone} tone?",
          events: { DRAFT: { label: "Draft", style: "primary" } },
        },
      },
      on: { DRAFT: { target: "drafting" } },
    },
    drafting: {
      invoke: {
        src: "draft",
        input: ({ context }) => ({
          topic: context.topic,
          tone: context.tone,
          outline: context.outline ?? "",
        }),
        onDone: ({ output }) => ({ target: "done", context: { draft: output.result } }),
        onError: { target: "failed" },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        outline: context.outline ?? "",
        draft: context.draft ?? "",
        tone: context.tone,
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        outline: context.outline ?? "",
        draft: "The writer request failed.",
        tone: context.tone,
      }),
    },
  },
});

export interface RunTimeTravelOptions {
  topic?: string;
  /** Thread A's tone. */
  tone?: string;
  /** The tone edited into the branch. */
  branchTone?: string;
  /** Injected for tests; the direct run uses real models. */
  generateText?: AgentRequestExecutors["generateText"];
  /** A host's executors (the demo passes its own); wins over `generateText`. */
  executors?: Partial<AgentRequestExecutors>;
  signal?: AbortSignal;
}

/** The log index of the `DRAFT` event: the prefix before it rests in `outlined`. */
function beforeDraft(entries: readonly AgentLogEntry[]): number {
  const index = entries.findIndex((entry) => entry.event.type === "DRAFT");
  if (index < 0) throw new Error("time-travel: thread A has no DRAFT entry to branch at.");
  return index;
}

/** Runs thread A to done, then branches thread B from A's log with an edited tone. */
export async function runTimeTravelExample(options: RunTimeTravelOptions = {}) {
  const {
    topic = "state machines",
    tone = "formal",
    branchTone = "playful",
    generateText,
    signal,
  } = options;
  const executors =
    options.executors ??
    (generateText ? { generateText } : createAiSdkExecutors(timeTravelMachine));
  // Stands in for the host's database: an append-only log per thread.
  const store = createInMemoryEventLogStore();

  // Thread A: an ordinary run, journaled to the store. The host answers the
  // rest in `outlined` with `DRAFT` straight away.
  const a = await runAgent(timeTravelMachine, {
    store,
    threadId: "thread-a",
    input: { topic, tone },
    executors,
    ...(signal ? { signal } : {}),
    onIdle: async () => ({ type: "DRAFT" as const }),
  });
  if (a.status !== "done") throw new Error(`Thread A did not complete: ${a.status}`);
  const logA = await store.read("thread-a");

  // 1. Rewind: fold A's log up to the branch point. Nothing executes.
  const branchIndex = beforeDraft(logA);
  const { persistedSnapshot } = replay(timeTravelMachine, logA.slice(0, branchIndex));

  // 2. Edit: any part of the persisted snapshot. Here, only the tone.
  const rewound = persistedSnapshot as typeof persistedSnapshot & {
    context: z.infer<typeof timeTravelSetup.schemas.context>;
  };
  const edited = { ...rewound, context: { ...rewound.context, tone: branchTone } };

  // 3. Branch: resume the edited snapshot on a fresh thread. Its init entry
  //    carries `edited`, and it gets its own execution id.
  const b = await runAgent(timeTravelMachine, {
    store,
    threadId: "thread-b",
    snapshot: edited,
    event: { type: "DRAFT" },
    executors,
    ...(signal ? { signal } : {}),
  });
  if (b.status !== "done") throw new Error(`Thread B did not complete: ${b.status}`);
  const logB = await store.read("thread-b");

  return {
    branchIndex,
    a: { output: a.output, executionId: getLogExecutionId(logA), log: logA },
    b: { output: b.output, executionId: getLogExecutionId(logB), log: logB },
    // A is the same log after the branch as before it.
    logAAfterBranch: await store.read("thread-a"),
  };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run this example.");
  void runTimeTravelExample().then(({ branchIndex, a, b }) => {
    console.log(`Thread A (${a.output.tone}):\n${a.output.draft}\n`);
    console.log(`Branched at entry ${branchIndex}.\n`);
    console.log(`Thread B (${b.output.tone}):\n${b.output.draft}`);
  });
}
