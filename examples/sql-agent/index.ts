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
 *     `meta.interaction` — read with `getStateMeta`. The host presents it and
 *     resumes with APPROVE / REJECT.
 *   - on APPROVE, the local `runQuery` engine executes the plan over the
 *     in-memory table, then `summarize` explains the result.
 *
 * Dual-mode: `runSqlAgentExample(options?)` takes injectable executors (the
 * test passes mocks — keyless CI); the direct run below uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/sql-agent/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic, type AnyMachineSnapshot } from "xstate";
import { getStateMeta, runAgent, setupAgent, type RunAgentOptions } from "../../src/index.js";
import { defineModels } from "../../src/ai-sdk/index.js";
import { resolveExecutors, runExampleMain } from "../helpers/main.js";

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

// Typed interaction protocol handed to the host for the approval step.
const metaSchema = z.object({
  interaction: z
    .object({
      type: z.literal("select"),
      label: z.string(),
      choices: z.array(z.object({ label: z.string(), eventType: z.string() })),
    })
    .optional(),
});

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
    plan: queryPlanSchema,
    result: z.number(),
    answer: z.string(),
  }),
  meta: metaSchema,
  events: {
    APPROVE: z.object({}),
    REJECT: z.object({}),
  },
  actorSources: {
    runQuery: createAsyncLogic<number, { plan: QueryPlan }>({
      run: async ({ input }) => executeQuery(input.plan),
    }),
  },
  // planning sets plan before any state that reads it — narrow it non-null there.
  states: {
    planning: {},
    awaitingApproval: {
      schemas: { context: contextSchema.extend({ plan: queryPlanSchema }) },
    },
    executing: {
      schemas: { context: contextSchema.extend({ plan: queryPlanSchema }) },
    },
    summarizing: {
      schemas: {
        context: contextSchema.extend({ plan: queryPlanSchema, result: z.number() }),
      },
    },
    rejected: {},
    done: {},
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
  output: ({ context }) => ({
    plan: context.plan ?? { operation: "count", column: "amount", category: null },
    result: context.result ?? 0,
    answer: context.answer ?? "",
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
      },
    },
    // No invoke: runAgent settles idle here. The host reads meta.interaction
    // (via getStateMeta) and resumes with APPROVE / REJECT.
    awaitingApproval: {
      meta: {
        interaction: {
          type: "select",
          label: "Run this query against the orders table?",
          choices: [
            { label: "Approve", eventType: "APPROVE" },
            { label: "Reject", eventType: "REJECT" },
          ],
        },
      },
      on: {
        APPROVE: { target: "executing" },
        REJECT: {
          target: "rejected",
          context: { answer: "Query rejected by the reviewer." },
        },
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
      },
    },
    rejected: { type: "final" },
    done: { type: "final" },
  },
});

/** Reads the current state's typed interaction meta out of an idle snapshot. */
export function readInteraction(snapshot: AnyMachineSnapshot) {
  const meta = getStateMeta<AnyMachineSnapshot, z.infer<typeof metaSchema>>(snapshot);
  return meta.interaction ?? null;
}

export async function runSqlAgentExample(
  options?: RunAgentOptions<typeof sqlAgentMachine> & {
    approval?: "APPROVE" | "REJECT";
  },
  observe?: RunAgentOptions<typeof sqlAgentMachine>["onTransition"],
) {
  const { approval = "APPROVE", ...runOptions } = options ?? {};
  const executors: RunAgentOptions<typeof sqlAgentMachine> = resolveExecutors(models, runOptions);

  const first = await runAgent(sqlAgentMachine, {
    input: { question: "What is the total amount spent on electronics?" },
    // Direct-run narrator; a caller's own `onTransition` in `executors` wins.
    onTransition: observe,
    ...executors,
  });
  if (first.status !== "idle") {
    throw new Error(`SQL agent did not settle idle for approval: ${first.status}`);
  }
  const interaction = readInteraction(first.snapshot as AnyMachineSnapshot);

  const second = await runAgent(sqlAgentMachine, {
    snapshot: JSON.parse(JSON.stringify(first.snapshot)),
    event: { type: approval },
    onTransition: observe,
    ...executors,
  });
  if (second.status !== "done") {
    throw new Error(`SQL agent did not complete: ${second.status}`);
  }

  return { interaction, output: second.output };
}

runExampleMain(import.meta.url, async () => {
  const { interaction, output } = await runSqlAgentExample(undefined, (snapshot) =>
    console.log("[state]", JSON.stringify(snapshot.value)),
  );
  console.log(`Approval prompt: ${interaction?.label}`);
  console.log(`Plan: ${JSON.stringify(output.plan)}`);
  console.log(`Result: ${output.result}`);
  console.log(`\n${output.answer}`);
});
