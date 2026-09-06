/**
 * Deep research — plan N searches, run researchers concurrently, reflect on
 * coverage, optionally repeat once, then synthesize a cited report.
 *
 * Search is a host-owned request here. A real host can bind Tavily, MCP, native
 * web search, a private corpus, or any other research implementation without
 * changing the machine.
 *
 * Citations are structural: each researcher returns its finding *with* the
 * specific pages it rests on, the machine folds those into one numbered ledger
 * (dropping search-results and bare-domain URLs), and the finding carries the
 * `[n]` markers into the report. The writer cites the ledger it is handed
 * rather than inventing links.
 *
 * Fan-out is dynamic: the planner returns 2-4 queries and `researching` spawns
 * one `research` branch per query off `actors` — the machine's post-
 * `provide` implementation, so `runAgent` binds the host executor onto every
 * branch (no pre-binding, no fixed parallel region). Branches are collected via
 * the canonical `xstate.done.actor` event's `actorId` (see docs/multi-agent.md).
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/deep-research/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import {
  createTextLogic,
  getStatePath,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
  type DoneActorEventOf,
} from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const queriesSchema = z.array(z.string()).min(2).max(4);

export const models = defineModels({
  planner: openai("gpt-5.4-mini"),
  researcher: openai("gpt-5.4-mini"),
  reflector: openai("gpt-5.4-mini"),
  writer: openai("gpt-5.4-mini"),
});

const BRANCH_PREFIX = "research-";

/** Branch id for round `round`, query `index`. The round is part of the id so a
 * follow-up round never reuses a spawned child's name. */
function branchId(round: number, index: number): string {
  return `${BRANCH_PREFIX}${round}-${index}`;
}

/** One cited page: the exact document a claim came from, not a query for it. */
const sourceSchema = z.object({
  title: z.string(),
  /** The page carrying the claim (article, paper, docs page). */
  url: z.string(),
  /** The line from that page the finding rests on. */
  quote: z.string(),
});

type Source = z.infer<typeof sourceSchema>;

/**
 * A search-results page, a bare domain, or an unparseable string is not a
 * citation. Filtering here is what keeps generic URLs out of the ledger.
 */
function isSpecificPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("q") || parsed.pathname.startsWith("/search")) return false;
    return parsed.pathname.replace(/\/+$/, "").length > 1;
  } catch {
    return false;
  }
}

/**
 * Fold a branch's sources into the run-wide ledger, deduped by URL, and return
 * the `[n]` markers for that branch. Numbers only ever get appended, so a
 * marker handed to a finding stays valid for the rest of the run.
 */
function mergeSources(
  existing: Source[],
  incoming: Source[],
): { sources: Source[]; markers: string } {
  const sources = [...existing];
  const numbers: number[] = [];
  for (const source of incoming.filter((candidate) => isSpecificPage(candidate.url))) {
    let index = sources.findIndex((known) => known.url === source.url);
    if (index === -1) index = sources.push(source) - 1;
    numbers.push(index + 1);
  }
  return { sources, markers: numbers.map((number) => `[${number}]`).join(" ") };
}

/** One line per source: `[n] title — url`. */
function renderLedger(sources: Source[]): string {
  return sources
    .map((source, index) => `[${index + 1}] ${source.title} — ${source.url}`)
    .join("\n");
}

/** Reflection rounds before the report is written no matter what. */
const MAX_ROUNDS = 2;

const contextSchema = z.object({
  question: z.string(),
  queries: queriesSchema,
  // findings keyed by branch id (`research-0`..`research-<N-1>`), each
  // carrying the `[n]` markers of the sources it rests on
  findings: z.record(z.string(), z.string()),
  /** Run-wide ledger, deduped by URL. Position is the citation number. */
  sources: z.array(sourceSchema),
  /** Branches spawned this round. */
  expected: z.number(),
  /** Branches that finished this round, succeeded or failed. */
  settled: z.number(),
  /** Branch ids whose researcher errored, so a failure is visible, not silent. */
  failedBranches: z.array(z.string()),
  /** The reflector's latest verdict; `null` before the first reflection. */
  assessment: z.object({ sufficient: z.boolean(), gaps: z.string() }).nullable(),
  feedback: z.string().nullable(),
  round: z.number(),
  report: z.string().nullable(),
  /** Why the run failed, when a request errored. `null` otherwise. */
  failure: z.string().nullable(),
});

/**
 * One researcher branch, as a standalone logic value rather than a `requests`
 * entry: `researching` spawns it dynamically, and `DoneActorEventOf<typeof
 * research>` types the collected `xstate.done.actor` event off it.
 */
export const research = createTextLogic({
  schemas: {
    input: z.object({ question: z.string(), query: z.string() }),
    output: z.object({
      finding: z.string(),
      sources: z.array(sourceSchema).min(1).max(3),
    }),
  },
  name: "research",
  model: "researcher",
  system:
    "Research the query using the host's available search tools. Return a concise finding " +
    "plus the specific pages it came from: each source is the document carrying the claim " +
    "(article, paper, docs page) with its title, its page URL, and the one line from it " +
    "the finding rests on. Never cite a search-results page or a bare homepage.",
  prompt: ({ input }) => `Question: ${input.question}\nQuery: ${input.query}`,
});

