/**
 * Plain XState, driven as an agent — the strongest form of the claim.
 *
 * `plainWriterMachine` below is a normal XState v6 machine. It imports only
 * from `xstate` (`setup`, `createAsyncLogic`), and it has ZERO knowledge of
 * `@statelyai/agent`: a promise-shaped actor for one step, an `onError`
 * transition that retries that actor a bounded number of times, a plain
 * `on: { APPROVE, REVISE }` decision state with a guarded transition bounding
 * the revision loop, and final states. It runs on its own under a bare
 * `createActor(...)` — the placeholder `writeDraft` returns a canned draft, so
 * nothing about it needs an LLM.
 *
 * The driving code (`runPlainXstateExample`) is where adoption happens. You
 * already have this machine; here is how to make the model do the work:
 *
 *   1. Bind the promise actor to a real model call with `machine.provide(...)`
 *      — swap the canned `writeDraft` for one that calls `generateText`. The
 *      machine's shape is untouched.
 *   2. Drive the decision points. The machine settles at `judging` (an ordinary
 *      event-waiting state). Enumerate its legal events with
 *      `getAcceptedEvents(snapshot)` and let the model pick one with
 *      `resolveDecision(...)`, gated by `snapshot.can(event)` so the guard —
 *      not the model — enforces the revision budget.
 *
 * No `setupAgent`, no `agent.decide`, no library-specific machine authoring.
 * The contract is minimal: invokes return values, states accept events, guards
 * decide legality. The library supplies the model; the machine supplies the
 * shape.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/plain-xstate/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createActor, createAsyncLogic, setup, waitFor } from "xstate";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  getAcceptedEvents,
  resolveDecision,
  userMessage,
  type AgentRequestExecutors,
} from "@statelyai/agent";

export const models = defineModels({
  writer: openai("gpt-5.4-mini"),
  judge: openai("gpt-5.4-mini"),
});

// ─── The plain machine: only `xstate`, no `@statelyai/agent` ───

/** Revision rounds allowed before only APPROVE remains legal. */
const MAX_REVISIONS = 2;

/** Re-invokes allowed when the draft actor rejects. */
const MAX_RETRIES = 2;

const contextSchema = z.object({
  topic: z.string(),
  maxRevisions: z.number(),
  /** Drafts produced so far (incremented each time `writeDraft` resolves). */
  attempts: z.number(),
  /** Failed draft attempts re-invoked so far. */
  retries: z.number(),
  maxRetries: z.number(),
  draft: z.string(),
  /** Readable running tally of drafts, revisions, and retries. */
  progress: z.string(),
});

/** The tally a host can show without decoding the trace. */
function renderProgress(context: {
  attempts: number;
  maxRevisions: number;
  retries: number;
}): string {
  const revisions = Math.max(0, context.attempts - 1);
  const retries = `${context.retries} ${context.retries === 1 ? "retry" : "retries"}`;
  return (
    `Draft ${context.attempts} ready: ${revisions} of ${context.maxRevisions} revisions used, ` +
    `${retries} after a failed attempt.`
  );
}

const eventSchemas = {
  APPROVE: z.object({}),
  REVISE: z.object({}),
};

/** Prompt for one draft, plain data the actor turns into a model call. */
function draftPrompt(input: { topic: string; attempts: number }): string {
  return input.attempts === 0
    ? `Write a two-sentence launch blurb for: ${input.topic}. No buzzwords.`
    : `Revise the launch blurb for: ${input.topic}. This is revision #${input.attempts}; ` +
        `make it more concrete and cut any filler.`;
}

