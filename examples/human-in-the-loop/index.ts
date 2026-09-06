/**
 * Human-in-the-loop: draft → idle review → APPROVE / REJECT redraft, with a
 * real JSON snapshot round-trip between `runAgent` calls.
 *
 * Demonstrates:
 *   - An *idle* review state: `reviewing` has no invoke, so `runAgent` settles
 *     `{ status: 'idle', snapshot }` instead of hanging — the machine is
 *     waiting on a human, not on work.
 *   - `meta.interaction` typed by the library's own `interactionMetaSchema`,
 *     read back with `getInteraction(snapshot)`, which filters the choices
 *     through the events the machine currently accepts.
 *   - A REJECT-with-feedback redraft loop, bounded by `MAX_REJECTIONS`: the
 *     first rejections redraft, the one past the budget ends the run in
 *     `abandoned`. APPROVE publishes. The loop cannot run forever and no
 *     answer is silently swallowed.
 *   - Snapshot persistence: the idle settle's `persist()` result is
 *     `JSON.parse(JSON.stringify(...))`-ed and resumed in the *next*
 *     `runAgent` call.
 *
 * Two entry points:
 *   - `runHumanInTheLoopExample(options)` — compact, test-facing: draft → idle →
 *     persist → resume with APPROVE. The `generateText` executor is injectable
 *     so keyless tests drive it with a mock.
 *   - Direct run (`tsx examples/human-in-the-loop/index.ts`) — a real
 *     interactive CLI loop: it prints each draft, asks you to approve or reject
 *     (with a reason), and re-runs the machine until you approve.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/human-in-the-loop/index.ts
 */
import { z } from "zod";
import type { Snapshot } from "xstate";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  eventFromInteraction,
  getInteraction,
  interactionMetaSchema,
  isAgentIdle,
  runAgent,
  runAgentLoop,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

/** Rejections allowed before the review loop gives up. */
export const MAX_REJECTIONS = 2;

export const models = defineModels({
  writer: openai("gpt-5.4-mini"),
});

const contextSchema = z.object({
  topic: z.string(),
  draft: z.string().nullable(),
  /** The last rejection's text, fed back into the next draft. */
  feedback: z.string().nullable(),
  /** Rejections used so far; bounds the reviewing → drafting loop. */
  rejections: z.number(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ topic: z.string() }),
  // `draft` is nullable because `abandoned` is also where a failed first draft
  // lands, and there is no draft to report then.
  output: z.object({ published: z.boolean(), draft: z.string().nullable() }),
  // The library's own interaction meta — a `label`, a button `label`/`style`
  // per accepted event, and `textEvent` naming the ONE event free-typed text
  // is delivered to — instead of restating that shape per machine.
  meta: interactionMetaSchema,
  events: {
    APPROVE: z.object({}),
    // `text` is the field `eventFromInteraction(snapshot, { text })` fills in
    // for a state's declared `textEvent`.
    REJECT: z.object({ text: z.string() }),
  },
  // Most machines need no predicate: event-handling states are structurally
  // idle. This deliberately demonstrates extending—not replacing—the default.
  isIdle: (snapshot) => isAgentIdle(snapshot) || snapshot.hasTag("awaiting-review"),
  requests: {
    writeDraft: {
      schemas: {
        input: z.object({ topic: z.string(), feedback: z.string().nullable() }),
        output: z.string(),
      },
      model: "writer",
      system: "You write short, punchy internal announcements — two or three sentences.",
      // The prompt is composed here, from durable facts. Context stores the
      // topic and the last feedback, never the rendered prompt.
      prompt: ({ input }) =>
        input.feedback === null
          ? `Write a short announcement about: ${input.topic}`
          : `Write a short announcement about: ${input.topic}\nRevision requested: ${input.feedback}`,
    },
  },
  // `reviewing` and `published` are reachable only after drafting's onDone set
  // `draft`; narrowing it to non-null lets reviewing's bare APPROVE target
  // satisfy published's narrowed context. `abandoned` is not narrowed: a failed
  // first draft reaches it with no draft at all.
  states: {
    reviewing: { schemas: { context: contextSchema.extend({ draft: z.string() }) } },
    published: { schemas: { context: contextSchema.extend({ draft: z.string() }) } },
  },
});

