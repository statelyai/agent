/**
 * Deep research — plan N searches, run researchers concurrently, reflect on
 * coverage, optionally repeat once, then synthesize a cited report.
 *
 * Search is a host-owned request here. A real host can bind Tavily, MCP, native
 * web search, a private corpus, or any other research implementation without
 * changing the machine.
 *
 * Fan-out is dynamic: the planner returns 2-4 queries and `researching` spawns
 * one `research` branch per query off `actors` — the machine's post-
 * `provide` implementation, so `runAgent` binds the host executor onto every
 * branch (no pre-binding, no fixed parallel region). Branches are collected via
 * the canonical `xstate.done.actor` event's `actorId` (see `examples/fan-out`).
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/deep-research/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const queriesSchema = z.array(z.string()).min(2).max(4);

export const models = defineModels({
  planner: openai("gpt-5.4-mini"),
  researcher: openai("gpt-5.4-mini"),
  reflector: openai("gpt-5.4-mini"),
  writer: openai("gpt-5.4-mini"),
});

const BRANCH_PREFIX = "research-";

const setup = setupAgent({
  models,
  context: z.object({
    question: z.string(),
    queries: queriesSchema,
    // findings keyed by branch id (`research-0`..`research-<N-1>`)
    findings: z.record(z.string(), z.string()),
    expected: z.number(),
    feedback: z.string().nullable(),
    round: z.number(),
    maxRounds: z.number(),
    report: z.string().nullable(),
  }),
  input: z.object({ question: z.string(), maxRounds: z.number().default(2) }),
  output: z.object({
    report: z.string(),
    rounds: z.number(),
    findings: z.record(z.string(), z.string()),
  }),
  states: {
    planning: {},
    researching: {},
    collecting: {},
    reflecting: {},
    writing: {},
    done: {},
  },
  requests: {
    planResearch: {
      schemas: {
        input: z.object({ question: z.string(), feedback: z.string().nullable() }),
        output: z.object({ queries: queriesSchema }),
      },
      model: "planner",
      system:
        "Plan two to four complementary research queries. If feedback is present, target the named coverage gaps.",
      prompt: ({ input }) =>
        `Question: ${input.question}\nCoverage feedback: ${input.feedback ?? "none"}`,
    },
    research: {
      schemas: {
        input: z.object({ question: z.string(), query: z.string() }),
        output: z.string(),
      },
      model: "researcher",
      system:
        "Research the query using the host's available search tools. Return concise findings with source URLs or source identifiers.",
      prompt: ({ input }) => `Question: ${input.question}\nQuery: ${input.query}`,
    },
    reflect: {
      schemas: {
        input: z.object({ question: z.string(), findings: z.array(z.string()) }),
        output: z.object({ sufficient: z.boolean(), gaps: z.string() }),
      },
      model: "reflector",
      system:
        "Judge whether the combined findings answer the question comprehensively and identify gaps.",
      prompt: ({ input }) =>
        `Question: ${input.question}\nFindings:\n${input.findings.join("\n\n")}`,
    },
    writeReport: {
      schemas: {
        input: z.object({ question: z.string(), findings: z.array(z.string()) }),
        output: z.string(),
      },
      model: "writer",
      system:
        "Write a concise research report using only the findings. Preserve source URLs or identifiers as citations.",
      prompt: ({ input }) =>
        `Question: ${input.question}\nFindings:\n${input.findings.join("\n\n")}`,
    },
  },
});

export const deepResearchMachine = setup.createMachine({
  id: "deep-research",
  context: ({ input }) => ({
    question: input.question,
    queries: [],
    findings: {},
    expected: 0,
    feedback: null,
    round: 0,
    maxRounds: input.maxRounds,
    report: null,
  }),
  output: ({ context }) => ({
    report: context.report ?? "",
    rounds: context.round,
    findings: context.findings,
  }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        src: "planResearch",
        input: ({ context }) => ({ question: context.question, feedback: context.feedback }),
        onDone: ({ output, context }) => ({
          target: "researching",
          context: {
            queries: output.queries,
            findings: {},
            expected: output.queries.length,
            round: context.round + 1,
          },
        }),
      },
    },
    // DYNAMIC FAN-OUT: one researcher spawned per planned query — N decided at
    // runtime. `actors.research` is the host-bound branch logic; each
    // spawn is a live child (`research-0`..`research-<N-1>`).
    researching: {
      entry: ({ context, actors }, enq) => {
        context.queries.forEach((query, index) => {
          enq.spawn(actors.research, {
            id: `${BRANCH_PREFIX}${index}`,
            input: { question: context.question, query },
          });
        });
      },
      always: { target: "collecting" },
    },
    // REDUCE: count every researcher completion, keying its finding by branch id
    // via canonical `xstate.done.actor` + `actorId` (ids only known at runtime).
    collecting: {
      on: {
        "xstate.done.actor": ({ context, event }) => {
          const id = (event as unknown as { actorId: string }).actorId;
          if (!id.startsWith(BRANCH_PREFIX)) {
            return undefined;
          }
          const findings = {
            ...context.findings,
            [id]: (event as unknown as { output: string }).output,
          };
          return Object.keys(findings).length >= context.expected
            ? { target: "reflecting", context: { findings } }
            : { context: { findings } };
        },
      },
    },
    reflecting: {
      invoke: {
        src: "reflect",
        input: ({ context }) => ({
          question: context.question,
          findings: Object.values(context.findings),
        }),
        onDone: ({ output, context }) => ({
          target: output.sufficient || context.round >= context.maxRounds ? "writing" : "planning",
          context: { feedback: output.gaps },
        }),
      },
    },
    writing: {
      invoke: {
        src: "writeReport",
        input: ({ context }) => ({
          question: context.question,
          findings: Object.values(context.findings),
        }),
        onDone: ({ output }) => ({ target: "done", context: { report: output } }),
      },
    },
    done: { type: "final" },
  },
});

export interface RunDeepResearchOptions {
  question?: string;
  maxRounds?: number;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export async function runDeepResearchExample(options: RunDeepResearchOptions = {}) {
  const {
    question = "What makes durable AI workflows reliable?",
    maxRounds = 2,
    generateText,
    onProgress,
  } = options;
  const result = await runAgent(deepResearchMachine, {
    input: { question, maxRounds },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    ...(onProgress ? { onTransition: (snapshot) => onProgress(String(snapshot.value)) } : {}),
  });
  if (result.status !== "done") throw new Error(`Deep research did not complete: ${result.status}`);
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run this example.");
  void runDeepResearchExample().then(({ report }) => console.log(report));
}
