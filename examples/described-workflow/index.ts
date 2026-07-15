/**
 * Described workflow — a PLAIN XState machine, no invokes, no setupAgent,
 * run as an agent via runAgent's `getRequests` option.
 *
 * `getRequests` is the override to runAgent's default invoke-driven contract:
 * whenever the machine would otherwise settle idle, the hook reads the
 * snapshot and returns the model request(s) to run. WHERE the prompts live is
 * entirely the hook's business — this example's recipe reads each active
 * node's `description` as the prompt, `meta.role` as the system voice, and
 * uses tags for waiting/decision states. Copy `getRequests` below and adapt
 * it; nothing about it is blessed by the library.
 *
 * The run's working memory is the message log runAgent aggregates across
 * requests and stamps onto the settled `snapshot.messages` (context stays
 * empty here on purpose — the machine is pure control flow + prose).
 *
 * Flow: outline → draft (loops back on REVISE) → judge (decision state) →
 * complete.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/described-workflow/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createMachine, type AnyMachineSnapshot } from "xstate";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import {
  getAgentMessages,
  runAgent,
  type AgentRequestExecutors,
  type AgentStateRequest,
} from "../../src/index.js";
import { runExampleMain } from "../helpers/main.js";

const models = defineModels({
  writer: openai("gpt-5.4-mini"),
});

export const describedWorkflowMachine = createMachine({
  id: "productBlurb",
  description:
    "A workflow that writes a short launch blurb for a developer tool called Statechart Studio.",
  schemas: {
    meta: z.object({ role: z.string().optional() }),
  },
  initial: "outlining",
  states: {
    outlining: {
      description:
        "List the three most compelling selling points of the product for working engineers. " +
        "One line each.",
      on: { OUTLINED: { target: "drafting" } },
    },
    drafting: {
      description:
        "Using the selling points above, write the launch blurb: two sentences, no buzzwords, " +
        "confident but plain. Return only the blurb.",
      meta: { role: "Senior product copywriter" },
      on: { DRAFTED: { target: "judging" } },
    },
    judging: {
      description:
        "Judge the latest blurb. APPROVE it only if it is concrete and free of filler; " +
        "otherwise ask for one revision.",
      tags: ["decision"],
      on: {
        APPROVE: { target: "complete" },
        REVISE: { target: "drafting" },
      },
    },
    complete: { type: "final" },
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
 * node's own events.
 */
export const getRequests = (snapshot: AnyMachineSnapshot): AgentStateRequest[] => {
  const rootDescription = snapshot._nodes.find((node) => !node.parent)?.description;
  return snapshot._nodes
    .filter((node) => node.parent && node.description && !node.tags.includes("waiting"))
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
) {
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

  // The same log, read off the settled (persistable) snapshot.
  return getAgentMessages(result.snapshot);
}

runExampleMain(import.meta.url, async () => {
  await runDescribedWorkflowExample();
});