export const plainWriterMachine = setup({
  schemas: {
    context: contextSchema,
    events: eventSchemas,
    input: z.object({ topic: z.string() }),
    output: z.object({
      draft: z.string(),
      attempts: z.number(),
      retries: z.number(),
      progress: z.string(),
    }),
  },
  actors: {
    // A bog-standard promise-shaped actor. Standalone it returns a canned
    // draft; the driving code replaces it with a model-backed one via
    // `machine.provide(...)`. The machine never mentions an LLM.
    writeDraft: createAsyncLogic<string, { topic: string; attempts: number }>({
      run: async ({ input }) =>
        input.attempts === 0
          ? `${input.topic}: a first draft.`
          : `${input.topic}: revised draft #${input.attempts}.`,
    }),
  },
}).createMachine({
  id: "plain-writer",
  context: ({ input }) => ({
    topic: input.topic,
    maxRevisions: MAX_REVISIONS,
    attempts: 0,
    retries: 0,
    maxRetries: MAX_RETRIES,
    draft: "",
    progress: "",
  }),
  output: ({ context }) => ({
    draft: context.draft,
    attempts: context.attempts,
    retries: context.retries,
    progress: context.progress,
  }),
  initial: "drafting",
  states: {
    // A normal invoke: its actor resolves to a value, which onDone stores.
    // A rejection is not the run's problem either — `onError` is an ordinary
    // transition, so a flaky model call is retried by the graph, not by a
    // try/catch buried in the actor.
    drafting: {
      invoke: {
        id: "writeDraft",
        src: "writeDraft",
        input: ({ context }) => ({ topic: context.topic, attempts: context.attempts }),
        onDone: ({ context, output }) => {
          const attempts = context.attempts + 1;
          return {
            target: "judging",
            context: {
              draft: output,
              attempts,
              progress: renderProgress({ ...context, attempts }),
            },
          };
        },
        // The retry budget, like the revision budget, is the machine's: past it
        // the transition targets `failed` instead of trying forever.
        onError: ({ context }) =>
          context.retries < context.maxRetries
            ? {
                target: "retrying",
                context: {
                  retries: context.retries + 1,
                  progress:
                    `Draft attempt failed: retrying ` +
                    `(${context.retries + 1} of ${context.maxRetries}).`,
                },
              }
            : {
                target: "failed",
                context: {
                  progress: `Draft failed after ${context.maxRetries} retries.`,
                },
              },
      },
    },
    // A retry is a state, so it is visible in the trace and re-enters
    // `drafting` — which re-invokes the actor, no manual re-run needed.
    retrying: {
      always: { target: "drafting" },
    },
    // A normal decision point: an event-waiting state with a guarded loop.
    // Nothing here knows the events will be chosen by a model.
    judging: {
      // Plain XState tags mark the human-wait state; hosts that want
      // deterministic idle pass runAgent({ isIdle: (s) => s.hasTag("waiting") }).
      tags: ["waiting"],
      on: {
        APPROVE: { target: "approved" },
        // The revision budget, expressed as an ordinary guarded transition:
        // over budget, it returns nothing and the transition is not taken, so
        // `snapshot.can({ type: "REVISE" })` returns false and only APPROVE
        // remains legal — the machine, not the model, enforces the bound.
        REVISE: ({ context }) =>
          context.attempts <= context.maxRevisions ? { target: "drafting" } : undefined,
      },
    },
    approved: { type: "final" },
    failed: { type: "final" },
  },
});

// ─── The driving code: adopt the plain machine as an agent ───

export interface PlainXstateResult {
  draft: string;
  /** Drafts produced (1 + number of accepted REVISEs). */
  attempts: number;
  /** Failed draft attempts the machine re-invoked. */
  retries: number;
  /** Readable tally of drafts, revisions, and retries. */
  progress: string;
  /** The chosen event type per judging round, in order. */
  decisions: string[];
}

export async function runPlainXstateExample(
  // Tests inject mocks; a direct run builds real executors from `models`.
  executors: Partial<AgentRequestExecutors> = createAiSdkExecutors({ models }),
  options: { topic?: string } = {},
): Promise<PlainXstateResult> {
  const { topic = "Statechart Studio, a visual workflow builder" } = options;
  const { generateText, decide } = executors;
  if (!generateText) throw new Error("runPlainXstateExample needs a 'generateText' executor.");
  if (!decide) throw new Error("runPlainXstateExample needs a 'decide' executor.");

  // 1. Bind the promise actor to a real model call — the machine graph is
  //    unchanged, only the actor implementation is swapped.
  const boundMachine = plainWriterMachine.provide({
    actors: {
      writeDraft: createAsyncLogic<string, { topic: string; attempts: number }>({
        run: async ({ input }) => {
          const result = await generateText({
            model: "writer",
            tools: {},
            system: "You are a concise product copywriter.",
            messages: [userMessage(draftPrompt(input))],
          });
          return String(result.output);
        },
      }),
    },
  });

  const actor = createActor(boundMachine, { input: { topic } });
  const decisions: string[] = [];
  actor.start();

  // 2. Drive the decisions. Whenever the machine settles somewhere that accepts
  //    events (its `judging` state), let the model choose one — gated by the
  //    machine's own guard via `snapshot.can`.
  for (;;) {
    const snapshot = await waitFor(
      actor,
      (state) => state.status === "done" || getAcceptedEvents(state).length > 0,
    );
    if (snapshot.status === "done") break;

    const events = getAcceptedEvents(snapshot); // [{ type: "APPROVE", toolName: "send_event_APPROVE" }, { type: "REVISE", toolName: "send_event_REVISE" }]
    const chosen = await resolveDecision<{ type: "APPROVE" } | { type: "REVISE" }>(
      {
        kind: "decision",
        id: "judge",
        model: "judge",
        system: "You are a strict editor.",
        prompt:
          "Judge this launch blurb. APPROVE if it is concrete and free of filler; " +
          `otherwise choose REVISE.\n\n${snapshot.context.draft}`,
        events,
        attempts: [],
      },
      { decide },
      // The guard, not the model, is the source of truth: a REVISE past the
      // budget is rejected here and the decision retries (converging to APPROVE).
      { canTake: (event) => snapshot.can(event) },
    );

    decisions.push(chosen.type);
    actor.send(chosen);
  }

  const settled = actor.getSnapshot();
  return {
    draft: settled.context.draft,
    attempts: settled.context.attempts,
    retries: settled.context.retries,
    progress: settled.context.progress,
    decisions,
  };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runPlainXstateExample();
    console.log("Decisions:", result.decisions.join(" → "));
    console.log(result.progress);
    console.log(`\nFinal draft (after ${result.attempts} draft(s)):\n${result.draft}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
