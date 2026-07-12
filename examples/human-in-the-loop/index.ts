/**
 * Human-in-the-loop: draft → idle review → APPROVE / REJECT redraft, with a
 * JSON snapshot round-trip across two `runAgent` calls.
 *
 * Demonstrates:
 *   - An *idle* review state: `reviewing` has no invoke, so `runAgent` settles
 *     `{ status: 'idle', snapshot }` instead of hanging — the machine is
 *     waiting on a human, not on work.
 *   - Typed `meta.interaction` on the idle state for the label; legal events
 *     are inferred from the idle snapshot with `getAcceptedEvents(...)`.
 *   - REJECT-with-reason redraft loop: rejecting feeds the reason back into the
 *     next draft; APPROVE publishes.
 *   - Snapshot persistence: the idle snapshot survives `JSON.parse(JSON.stringify(...))`
 *     and resumes in a *second* `runAgent` call — the same machine, one more event.
 *
 * The `generateText` executor is injectable so tests can drive the machine with
 * a mock; on direct run it uses a real model.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/human-in-the-loop/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { defineModels } from "../../src/ai-sdk/index.js";
import {
  getAcceptedEvents,
  getStateMeta,
  persistSnapshot,
  runAgent,
  setupAgent,
  WAIT_TAG,
  type AgentRequestExecutors,
} from "../../src/index.js";
import { resolveExecutors, runExampleMain } from "../helpers/main.js";

export const models = defineModels({
  writer: openai("gpt-5.4-mini"),
});

const interactionSchema = z.object({
  label: z.string(),
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
  meta: z.object({ interaction: interactionSchema.optional() }),
  events: {
    APPROVE: z.object({}),
    REJECT: z.object({ reason: z.string() }),
  },
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
  // The only path into `published` is reviewing's APPROVE, reached only after
  // drafting's onDone has already set `draft` — guaranteed non-null there.
  states: {
    drafting: {},
    // Both reviewing and published are only reachable after drafting's onDone
    // set `draft`; narrowing reviewing lets its bare APPROVE target satisfy
    // published's narrowed context.
    reviewing: { schemas: { context: contextSchema.extend({ draft: z.string() }) } },
    published: { schemas: { context: contextSchema.extend({ draft: z.string() }) } },
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
      tags: [WAIT_TAG],
      meta: {
        interaction: {
          label: "Review the draft: approve to publish, or reject with a reason.",
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
      output: ({ context }) => ({
        published: true,
        draft: context.draft,
      }),
    },
  },
});

export interface RunHumanInTheLoopOptions {
  topic?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Direct run passes this to narrate state; tests leave it undefined (quiet). */
  onTransition?: (snapshot: { value: unknown }) => void;
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
  const { topic = "the new deploy pipeline", generateText, onTransition } = options;

  // Phase 1: draft, then settle idle at `reviewing`.
  const first = await runAgent(humanInTheLoopMachine, {
    input: { topic },
    ...resolveExecutors(models, generateText ? { generateText } : undefined),
    ...(onTransition ? { onTransition } : {}),
  });

  if (first.status !== "idle") {
    throw new Error(`Expected idle review state, got '${first.status}'.`);
  }

  const draft = first.snapshot.context.draft ?? "";
  const { interaction } = getStateMeta(first.snapshot);
  const legalEvents = getAcceptedEvents(first.snapshot).map((event) => event.type);

  // Persist: prove the idle snapshot survives a real JSON persistence layer.
  const persisted = persistSnapshot(first.snapshot);

  // Phase 2: ...later, new process, human approved. Same machine, one event.
  const second = await runAgent(humanInTheLoopMachine, {
    snapshot: persisted,
    event: { type: "APPROVE" },
    ...resolveExecutors(models, generateText ? { generateText } : undefined),
    ...(onTransition ? { onTransition } : {}),
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

runExampleMain(import.meta.url, async () => {
  const result = await runHumanInTheLoopExample({
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });

  console.log("--- Phase 1: idle review ---");
  console.log("Draft:", result.draft);
  console.log("Prompt to human:", result.interactionLabel);
  console.log("Legal events:", result.legalEvents.join(", "));
  console.log("\n--- Phase 2: resumed with APPROVE ---");
  console.log("Published:", result.published);
  console.log("Final draft:", result.publishedDraft);
});
