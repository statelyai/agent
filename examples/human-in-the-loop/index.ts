/**
 * Human-in-the-loop: draft → idle review → APPROVE / REJECT redraft, with a
 * JSON snapshot round-trip across every `runAgent` call.
 *
 * Demonstrates:
 *   - An *idle* review state: `reviewing` has no invoke, so `runAgent` settles
 *     `{ status: 'idle', snapshot }` instead of hanging — the machine is
 *     waiting on a human, not on work.
 *   - Typed `meta.interaction` on the idle state for the label; legal events
 *     are inferred from the idle snapshot with `getAcceptedEvents(...)`.
 *   - REJECT-with-reason redraft loop: rejecting feeds the reason back into the
 *     next draft; APPROVE publishes.
 *   - Snapshot persistence: each idle settle hands back a `persistedSnapshot`
 *     (a JSON round-trip) and resumes in the *next* `runAgent` call.
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
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  getAcceptedEvents,
  getStateMeta,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

export const models = defineModels({
  writer: openai("gpt-5.4-mini"),
});

const contextSchema = z.object({
  topic: z.string(),
  draft: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ topic: z.string() }),
  output: z.object({ published: z.boolean(), draft: z.string() }),
  // Typed interaction meta: the pause's `label`, a button `label`/`style` per
  // accepted event, and `textEvent` naming the ONE event free-typed text is
  // delivered to.
  meta: z.object({
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
  }),
  events: {
    APPROVE: z.object({}),
    REJECT: z.object({ reason: z.string() }),
  },
  // This machine declares its own wait signal: a tag it chose. runAgent settles
  // idle deterministically whenever a resting snapshot carries it (no timing
  // heuristic). A host could override this per-run via runAgent({ isIdle }).
  isIdle: (snapshot) => snapshot.hasTag("awaiting-review"),
  requests: {
    writeDraft: {
      schemas: {
        input: z.object({ topic: z.string() }),
        output: z.string(),
      },
      model: "writer",
      system: "You write short, punchy internal announcements — two or three sentences.",
      prompt: ({ input }) => `Write a short announcement about: ${input.topic}`,
    },
  },
  // `reviewing` and `published` are reachable only after drafting's onDone set
  // `draft`; narrowing it to non-null lets reviewing's bare APPROVE target
  // satisfy published's narrowed context.
  states: {
    reviewing: { context: { draft: z.string() } },
    published: { context: { draft: z.string() } },
  },
});

export const humanInTheLoopMachine = agentSetup.createMachine({
  id: "human-in-the-loop",
  context: ({ input }) => ({ topic: input.topic, draft: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({
          target: "reviewing",
          context: { draft: output },
        }),
      },
    },
    // No invoke here: runAgent settles idle and waits for a human event.
    // `meta.interaction` tells the host what to show; legal events come from
    // `getAcceptedEvents(snapshot)`.
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
        REJECT: ({ context, event }) => ({
          target: "drafting",
          context: {
            topic: `${context.topic}\nRevision requested: ${event.reason}`,
          },
        }),
      },
    },
    published: {
      type: "final",
      output: ({ context }) => ({ published: true, draft: context.draft }),
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
  publishedDraft: string;
}

/**
 * Drafts, pauses idle for review, persists the snapshot via a JSON round-trip,
 * then resumes with APPROVE in a second `runAgent` call. Returns both phases.
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
  const { interaction } = getStateMeta(first.snapshot);
  const legalEvents = getAcceptedEvents(first.snapshot).map((event) => event.type);

  // Phase 2: ...later, new process, human approved. Same machine, one event,
  // resumed from the persisted (JSON-round-tripped) snapshot.
  const second = await runAgent(humanInTheLoopMachine, {
    snapshot: first.persistedSnapshot,
    event: { type: "APPROVE" },
    ...executors,
  });
  if (second.status !== "done") {
    throw new Error(`Expected done after APPROVE, got '${second.status}'.`);
  }

  return {
    draft,
    interactionLabel: interaction?.label,
    legalEvents,
    published: second.output.published,
    publishedDraft: second.output.draft,
  };
}

// Direct run: a real interactive review loop. Each iteration settles idle at
// `reviewing`, prints the draft, and asks the human. REJECT feeds a reason back
// into a fresh draft (loop again); APPROVE publishes. Every resume is fed a
// persisted snapshot, so the JSON round-trip is exercised on each turn.
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
    const executors = { executors: createAiSdkExecutors({ models }) };
    let result = await runAgent(humanInTheLoopMachine, {
      input: { topic: "the new deploy pipeline" },
      ...executors,
    });

    while (result.status === "idle") {
      const snapshot = result.snapshot;
      const { interaction } = getStateMeta(snapshot);
      const legalEvents = getAcceptedEvents(snapshot).map((event) => event.type);

      console.log("\n--- Draft for review ---");
      console.log(snapshot.context.draft ?? "");
      console.log("\n" + (interaction?.label ?? ""));
      console.log("Legal events:", legalEvents.join(", "));

      const persisted = result.persistedSnapshot;
      const answer = (await promptLine("approve / reject? ")).toLowerCase();

      if (answer.startsWith("a")) {
        result = await runAgent(humanInTheLoopMachine, {
          snapshot: persisted,
          event: { type: "APPROVE" },
          ...executors,
        });
        break;
      }

      const reason = await promptLine("Reason for rejection: ");
      result = await runAgent(humanInTheLoopMachine, {
        snapshot: persisted,
        event: { type: "REJECT", reason },
        ...executors,
      });
    }

    if (result.status !== "done") {
      throw new Error(`Expected done after APPROVE, got '${result.status}'.`);
    }
    console.log("\n--- Published ---");
    console.log(result.output.draft);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
