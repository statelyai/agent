/**
 * Deep research — plan N searches, run researchers concurrently, reflect on
 * coverage, optionally repeat once, then synthesize a cited report.
 *
 * Search is real: each researcher binds OpenAI's provider-executed web search
 * tool (`openai.tools.webSearch`), so the model reads fetched pages, not its
 * own recall. Swap the tool for Tavily, MCP or a private corpus without
 * changing the machine.
 *
 * Citations are checked, not trusted: each researcher returns its finding
 * *with* the pages it rests on, and the machine keeps a page only if its URL
 * is one the search actually returned (`searchedUrls` reads the search
 * results and URL citations off the response messages). Kept pages fold into
 * one numbered ledger (also dropping search-results and bare-domain URLs), and
 * the finding carries the `[n]` markers into the report. The writer cites the
 * ledger it is handed rather than inventing links.
 *
 * Fan-out is dynamic: the planner returns 2-4 queries and `researching` spawns
 * one `research` branch per query off `actors` — the machine's post-
 * `provide` implementation, so `runAgent` binds the host executor onto every
 * branch (no pre-binding, no fixed parallel region). Branches are collected via
 * the canonical `xstate.done.actor` event's `actorId` (see docs/multi-agent.md).
 *
 * Reflection is a JUDGMENT, not a generation: `reflecting` calls the AI SDK's
 * `experimental_decide` with Jev (`@ai-sdk/typesafe-ai`) as the evaluation
 * model, with the question and the findings as state and one boolean
 * question, "do these findings answer the question comprehensively?". The
 * `reflected` choice state compares that probability to
 * `SUFFICIENCY_THRESHOLD`. Naming what is missing is generative, so it moves
 * into the planner: a follow-up round hands `planResearch` the previous
 * findings as feedback, and the planner targets what they leave out. The text
 * model plans, researches and writes; Jev only grades.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/deep-research/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { experimental_decide, type Experimental_DecisionModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import {
  createTextLogic,
  getStatePath,
  setupAgent,
  type AgentRequestExecutors,
  type DoneActorEventOf,
  runAgent,
} from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const queriesSchema = z.array(z.string()).min(2).max(4);

const models = {
  planner: openai("gpt-6-luna"),
  researcher: openai("gpt-6-luna"),
  writer: openai("gpt-6-luna"),
};

/**
 * The judge: TypeSafe's Jev through the AI SDK's decision-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock decision model instead.
 */
const judgeModel: Experimental_DecisionModel = typeSafeAi.decisionModel("jev-latest");

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
 * One spelling per page: no tracking params (`utm_*`), no fragment, no
 * trailing slash. Search results and the model's citations are compared in
 * this form, and the ledger shows it. `null` for an unparseable URL.
 */
export function normalizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith("utm_")) parsed.searchParams.delete(key);
    }
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** The slice of an AI SDK response-message part `searchedUrls` reads. */
type ResponsePart = {
  type?: string;
  toolName?: string;
  output?: { value?: { sources?: Array<{ url?: unknown }> } };
  providerOptions?: { openai?: { annotations?: Array<{ type?: string; url?: unknown }> } };
};

/**
 * Every page the web search returned in one researcher call, read off its
 * response messages: the `web_search` tool result's `sources`, plus the
 * `url_citation` annotations OpenAI attaches to the answer text. Normalized.
 */
export function searchedUrls(messages: readonly unknown[]): Set<string> {
  const urls = new Set<string>();
  const add = (url: unknown) => {
    const normalized = typeof url === "string" ? normalizeUrl(url) : null;
    if (normalized) urls.add(normalized);
  };
  for (const message of messages as Array<{ content?: unknown }>) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content as ResponsePart[]) {
      if (part?.type === "tool-result" && part.toolName === "web_search") {
        for (const source of part.output?.value?.sources ?? []) add(source?.url);
      }
      if (part?.type === "text") {
        for (const annotation of part.providerOptions?.openai?.annotations ?? []) {
          if (annotation?.type === "url_citation") add(annotation.url);
        }
      }
    }
  }
  return urls;
}

/**
 * Fold a branch's sources into the run-wide ledger, deduped by URL, and return
 * the `[n]` markers for that branch. Only pages in `searched` (what the search
 * returned) are kept. Numbers only ever get appended, so a marker handed to a
 * finding stays valid for the rest of the run.
 */