const setup = setupAgent({
  models,
  context: contextSchema,
  actors: { research },
  input: z.object({ question: z.string() }),
  output: z.object({
    report: z.string(),
    rounds: z.number(),
    findings: z.record(z.string(), z.string()),
    /** Rendered from `context.sources` at the end, never stored in context. */
    sourceLedger: z.string(),
    /** Branch ids whose researcher errored. Empty on a clean run. */
    failedBranches: z.array(z.string()),
    failure: z.string().nullable(),
  }),
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
        input: z.object({
          question: z.string(),
          findings: z.array(z.string()),
          ledger: z.string(),
        }),
        output: z.string(),
      },
      model: "writer",
      system:
        "Write a concise research report using only the findings. Cite every claim inline with " +
        "the bracketed numbers the findings carry, e.g. [1] or [2][3]. Use only numbers that " +
        "appear in the source ledger, and invent no sources.",
      prompt: ({ input }) =>
        `Question: ${input.question}\nFindings:\n${input.findings.join("\n\n")}` +
        `\n\nSources:\n${input.ledger}`,
    },
  },
});

export const deepResearchMachine = setup.createMachine({
  id: "deep-research",
  context: ({ input }) => ({
    question: input.question,
    queries: [],
    findings: {},
    sources: [],
    expected: 0,
    settled: 0,
    failedBranches: [],
    assessment: null,
    feedback: null,
    round: 0,
    report: null,
    failure: null,
  }),
  // The ledger is derived, so it is rendered here rather than kept in context
  // and hand-synchronized on every branch that lands.
  output: ({ context }) => ({
    report: context.report ?? "",
    rounds: context.round,
    findings: context.findings,
    sourceLedger: renderLedger(context.sources),
    failedBranches: context.failedBranches,
    failure: context.failure,
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
            settled: 0,
            round: context.round + 1,
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `planResearch failed: ${String(event.error)}` },
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
            id: branchId(context.round, index),
            input: { question: context.question, query },
          });
        });
      },
      always: { target: "collecting" },
    },
    // REDUCE: count every researcher *settlement* — a finding or an error —
    // keying results by branch id via canonical `xstate.done.actor` +
    // `actorId` (ids are only known at runtime). Counting failures is what
    // stops one broken researcher from parking the machine here forever.
    collecting: {
      on: {
        "xstate.done.actor": ({ context, event }) => {
          const { actorId, output } = event as DoneActorEventOf<typeof research>;
          if (!actorId.startsWith(BRANCH_PREFIX)) {
            return undefined;
          }
          // The branch's sources join the run-wide ledger, and its finding
          // carries the `[n]` markers back, so the citation survives the
          // reduce instead of being re-guessed by the writer.
          const { sources, markers } = mergeSources(context.sources, output.sources);
          const settled = context.settled + 1;
          const next = {
            settled,
            sources,
            findings: {
              ...context.findings,
              [actorId]: markers ? `${output.finding} ${markers}` : output.finding,
            },
          };
          return settled >= context.expected
            ? { target: "reflecting" as const, context: next }
            : { context: next };
        },
        "xstate.error.actor": ({ context, event }) => {
          const { actorId } = event as unknown as { actorId: string };
          if (!actorId.startsWith(BRANCH_PREFIX)) {
            return undefined;
          }
          const settled = context.settled + 1;
          const next = {
            settled,
            failedBranches: [...context.failedBranches, actorId],
          };
          return settled >= context.expected
            ? { target: "reflecting" as const, context: next }
            : { context: next };
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
        onDone: ({ output }) => ({
          target: "reflected",
          context: { assessment: output, feedback: output.gaps },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `reflect failed: ${String(event.error)}` },
        }),
      },
    },
    // A `choice` state: the "research more or write it up" branch is its own
    // state rather than a ternary buried in `reflecting`'s `onDone`, so both
    // arms are visible to `explorePaths`/`canReach`. The round budget is a
    // counter in context compared to the MAX_ROUNDS constant.
    reflected: {
      type: "choice",
      choice: ({ context }) =>
        context.assessment?.sufficient === true || context.round >= MAX_ROUNDS
          ? { target: "writing" }
          : { target: "planning" },
    },
    writing: {
      invoke: {
        src: "writeReport",
        input: ({ context }) => ({
          question: context.question,
          findings: Object.values(context.findings),
          ledger: renderLedger(context.sources),
        }),
        onDone: ({ output }) => ({ target: "done", context: { report: output } }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `writeReport failed: ${String(event.error)}` },
        }),
      },
    },
    done: { type: "final" },
    // A request errored. The run ends with the reason, not with an empty report
    // dressed up as success.
    failed: { type: "final" },
  },
});

export interface RunDeepResearchOptions {
  question?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export async function runDeepResearchExample(options: RunDeepResearchOptions = {}) {
  const {
    question = "What makes durable AI workflows reliable?",
    generateText,
    onProgress,
  } = options;
  const result = await runAgent(deepResearchMachine, {
    input: { question },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    ...(onProgress ? { onTransition: (snapshot) => onProgress(getStatePath(snapshot)) } : {}),
  });
  if (result.status !== "done") throw new Error(`Deep research did not complete: ${result.status}`);
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run this example.");
  void runDeepResearchExample().then(({ report, sourceLedger }) =>
    console.log(`${report}\n\nSources:\n${sourceLedger}`),
  );
}
