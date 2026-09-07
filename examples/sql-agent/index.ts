/**
 * SQL agent — an approval-gated query flow over an IN-MEMORY sample table.
 *
 * There is no fake DB API and no canned rows: the "database" is a small array
 * of labeled sample orders, and a genuinely-executing local engine
 * (`runQuery`) filters/aggregates it in TypeScript.
 *
 * Shows:
 *   - `planQuery`: a structured-output request → a typed `QueryPlan`
 *     (operation + column + optional category filter).
 *   - `awaitingApproval`: an idle state (no invoke) carrying a typed
 *     `meta.interaction` — read with `getInteraction`. The host presents it
 *     and resumes with APPROVE / REJECT.
 *   - on APPROVE, the local `runQuery` engine executes the plan over the
 *     in-memory table, then `summarize` explains the result.
 *   - three final states — `done`, `rejected`, `failed` — each with its own
 *     `output`, so a rejected or failed run is never a successful-looking one
 *     with a fabricated plan and a zero result.
 *
 * Dual-mode: `runSqlAgentExample(question, options?)` takes injectable
 * executors (the test passes mocks — CI with no API key); the direct run below uses
 * real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/sql-agent/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import {
  getInteraction,
  getStatePath,
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type RunAgentOptions,
} from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

// ─── In-memory sample table (the whole "database") ───
type Order = { id: number; category: string; amount: number };

export const orders: Order[] = [
  { id: 1, category: "books", amount: 12 },
  { id: 2, category: "books", amount: 30 },
  { id: 3, category: "electronics", amount: 250 },
  { id: 4, category: "electronics", amount: 90 },
  { id: 5, category: "toys", amount: 15 },
];

const queryPlanSchema = z.object({
  operation: z.enum(["count", "sum", "average"]),
  column: z.literal("amount"),
  category: z.string().nullable(),
});
type QueryPlan = z.infer<typeof queryPlanSchema>;

// The real, genuinely-executing query engine over the in-memory array.
export function executeQuery(plan: QueryPlan, table: Order[] = orders): number {
  const rows = plan.category ? table.filter((row) => row.category === plan.category) : table;
  if (plan.operation === "count") {
    return rows.length;
  }
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  if (plan.operation === "sum") {
    return total;
  }
  return rows.length ? total / rows.length : 0;
}

export const models = defineModels({
  planner: openai("gpt-5.4-mini"),
  summarizer: openai("gpt-5.4-mini"),
});

const contextSchema = z.object({
  question: z.string(),
  plan: queryPlanSchema.nullable(),
  result: z.number().nullable(),
  answer: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ question: z.string() }),
  output: z.object({
    status: z.enum(["answered", "rejected", "failed"]),
    plan: queryPlanSchema.nullable(),
    result: z.number().nullable(),
    answer: z.string(),
  }),
  meta: interactionMetaSchema,
  events: {
    APPROVE: z.object({}),
    REJECT: z.object({}),
  },
  actors: {
    runQuery: createAsyncLogic<number, { plan: QueryPlan }>({
      run: async ({ input }) => executeQuery(input.plan),
    }),
  },
  // planning sets plan before any state that reads it — narrow it non-null there.
  states: {
    awaitingApproval: {
      schemas: { context: contextSchema.extend({ plan: queryPlanSchema }) },
    },
    executing: { schemas: { context: contextSchema.extend({ plan: queryPlanSchema }) } },
    summarizing: {
      schemas: { context: contextSchema.extend({ plan: queryPlanSchema, result: z.number() }) },
    },
    rejected: { schemas: { context: contextSchema.extend({ plan: queryPlanSchema }) } },
    failed: { schemas: { context: contextSchema.extend({ answer: z.string() }) } },
    done: {
      schemas: {
        context: contextSchema.extend({
          plan: queryPlanSchema,
          result: z.number(),
          answer: z.string(),
        }),
      },
    },
  },
  requests: {
    planQuery: {
      schemas: {
        input: z.object({ question: z.string() }),
        output: queryPlanSchema,
      },
      model: "planner",
      system:
        "You translate a question into a query plan over an orders table with " +
        "columns (id, category, amount). Choose an operation (count/sum/average) " +
        'over "amount", optionally filtered to one category (or null for all).',
      prompt: ({ input }) => input.question,
    },
    summarize: {
      schemas: {
        input: z.object({
          question: z.string(),
          plan: queryPlanSchema,
          result: z.number(),
        }),
        output: z.string(),
      },
      model: "summarizer",
      system: "You explain a query result in one plain-English sentence.",
      prompt: ({ input }) =>
        `Question: ${input.question}\nPlan: ${JSON.stringify(input.plan)}\nResult: ${input.result}`,
    },
  },
});

export const sqlAgentSchemas = agentSetup.schemas;

export const sqlAgentMachine = agentSetup.createMachine({
  id: "sql-agent",
  context: ({ input }) => ({
    question: input.question,
    plan: null,
    result: null,
    answer: null,
  }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        id: "planQuery",
        src: "planQuery",
        input: ({ context }) => ({ question: context.question }),
        onDone: ({ output }) => ({
          target: "awaitingApproval",
          context: { plan: output },
        }),
        // No plan, no query: end in `failed`, not in a success-shaped output.
        onError: {
          target: "failed",
          context: { answer: "Could not plan a query for this question." },
        },
      },
    },
    // No invoke: runAgent settles idle here. The host reads meta.interaction
    // (via getStateMeta) and resumes with APPROVE / REJECT.
    awaitingApproval: {
      tags: ["awaiting-approval"],
      meta: {
        interaction: {
          label: "Run this query against the orders table?",
          events: {
            APPROVE: { label: "Approve", style: "primary" },
            REJECT: { label: "Reject", style: "danger" },
          },
        },
      },
      on: {
        APPROVE: { target: "executing" },
        REJECT: { target: "rejected" },
      },
    },
    executing: {
      invoke: {
        id: "runQuery",
        src: "runQuery",
        input: ({ context }) => ({
          plan: context.plan,
        }),
        onDone: ({ output }) => ({
          target: "summarizing",
          context: { result: output },
        }),
        onError: {
          target: "failed",
          context: { answer: "The query engine failed to run the approved plan." },
        },
      },
    },
    summarizing: {
      invoke: {
        id: "summarize",
        src: "summarize",
        input: ({ context }) => ({
          question: context.question,
          plan: context.plan,
          result: context.result,
        }),
        onDone: ({ output }) => ({ target: "done", context: { answer: output } }),
        // The result is already computed — fall back to a plain rendering.
        onError: ({ context }) => ({
          target: "done",
          context: { answer: `Result: ${context.result}` },
        }),
      },
    },
    rejected: {
      type: "final",
      output: ({ context }) => ({
        status: "rejected" as const,
        plan: context.plan,
        result: null,
        answer: "Query rejected by the reviewer.",
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        status: "failed" as const,
        plan: context.plan,
        result: null,
        answer: context.answer,
      }),
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        status: "answered" as const,
        plan: context.plan,
        result: context.result,
        answer: context.answer,
      }),
    },
  },
});

export async function runSqlAgentExample(
  question: string,
  options: RunAgentOptions<typeof sqlAgentMachine> & {
    approval?: "APPROVE" | "REJECT";
  } = {},
) {
  const { approval = "APPROVE", ...runOptions } = options;
  // Spread-merge, so passing only `onTransition` keeps the default executors.
  const resolved: RunAgentOptions<typeof sqlAgentMachine> = {
    executors: createAiSdkExecutors({ models }),
    ...runOptions,
  };

  const first = await runAgent(sqlAgentMachine, { input: { question }, ...resolved });
  // Planning failed: the run is already in `failed`, with nothing to approve.
  if (first.status === "done") {
    return { interaction: undefined, output: first.output };
  }
  if (first.status !== "idle") {
    throw new Error(`SQL agent did not settle idle for approval: ${first.status}`);
  }
  const interaction = getInteraction(first.snapshot);

  const second = await runAgent(sqlAgentMachine, {
    snapshot: first.persist(),
    event: { type: approval },
    ...resolved,
  });
  if (second.status !== "done") {
    throw new Error(`SQL agent did not complete: ${second.status}`);
  }

  return { interaction, output: second.output };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { interaction, output } = await runSqlAgentExample(
      "What is the total amount spent on electronics?",
      { onTransition: (snapshot) => console.log("[state]", getStatePath(snapshot)) },
    );
    console.log(`Approval prompt: ${interaction?.label}`);
    console.log(`Status: ${output.status}`);
    console.log(`Plan: ${JSON.stringify(output.plan)}`);
    console.log(`Result: ${output.result}`);
    console.log(`\n${output.answer}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
