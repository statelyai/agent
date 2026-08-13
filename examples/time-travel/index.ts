/**
 * Time travel: checkpoint history, rewind, and fork over XState persisted
 * snapshots — LangGraph's time-travel how-to, expressed with the idle-first model.
 *
 * LangGraph exposes `graph.get_state_history(config)` (a list of checkpoints) and
 * lets you resume from any past checkpoint's `config` to rewind and fork an
 * alternative branch. Here the equivalent is dead simple: every `runAgent` settle
 * (`idle` or `done`) hands back a `snapshot`, and `machine.getPersistedSnapshot(...)`
 * turns it into plain JSON. Keep those persisted snapshots in a list and you have the
 * history; feed any one of them back into a fresh `runAgent` and you have a rewind.
 *
 * Because a persisted snapshot is immutable JSON, resuming from the SAME
 * checkpoint twice with DIFFERENT events yields two independent threads — that is
 * the fork. Nothing about the original run changes; the fork is a new lineage.
 *
 * The workflow (a draft-and-review loop with one idle human gate):
 *
 *   drafting → reviewing (idle) ─┬─ APPROVE → done
 *                                └─ REVISE { feedback } → drafting (bounded)
 *
 * The demo (mirrors the how-to):
 *   1. run to idle, checkpoint #1 (the first draft, awaiting review)
 *   2. resume with REVISE, run to idle, checkpoint #2 (the revised draft)
 *   3. approve #2 → the MAIN branch's final answer (the revised draft)
 *   4. REWIND to checkpoint #1 and FORK: resume it with APPROVE instead — a second
 *      thread that approves the ORIGINAL draft. Its final answer diverges, and the
 *      main branch's checkpoints and outcome are untouched.
 *
 * `CheckpointHistory` is in-example code (a list of `{ label, snapshot }`), NOT a
 * library API — it just shows the pattern of capturing each settle.
 *
 * Dual-mode: `runTimeTravelExample(options?)` takes an injectable `generateText`
 * (tests pass a deterministic mock — keyless CI); the direct run uses a real model.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/time-travel/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";
import type { Snapshot, SnapshotFrom } from "xstate";

export const models = defineModels({
  writer: openai("gpt-5.4-mini"),
});

const contextSchema = z.object({
  question: z.string(),
  draft: z.string().nullable(),
  // Feedback from the last REVISE, folded into the next draft; null on first pass.
  feedback: z.string().nullable(),
  // Bounded redraft loop: REVISE is legal only while revisions < maxRevisions.
  revisions: z.number(),
  maxRevisions: z.number(),
});

// Typed interaction meta for the idle review gate: the pause's `label`, a
// button `label`/`style` per accepted event, and `textEvent` naming the ONE
// event free-typed text is delivered to.
const metaSchema = z.object({
  interaction: z
    .object({
      label: z.string(),
      events: z
        .record(
          z.string(),
          z.object({
            label: z.string().optional(),
            style: z.enum(["primary", "danger", "default"]).optional(),
          }),
        )
        .optional(),
      textEvent: z.string().optional(),
    })
    .optional(),
});

const agentSetup = setupAgent({
  models,
  meta: metaSchema,
  context: contextSchema,
  input: z.object({ question: z.string(), maxRevisions: z.number() }),
  output: z.object({ answer: z.string(), revisions: z.number() }),
  events: {
    APPROVE: z.object({}),
    REVISE: z.object({ feedback: z.string() }),
  },
  // The machine's own wait signal: `runAgent` settles idle deterministically
  // whenever a resting snapshot carries this tag (see human-in-the-loop.md).
  isIdle: (snapshot) => snapshot.hasTag("awaiting-review"),
  requests: {
    writeDraft: {
      schemas: {
        input: z.object({ question: z.string(), feedback: z.string().nullable() }),
        output: z.string(),
      },
      model: "writer",
      system:
        "You answer the question in one or two clear sentences. If a revision note " +
        "is present, apply it. Return only the answer text.",
      prompt: ({ input }) =>
        input.feedback
          ? `Question: ${input.question}\nRevision requested: ${input.feedback}`
          : `Question: ${input.question}`,
    },
  },
  // `drafting`'s onDone sets `draft` before every path into `reviewing` (a REVISE
  // loops back through drafting, which re-sets it) — narrow it non-null there and
  // in `done`, which reads it as the final answer.
  states: {
    reviewing: { context: { draft: z.string() } },
    done: { context: { draft: z.string() } },
  },
});

export const timeTravelSchemas = agentSetup.schemas;

export const timeTravelMachine = agentSetup.createMachine({
  id: "time-travel",
  context: ({ input }) => ({
    question: input.question,
    draft: null,
    feedback: null,
    revisions: 0,
    maxRevisions: input.maxRevisions,
  }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ question: context.question, feedback: context.feedback }),
        onDone: ({ output }) => ({ target: "reviewing", context: { draft: output } }),
      },
    },
    // No invoke: runAgent settles idle and waits for APPROVE or REVISE. The
    // redraft loop is bounded by the revision budget (function-form guard): once
    // spent, REVISE stops redrafting and stays for review, leaving only APPROVE.
    reviewing: {
      tags: ["awaiting-review"],
      meta: {
        interaction: {
          // `{revisions}` / `{maxRevisions}` resolve against context when shown.
          label:
            "Approve this answer, or type the revision you want " +
            "({revisions} of {maxRevisions} revisions used).",
          events: {
            APPROVE: { label: "Approve answer", style: "primary" },
            REVISE: { label: "Request a revision", style: "danger" },
          },
          // Without this, free text would silently REVISE (its `feedback` is
          // the only single-string payload here).
          textEvent: "REVISE",
        },
      },
      on: {
        APPROVE: { target: "done" },
        REVISE: ({ context, event }) =>
          context.revisions < context.maxRevisions
            ? {
                target: "drafting",
                context: { feedback: event.feedback, revisions: context.revisions + 1 },
              }
            : { target: "reviewing" },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ answer: context.draft, revisions: context.revisions }),
    },
  },
});

// ─── In-example checkpoint history (NOT a library API) ───
//
// A list of `{ label, snapshot }`, one per settle. Each snapshot is captured via
// `machine.getPersistedSnapshot(...)` (plain JSON), so entries are immutable and independent
// of the live run — the same guarantee a real persistence layer gives you.
export interface Checkpoint {
  label: string;
  snapshot: Snapshot<unknown>;
}

export class CheckpointHistory {
  private entries: Checkpoint[] = [];

  /** Capture a settle's snapshot as an immutable, persisted checkpoint. */
  record(label: string, snapshot: SnapshotFrom<typeof timeTravelMachine>): void {
    this.entries.push({ label, snapshot: timeTravelMachine.getPersistedSnapshot(snapshot) });
  }

  /** The checkpoint at `index` — the point you rewind/fork from. */
  at(index: number): Checkpoint {
    const entry = this.entries[index];
    if (!entry) throw new Error(`No checkpoint at index ${index}.`);
    return entry;
  }

  get labels(): string[] {
    return this.entries.map((entry) => entry.label);
  }
}

