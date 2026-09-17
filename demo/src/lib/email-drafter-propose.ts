/**
 * Hands an agent the v1 workflow (its source) plus what happened when it ran
 * (edge traversal counts, per-category metrics, per-run paths from
 * `email-drafter-compare.ts`), and asks for one bounded improvement. The rules
 * it must keep are stated up front, so "delete the review step" is not an
 * available answer.
 *
 * The output is a hypothesis, not a verdict. The comparison is how a proposal
 * earns its place: build the candidate, run both on the same cases, compare.
 *
 * Run after the comparison, from `demo/`:
 * OPENAI_API_KEY=... pnpm exec tsx src/lib/email-drafter-propose.ts
 */
import { z } from "zod";
import { runAgent, setupAgent } from "@statelyai/agent";
import { renderEvidence, type MachineSummary } from "./email-drafter-compare";

const proposalSchema = z.object({
  /** What the traversal counts show, in one or two sentences. */
  observation: z.string(),
  /** The single change to try, in one sentence. */
  proposal: z.string(),
  /** Where in the machine it lands: a state, transition, guard, or request. */
  changes: z.array(z.object({ where: z.string(), change: z.string() })),
  /** Rules the proposal leaves untouched. */
  keeps: z.array(z.string()),
  /** How to tell whether it helped. */
  measure: z.string(),
});

export type Proposal = z.infer<typeof proposalSchema>;

const setup = setupAgent({
  context: z.object({
    source: z.string(),
    summary: z.string(),
    proposal: proposalSchema.nullable(),
  }),
  input: z.object({ source: z.string(), summary: z.string() }),
  output: proposalSchema,
  events: {},
  requests: {
    proposeImprovement: {
      schemas: {
        input: z.object({ source: z.string(), summary: z.string() }),
        output: proposalSchema,
      },
      model: "reasoner",
      system: [
        "You are reviewing an agent workflow defined as an XState machine, together with traversal counts and metrics recorded from running it.",
        "Propose exactly one bounded change to the workflow that would reduce friction for the user.",
        "Non-negotiable rules that must remain: an email is only sent after the human chooses SEND; the human reviews every draft before it can be sent; a valid recipient is required before sending.",
        "Point at concrete states, transitions, or requests in the source. Do not propose deleting review or approval. Do not rewrite the whole machine.",
      ].join(" "),
      prompt: ({ input }) =>
        `## Workflow source\n\n\`\`\`ts\n${input.source}\n\`\`\`\n\n## Recorded runs\n\n${input.summary}`,
    },
  },
});

export const proposerMachine = setup.createMachine({
  id: "workflow-proposer",
  context: ({ input }) => ({ source: input.source, summary: input.summary, proposal: null }),
  output: ({ context }) => context.proposal!,
  initial: "proposing",
  states: {
    proposing: {
      invoke: {
        src: "proposeImprovement",
        input: ({ context }) => ({ source: context.source, summary: context.summary }),
        onDone: { target: "done", context: ({ output }) => ({ proposal: output.result }) },
      },
    },
    done: { type: "final" },
  },
});

async function main() {
  const { readFile, writeFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../agents/email-drafter-v1.ts", import.meta.url), "utf8");
  const results = JSON.parse(
    await readFile(new URL("../../results/email-drafter/comparison.json", import.meta.url), "utf8"),
  ) as { summaries: MachineSummary[] };
  const v1 = results.summaries.find((summary) => summary.machine === "v1");
  if (!v1) throw new Error("Run email-drafter-compare.ts first; no v1 summary found.");

  const [{ createAiSdkExecutors, defineModels }, { openai }] = await Promise.all([
    import("@statelyai/agent/ai-sdk"),
    import("@ai-sdk/openai"),
  ]);
  const model = process.env.OPENAI_PROPOSER_MODEL || "gpt-5.4";
  const result = await runAgent(proposerMachine, {
    input: { source, summary: renderEvidence(v1) },
    executors: createAiSdkExecutors({ models: defineModels({ reasoner: openai(model) }) }),
  });
  if (result.status !== "done") throw new Error(`Proposer did not finish: ${result.status}`);

  console.log(JSON.stringify(result.output, null, 2));
  const file = new URL("../../results/email-drafter/proposal.json", import.meta.url);
  await writeFile(file, JSON.stringify({ model, ...result.output }, null, 2));
  console.log(`\nWrote ${file.pathname}`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run the proposer.");
    process.exit(1);
  }
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