function mergeSources(
  existing: Source[],
  incoming: Source[],
  searched: Set<string>,
): { sources: Source[]; markers: string } {
  const sources = [...existing];
  const numbers: number[] = [];
  for (const candidate of incoming) {
    const url = normalizeUrl(candidate.url);
    if (!url || !searched.has(url) || !isSpecificPage(url)) continue;
    const source = { ...candidate, url };
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

/** The report is written once Jev's probability that the findings suffice clears this. */
export const SUFFICIENCY_THRESHOLD = 0.5;

/**
 * reflect as a judgment: the question and the round's findings are the
 * state, and one boolean question asks whether they cover it. The judge model
 * is injected by tests and hosts; the default is Jev.
 */
export function createReflect(model: Experimental_DecisionModel = judgeModel) {
  return createAsyncLogic<
    { answers: { sufficient: { probability: number } } },
    { question: string; findings: string[] }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await experimental_decide({
        model,
        state: { question: input.question, findings: input.findings },
        questions: {
          sufficient: {
            type: "boolean" as const,
            instructions: "Do `findings`, taken together, answer `question` comprehensively?",
            criteria: {
              true: "Every major part of the question is addressed by at least one finding.",
              false:
                "Some part of the question is unaddressed, or the findings are thin or off-topic.",
            },
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/**
 * The round's findings keyed by the query each branch ran, not by branch id:
 * a reader sees what was searched for. A repeated query keeps its position.
 */
function findingsByQuery(context: {
  queries: string[];
  findings: Record<string, string>;
}): Record<string, string> {
  const byQuery: Record<string, string> = {};
  for (const [id, finding] of Object.entries(context.findings)) {
    const index = Number(id.slice(id.lastIndexOf("-") + 1));
    const query = context.queries[index] ?? id;
    byQuery[query in byQuery ? `${query} (${index + 1})` : query] = finding;
  }
  return byQuery;
}

/** Which rule sent the run to the writer: Jev's sufficiency judgment or the round budget. */
function stopReason(context: { sufficiency: number | null; round: number }): string {
  const p = (context.sufficiency ?? 0).toFixed(2);
  return (context.sufficiency ?? 0) >= SUFFICIENCY_THRESHOLD
    ? `Judged sufficient (${p} ≥ ${SUFFICIENCY_THRESHOLD})`
    : `Round budget of ${MAX_ROUNDS} spent (${p} < ${SUFFICIENCY_THRESHOLD})`;
}

/** What a follow-up round's planner is told: the findings judged incomplete. */
function renderFeedback(findings: string[]): string {
  return [
    "The findings so far do not answer the question comprehensively:",
    ...(findings.length ? findings.map((finding) => `- ${finding}`) : ["(no findings)"]),
  ].join("\n");
}

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
  /** Jev's latest probability that the findings suffice; `null` before the first reflection. */
  sufficiency: z.number().nullable(),
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
  // Provider-executed: OpenAI runs the search inside this one call.
  tools: { web_search: openai.tools.webSearch({ searchContextSize: "low" }) },
  system:
    "Search the web for the query, then return a concise finding (plain text, no links) " +
    "plus the specific pages it came from: each source is a page the search returned " +
    "(article, paper, docs page) with its title, its exact URL, and the one line from it " +
    "the finding rests on. Cite only pages the search returned; never a search-results " +
    "page, a bare homepage, or a URL from memory.",
  prompt: ({ input }) => `Question: ${input.question}\nQuery: ${input.query}`,
});

const setup = setupAgent({
  models,
  context: contextSchema,
  actors: { research, reflect: createReflect() },
  input: z.object({ question: z.string() }),
  output: z.object({
    report: z.string(),
    rounds: z.number(),
    /** Why the writer ran; empty when the run failed before reflecting. */
    stoppedBy: z.string(),
    /** The last round's findings, keyed by the query that produced each. */
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
        "Plan two to four complementary research queries. If feedback is present, it lists the " +
        "findings of the previous round, judged incomplete: target what they leave out.",
      prompt: ({ input }) =>
        `Question: ${input.question}\nCoverage feedback: ${input.feedback ?? "none"}`,
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
    sufficiency: null,
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
    stoppedBy: context.report === null ? "" : stopReason(context),
    findings: findingsByQuery(context),
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
            queries: output.result.queries,
            findings: {},
            expected: output.result.queries.length,
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
          const finding = output.result;
          if (!actorId.startsWith(BRANCH_PREFIX)) {
            return undefined;
          }
          // The branch's sources join the run-wide ledger only if the search
          // returned them, and its finding carries the `[n]` markers back, so
          // the citation survives the reduce instead of being re-guessed.
          const { sources, markers } = mergeSources(
            context.sources,
            finding.sources,
            searchedUrls(output.messages),
          );
          const settled = context.settled + 1;
          const next = {
            settled,
            sources,
            findings: {
              ...context.findings,
              [actorId]: markers ? `${finding.finding} ${markers}` : finding.finding,
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
          context: { sufficiency: output.answers.sufficient.probability },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `reflect failed: ${String(event.error)}` },
        }),
      },
    },
    // A `choice` state: the "research more or write it up" branch is its own
    // state rather than a ternary buried in `reflecting`'s `onDone`, so both
    // arms are visible to `explorePaths`/`canReach`. Jev's probability is
    // compared to SUFFICIENCY_THRESHOLD, and the round budget is a counter in
    // context compared to the MAX_ROUNDS constant.
    reflected: {
      type: "choice",
      choice: ({ context }) =>
        (context.sufficiency ?? 0) >= SUFFICIENCY_THRESHOLD || context.round >= MAX_ROUNDS
          ? { target: "writing" }
          : {
              target: "planning",
              context: { feedback: renderFeedback(Object.values(context.findings)) },
            },
    },
    writing: {
      invoke: {
        src: "writeReport",
        input: ({ context }) => ({
          question: context.question,
          findings: Object.values(context.findings),
          ledger: renderLedger(context.sources),
        }),
        onDone: ({ output }) => ({ target: "done", context: { report: output.result } }),
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
  /** The judge model; tests pass a mock, the direct run uses Jev. */
  judge?: Experimental_DecisionModel;
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export async function runDeepResearchExample(options: RunDeepResearchOptions = {}) {
  const {
    question = "What makes durable AI workflows reliable?",
    generateText,
    judge,
    onProgress,
  } = options;
  const result = await runAgent(deepResearchMachine, {
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors(deepResearchMachine) }),
    ...(judge ? { actors: { reflect: createReflect(judge) } } : {}),
    ...(onProgress ? { onTransition: (snapshot) => onProgress(getStatePath(snapshot)) } : {}),
    input: { question },
  });
  if (result.status !== "done") throw new Error(`Deep research did not complete: ${result.status}`);
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
  }
  void runDeepResearchExample().then(({ report, sourceLedger }) =>
    console.log(`${report}\n\nSources:\n${sourceLedger}`),
  );
}