export interface RunTimeTravelOptions {
  question?: string;
  feedback?: string;
  maxRevisions?: number;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
}

export interface TimeTravelResult {
  checkpointLabels: string[];
  /** Main branch: approved the REVISED draft. */
  mainAnswer: string;
  mainRevisions: number;
  /** Forked branch: rewound to checkpoint #1, approved the ORIGINAL draft. */
  forkedAnswer: string;
  forkedRevisions: number;
  rewoundFrom: string;
}

/**
 * Drafts, revises, and approves along a MAIN branch, checkpointing each settle;
 * then rewinds to the first checkpoint and FORKS a second thread that approves the
 * original draft instead. Returns both branches' final answers plus the history.
 */
export async function runTimeTravelExample(
  options: RunTimeTravelOptions = {},
): Promise<TimeTravelResult> {
  const {
    question = "What is an XState actor?",
    feedback = "Add a concrete, code-free analogy.",
    maxRevisions = 2,
    generateText,
  } = options;
  const executors = generateText
    ? { executors: { generateText } }
    : { executors: createAiSdkExecutors({ models }) };
  const history = new CheckpointHistory();

  // 1. Run to idle at review. Checkpoint the first draft.
  const first = await runAgent(timeTravelMachine, {
    input: { question, maxRevisions },
    ...executors,
  });
  if (first.status !== "idle") throw new Error(`Expected idle, got '${first.status}'.`);
  history.record("draft-1 · awaiting review", first.snapshot);

  // 2. Resume with REVISE, redraft, settle idle again. Checkpoint the revised draft.
  const second = await runAgent(timeTravelMachine, {
    snapshot: first.persistedSnapshot,
    event: { type: "REVISE", feedback },
    ...executors,
  });
  if (second.status !== "idle") throw new Error(`Expected idle, got '${second.status}'.`);
  history.record("draft-2 · awaiting review", second.snapshot);

  // 3. Approve the revised draft → the MAIN branch's final answer.
  const mainDone = await runAgent(timeTravelMachine, {
    snapshot: second.persistedSnapshot,
    event: { type: "APPROVE" },
    ...executors,
  });
  if (mainDone.status !== "done") throw new Error(`Expected done, got '${mainDone.status}'.`);
  history.record("draft-2 · approved", mainDone.snapshot);

  // 4. REWIND + FORK: take checkpoint #1 and resume it with APPROVE instead. A
  //    fresh persist keeps the stored checkpoint immutable, so the main branch
  //    above is untouched — this is a new lineage that approves the ORIGINAL draft.
  const rewindTo = history.at(0);
  const forkedDone = await runAgent(timeTravelMachine, {
    snapshot: rewindTo.snapshot,
    event: { type: "APPROVE" },
    ...executors,
  });
  if (forkedDone.status !== "done") throw new Error(`Expected done, got '${forkedDone.status}'.`);

  return {
    checkpointLabels: history.labels,
    mainAnswer: mainDone.output.answer,
    mainRevisions: mainDone.output.revisions,
    forkedAnswer: forkedDone.output.answer,
    forkedRevisions: forkedDone.output.revisions,
    rewoundFrom: rewindTo.label,
  };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runTimeTravelExample();

    console.log("Checkpoint history:");
    for (const label of result.checkpointLabels) console.log(`  • ${label}`);

    console.log(`\nMain branch (approved revision #${result.mainRevisions}):`);
    console.log(`  ${result.mainAnswer}`);

    console.log(
      `\nForked from "${result.rewoundFrom}" (approved revision #${result.forkedRevisions}):`,
    );
    console.log(`  ${result.forkedAnswer}`);

    console.log("\nThe two branches diverge; the main branch's checkpoints are unchanged.");
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