export const humanInTheLoopMachine = agentSetup.createMachine({
  id: "human-in-the-loop",
  context: ({ input }) => ({
    topic: input.topic,
    draft: null,
    feedback: null,
    rejections: 0,
  }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ topic: context.topic, feedback: context.feedback }),
        onDone: ({ output }) => ({
          target: "reviewing",
          context: { draft: output },
        }),
        onError: ({ event }) => ({
          target: "abandoned",
          context: { feedback: `writeDraft failed: ${String(event.error)}` },
        }),
      },
    },
    // No invoke here: runAgent settles idle and waits for a human event.
    // `getInteraction(snapshot)` tells the host what to show, filtered through
    // the events the machine currently accepts.
    reviewing: {
      tags: ["awaiting-review"],
      meta: {
        interaction: {
          label: "Approve the draft to publish it, or type what you want changed.",
          events: {
            APPROVE: { label: "Approve draft", style: "primary" },
            REJECT: { label: "Request changes", style: "danger" },
          },
          // Without this, a host that maps free text to "the only event with a
          // single string field" would silently REJECT whatever you typed.
          textEvent: "REJECT",
        },
      },
      on: {
        APPROVE: { target: "published" },
        // The budget is a counter in context compared to a constant, checked
        // in the transition itself: the first MAX_REJECTIONS rejections redraft,
        // the next one ends the run in `abandoned`. The loop cannot run forever
        // and nothing silently swallows the human's answer.
        REJECT: ({ context, event }) =>
          context.rejections >= MAX_REJECTIONS
            ? { target: "abandoned", context: { feedback: event.text } }
            : {
                target: "drafting",
                context: {
                  feedback: event.text,
                  rejections: context.rejections + 1,
                },
              },
      },
    },
    published: {
      type: "final",
      output: ({ context }) => ({ published: true, draft: context.draft }),
    },
    // A distinct final state, not `published: false` smuggled out of the happy
    // path: the review budget ran out, or drafting errored.
    abandoned: {
      type: "final",
      output: ({ context }) => ({ published: false, draft: context.draft }),
    },
  },
});

export interface RunHumanInTheLoopOptions {
  topic?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
}

export interface HumanInTheLoopResult {
  draft: string;
  interactionLabel: string | undefined;
  legalEvents: string[];
  published: boolean;
  publishedDraft: string | null;
  /** Drafts produced: 1 plus the number of rejections that were accepted. */
  drafts: number;
}

/**
 * Drafts, pauses idle for review, rejects once with feedback, then approves —
 * each resume from a snapshot that really went through `JSON.stringify` and
 * back, as it would if it had been stored in a row between HTTP requests.
 */
export async function runHumanInTheLoopExample(
  options: RunHumanInTheLoopOptions = {},
): Promise<HumanInTheLoopResult> {
  const { topic = "the new deploy pipeline", generateText } = options;
  const executors = generateText
    ? { executors: { generateText } }
    : { executors: createAiSdkExecutors({ models }) };

  // Phase 1: draft, then settle idle at `reviewing`.
  const first = await runAgent(humanInTheLoopMachine, { input: { topic }, ...executors });
  if (first.status !== "idle") {
    throw new Error(`Expected idle review state, got '${first.status}'.`);
  }

  const draft = first.snapshot.context.draft ?? "";
  const interaction = getInteraction(first.snapshot);
  const legalEvents = interaction?.events.map(({ type }) => type) ?? [];

  // Phase 2: ...later, new process. The human wants a change. The snapshot
  // really goes through JSON — that is the whole persistence claim.
  const second = await runAgent(humanInTheLoopMachine, {
    snapshot: roundTrip(first.persist()),
    event: eventFromInteraction(first.snapshot, { text: "Mention the rollback plan." }),
    ...executors,
  });
  if (second.status !== "idle") {
    throw new Error(`Expected a second review pause, got '${second.status}'.`);
  }

  // Phase 3: approve the revised draft, again across a JSON round-trip.
  const third = await runAgent(humanInTheLoopMachine, {
    snapshot: roundTrip(second.persist()),
    event: eventFromInteraction(second.snapshot, { type: "APPROVE" }),
    ...executors,
  });
  if (third.status !== "done") {
    throw new Error(`Expected done after APPROVE, got '${third.status}'.`);
  }

  return {
    draft,
    interactionLabel: interaction?.label,
    legalEvents,
    published: third.output.published,
    publishedDraft: third.output.draft,
    drafts: second.snapshot.context.rejections + 1,
  };
}

/** Serialize and revive a persisted snapshot, as a database row would. */
function roundTrip(snapshot: Snapshot<unknown>): Snapshot<unknown> {
  return JSON.parse(JSON.stringify(snapshot)) as Snapshot<unknown>;
}

// Direct run: runAgentLoop drives a real interactive review. Each idle pause
// renders the machine's interaction metadata and returns a validated event.
/** Prompt once on stdin and resolve the trimmed reply. */
async function promptLine(query: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runAgentLoop(humanInTheLoopMachine, {
      input: { topic: "the new deploy pipeline" },
      executors: createAiSdkExecutors({ models }),
      onIdle: async ({ snapshot }) => {
        const interaction = getInteraction(snapshot);
        console.log("\n--- Draft for review ---");
        console.log(snapshot.context.draft ?? "");
        console.log("\n" + (interaction?.label ?? ""));
        console.log("Legal events:", interaction?.events.map(({ type }) => type).join(", "));

        const answer = (await promptLine("approve / reject? ")).toLowerCase();
        if (answer.startsWith("a")) {
          // Typed off the snapshot: the machine's own event union, no cast.
          return eventFromInteraction(snapshot, { type: "APPROVE" });
        }
        const text = await promptLine("What should change? ");
        return eventFromInteraction(snapshot, { text });
      },
    });

    if (result.status !== "done") {
      throw new Error(`Expected a final state, got '${result.status}'.`);
    }
    console.log(result.output.published ? "\n--- Published ---" : "\n--- Abandoned ---");
    console.log(result.output.draft);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
