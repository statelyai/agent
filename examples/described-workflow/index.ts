/**
 * Described workflow — a plain XState machine (no setupAgent), run as an agent
 * via runAgent's `getRequests` option.
 *
 * `getRequests` is the override to runAgent's default invoke-driven contract:
 * whenever the machine would otherwise settle idle, the hook reads the
 * snapshot and returns the model request(s) to run. WHERE the prompts live is
 * entirely the hook's business — this example's recipe reads each active
 * node's `description` as the prompt, `meta.role` as the system voice, and
 * uses tags for waiting/decision states. Copy `getRequests` below and adapt
 * it; nothing about it is blessed by the library.
 *
 * Each writing step keeps its prompt in the state `description` AND produces
 * its artifact there, invoking the shared `write` text actor and storing the
 * result in context (`outline`, `draft`). So a host that does NOT pass
 * `getRequests` — the demo UI, say — still reaches the judging gate with a
 * real outline and draft to show: nobody is asked to approve work that was
 * never written. `getRequests` then interprets the one state that stays idle,
 * the `decision`-tagged `judging` gate, from its own description.
 *
 * The run's working memory is the message log runAgent aggregates across
 * requests and stamps onto the settled `snapshot.messages`.
 *
 * Flow: outline → draft (loops back on REVISE) → judge (decision state) →
 * complete.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/described-workflow/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { setup, type AnyMachineSnapshot } from "xstate";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  createTextLogic,
  getAgentMessages,
  getSnapshotNodes,
  runAgent,
  type AgentMessage,
  type AgentRequestExecutors,
  type AgentStateRequest,
} from "@statelyai/agent";

const models = defineModels({
  writer: openai("gpt-5.4-mini"),
});

// The prompts, once: each is a state's `description` (what `getRequests`
// reads) and the same string the state's own model call sends.
const WORKFLOW =
  "A workflow that writes a short launch blurb for a developer tool called Statechart Studio.";

const OUTLINE_PROMPT =
  "List the three most compelling selling points of the product for working engineers. " +
  "One line each.";

const DRAFT_PROMPT =
  "Using the selling points above, write the launch blurb: two sentences, no buzzwords, " +
  "confident but plain. Return only the blurb.";

const JUDGE_PROMPT =
  "Judge the latest blurb. APPROVE it only if it is concrete and free of filler; " +
  "otherwise ask for one revision.";

const COPYWRITER = "Senior product copywriter";

/**
 * One reusable text actor — a plain `createTextLogic`, no setupAgent. The
 * writing states invoke it with their own description as the prompt, so the
 * artifacts exist in context whether or not the host passes `getRequests`.
 */
const write = createTextLogic({
  schemas: {
    input: z.object({ system: z.string(), prompt: z.string() }),
    output: z.string(),
  },
  model: "writer",
  system: ({ input }) => input.system,
  prompt: ({ input }) => input.prompt,
});

export const describedWorkflowMachine = setup({ actors: { write } }).createMachine({
  id: "productBlurb",
  description: WORKFLOW,
  schemas: {
    meta: z.object({ role: z.string().optional() }),
  },
  context: {
    outline: null as string | null,
    draft: null as string | null,
  },
  initial: "outlining",
  states: {
    outlining: {
      description: OUTLINE_PROMPT,
      invoke: {
        src: "write",
        input: () => ({ system: WORKFLOW, prompt: OUTLINE_PROMPT }),
        onDone: ({ output }) => ({
          target: "drafting",
          context: { outline: output },
        }),
      },
    },
    drafting: {
      description: DRAFT_PROMPT,
      meta: { role: COPYWRITER },
      invoke: {
        src: "write",
        // The description is the instruction; context supplies the material
        // (and, on the REVISE loop, the draft being replaced).
        input: ({ context }) => ({
          system: `${WORKFLOW}\n\n${COPYWRITER}`,
          prompt: [
            DRAFT_PROMPT,
            `Selling points:\n${context.outline ?? ""}`,
            context.draft ? `Rewrite this draft, it was sent back:\n${context.draft}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        }),
        onDone: ({ output }) => ({
          target: "judging",
          context: { draft: output },
        }),
      },
    },
    judging: {
      description: JUDGE_PROMPT,
      // No invoke: the run settles idle here. `getRequests` turns the
      // description into a `decide` call; a host without it (the demo) shows
      // the outline and draft from context and lets a human choose.
      tags: ["decision"],
      on: {
        APPROVE: { target: "complete" },
        REVISE: { target: "drafting" },
      },
    },
    complete: {
      type: "final",
      output: ({ context }) => ({
        outline: context.outline ?? "",
        draft: context.draft ?? "",
      }),
    },
  },
});

/**
 * The recipe: prompts-in-descriptions. One request per active described
 * state — `description` is the prompt, the root machine's `description` +
 * `meta.role` form the system voice, a `waiting` tag settles idle for a
 * human, and a `decision` tag skips the text call. Advancement is explicit
 * per request: a state with exactly one outcome names it via `onDone`
 * (deterministic, no model call — a heuristic THIS recipe chose, not the
 * library); anything else falls back to a `decide` call scoped to the
 * node's own events. States that invoke their own model call never settle
 * idle, so this hook never sees them.
 */
export const getRequests = (snapshot: AnyMachineSnapshot): AgentStateRequest[] => {
  const [root, ...descendants] = getSnapshotNodes(snapshot);
  const rootDescription = root?.description;
  return descendants
    .filter((node) => node.description && !node.tags.includes("waiting"))
    .map((node) => ({
      model: "writer",
      prompt: node.description!,
      system: [rootDescription, (node.meta as { role?: string } | undefined)?.role]
        .filter(Boolean)
        .join("\n\n"),
      kind: node.tags.includes("decision") ? "decision" : "text",
      onDone: node.ownEvents.length === 1 ? { type: node.ownEvents[0]! } : undefined,
      allowedEvents: node.ownEvents,
    }));
};

export async function runDescribedWorkflowExample(
  // Tests inject mocks; a direct run builds real executors from `models`.
  executors: Partial<AgentRequestExecutors> = createAiSdkExecutors({ models }),
): Promise<{ outline: string; draft: string; messages: AgentMessage[] }> {
  const result = await runAgent(describedWorkflowMachine, {
    getRequests,
    executors,
    // Live view of the log: fires the moment each message is appended, so
    // nothing waits for the run to settle.
    onMessage: (message) => console.log(`[${message.role}] ${String(message.content)}\n`),
  });

  if (result.status !== "done") {
    throw new Error(`Run did not complete: ${result.status}`);
  }

  const output = result.output as { outline: string; draft: string };
  return {
    ...output,
    // The same log, read off the settled (persistable) snapshot.
    messages: getAgentMessages(result.snapshot),
  };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { draft } = await runDescribedWorkflowExample();
    console.log(`Blurb:\n${draft}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
