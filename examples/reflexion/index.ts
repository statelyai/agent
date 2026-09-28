/**
 * Reflexion — LangGraph's "Reflexion" tutorial (Shinn et al. 2023) as a
 * machine: an actor drafts an answer AND critiques it, searches for what the
 * critique says is missing, and revises with citations, a fixed number of
 * times.
 *
 * Not the same loop as the sibling `reflection-writer` example. There, a critic
 * persona grades the draft from its own judgment and the writer revises from
 * prose feedback alone. Here the critique is TOOL-GROUNDED: each reflection
 * names what is missing plus search queries to fill the gap, the queries run
 * against an index, and the revision is written from those results and must
 * cite them. The machine keeps only citations to passages this run actually
 * retrieved.
 *
 * LangGraph shape (tutorials/reflexion/reflexion):
 *
 *   START → draft → execute_tools → revise ──┬─ END            (iterations > MAX_ITERATIONS)
 *                        ▲                   │
 *                        └───────────────────┘                  (event_loop: otherwise)
 *
 * Machine shape:
 *
 *   drafting → searching → revising → reviewed ─┬─ done         (revisions >= MAX_REVISIONS)
 *                 ▲                              │
 *                 └──────────────────────────────┘               (else: search again)
 *   (any invoke error) → failed
 *
 * What maps to what:
 *   - draft (first responder) → `drafting`: a structured request returning
 *                               `{ answer, reflection: { missing, superfluous }, searchQueries }`
 *   - execute_tools           → `searching`: one plain actor that runs every
 *                               query against the sample index
 *   - revise (revisor)        → `revising`: a structured request that also
 *                               returns `references` (passage ids it cites)
 *   - event_loop              → `reviewed`, a choice state on the
 *                               `revisions` counter vs `MAX_REVISIONS`
 *   - AnswerQuestion / ReviseAnswer tool schemas → the requests' zod output schemas
 *
 * Differences from LangGraph worth calling out:
 *   - The loop bound is a counter in context compared against an exported
 *     constant, not a count of tool-call messages in the transcript.
 *   - Citations are checked. The tutorial's revisor may cite any URL it likes;
 *     here a reference survives only if it names a passage one of this run's
 *     searches returned. The dropped ones are listed in the trail.
 *   - There is no message list. Each request gets exactly the question, the
 *     prior answer, its reflection and the latest search results as typed input.
 *   - Every invoke has an `onError` into `failed`, which still returns the
 *     latest answer when there is one.
 *
 * Stand-in (NO network): `searchWeb` is keyword overlap over
 * `SAMPLE_WEB_INDEX`, nine short passages about teams adopting AI coding
 * assistants. Results are prefixed `[sample web result]`. Swap the actor for
 * a real search tool and the machine is unchanged.
 *
 * Dual-mode: `runReflexionExample(options?)` takes an injectable
 * `generateText` (tests pass scripted answers; no API key); the direct run
 * uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/reflexion/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { getStatePath, runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

const models = {
  responder: openai("gpt-6-luna"),
};

/** Revisions after the first draft (the tutorial's MAX_ITERATIONS). */
export const MAX_REVISIONS = 2;

/** Passages returned per search query. */
export const RESULTS_PER_QUERY = 2;

/**
 * Sample data: a tiny stand-in for a web search index. Short, clearly fake
 * passages on one theme; NOT live search results.
 */
export const SAMPLE_WEB_INDEX: Array<{ id: string; text: string }> = [
  {
    id: "S1",
    text: "Small teams that roll out an AI coding assistant as a two-to-four week pilot on one repository, with a named owner, report smoother adoption than a team-wide launch.",
  },
  {
    id: "S2",
    text: "AI-generated code should go through the same code review as human code; reviewers should check tests, edge cases and security rather than style.",
  },
  {
    id: "S3",
    text: "Security: keep secrets out of prompts. Configure the coding assistant to exclude .env files and credentials, and prefer plans that do not train on your code.",
  },
  {
    id: "S4",
    text: "Licensing risks: check a coding assistant's license terms and whether it filters suggestions matching public code, to reduce copyright exposure.",
  },
  {
    id: "S5",
    text: "Measure whether an assistant pays off with cycle time, review turnaround and escaped defects, not lines of code generated.",
  },
  {
    id: "S6",
    text: "Coding assistants help new hires onboard onto an unfamiliar codebase by explaining modules and drafting first tests.",
  },
  {
    id: "S7",
    text: "Asking the assistant to write tests first, then the implementation, catches more of its mistakes than reviewing the implementation alone.",
  },
  {
    id: "S8",
    text: "Cost: assistant seats typically run 10 to 40 USD per developer per month; a small team should weigh that against review and boilerplate time saved.",
  },
  {
    id: "S9",
    text: "A one-page team guideline covering allowed tools, data rules and review expectations keeps each developer from inventing their own AI policy.",
  },
];

const STOP_WORDS = new Set(
  "a an the is are of to in on and or what how why do does can should would i we our my it that this for with about when whether who which be as by at from".split(
    " ",
  ),
);

/** Honest keyword-overlap score (NOT embeddings): shared content words. */
function scorePassage(query: string, text: string): number {
  const terms = new Set(
    query
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) if (haystack.includes(term)) score += 1;
  return score;
}

const passageSchema = z.object({ id: z.string(), text: z.string() });
type Passage = z.infer<typeof passageSchema>;

const searchRoundSchema = z.object({ query: z.string(), passages: z.array(passageSchema) });
type SearchRound = z.infer<typeof searchRoundSchema>;

/** Top passages for one query, best first. */
export function searchIndex(query: string): Passage[] {
  return SAMPLE_WEB_INDEX.map((passage) => ({ passage, score: scorePassage(query, passage.text) }))
    .filter((scored) => scored.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, RESULTS_PER_QUERY)
    .map((scored) => scored.passage);
}

/** execute_tools: every query, against the sample index. */
export const searchWeb = createAsyncLogic<SearchRound[], { queries: string[] }>({
  run: async ({ input }) => input.queries.map((query) => ({ query, passages: searchIndex(query) })),
});

const reflectionSchema = z.object({
  /** What the answer lacks. */
  missing: z.string(),
  /** What the answer should cut. */
  superfluous: z.string(),
});

const draftSchema = z.object({
  answer: z.string(),
  reflection: reflectionSchema,
  searchQueries: z.array(z.string()).min(1).max(3),
});

const revisionSchema = draftSchema.extend({
  /** Ids of the search passages (e.g. "S3") the revised answer cites. */
  references: z.array(z.string()),
});

const contextSchema = z.object({
  question: z.string(),
  answer: z.string().nullable(),
  reflection: reflectionSchema.nullable(),
  searchQueries: z.array(z.string()),
  /** The latest search round, fed to the next revision. */
  searchResults: z.array(searchRoundSchema),
  /** Passage ids each search round returned, in order. */
  searches: z.array(z.array(z.string())),
  /** One entry per draft/revision: the critique, queries, and citations kept/dropped. */
  attempts: z.array(
    z.object({
      missing: z.string(),
      queries: z.array(z.string()),
      cited: z.array(z.string()),
      dropped: z.array(z.string()),
    }),
  ),
  /** Grounded citations of the latest revision. */
  references: z.array(z.string()),
  revisions: z.number(),
  failure: z.string().nullable(),
});
type ReflexionContext = z.infer<typeof contextSchema>;

/** Passage ids any search in this run returned. */
function retrievedIds(context: ReflexionContext): Set<string> {
  return new Set(context.searches.flat());
}

/** Search results as numbered, citable lines for the revisor. */
function renderResults(rounds: SearchRound[]): string {
  return rounds
    .map(
      (round) =>
        `Query: ${round.query}\n` +
        (round.passages.length
          ? round.passages
              .map((passage) => `  [${passage.id}] [sample web result] ${passage.text}`)
              .join("\n")
          : "  (no results)"),
    )
    .join("\n");
}

/** Draft, searches and revisions, one line each — rendered, never stored. */
function renderTrail(context: ReflexionContext): string {
  const lines: string[] = [];
  context.attempts.forEach((attempt, index) => {
    const label = index === 0 ? "Draft" : `Revision ${index}`;
    const cites = index === 0 ? "" : ` cites [${attempt.cited.join(", ") || "none"}]`;
    const dropped = attempt.dropped.length
      ? ` (dropped unretrieved: ${attempt.dropped.join(", ")})`
      : "";
    lines.push(`${label}:${cites}${dropped}; missing: ${attempt.missing}`);
    lines.push(`  next queries: ${attempt.queries.join(" | ")}`);
    const search = context.searches[index];
    if (search)
      lines.push(`Search ${index + 1}: ${search.length ? search.join(", ") : "no passages"}`);
  });
  if (context.failure) lines.push(`Failed: ${context.failure}`);
  return lines.join("\n");
}

/** The cited passages, rendered. */
function renderReferences(context: ReflexionContext): string[] {
  return context.references.map(
    (id) => `[${id}] ${SAMPLE_WEB_INDEX.find((passage) => passage.id === id)?.text ?? ""}`,
  );
}

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ question: z.string() }),
  output: z.object({
    answer: z.string(),
    references: z.array(z.string()),
    revisions: z.number(),
    trail: z.string(),
  }),
  actors: { searchWeb },
  requests: {
    // draft: answer, self-critique, and the searches that would fix it.
    draft: {
      schemas: { input: z.object({ question: z.string() }), output: draftSchema },
      model: "responder",
      system:
        "You are an expert researcher. Answer the question in about 150 words. Then reflect " +
        "on your answer: be severe about what is missing and what is superfluous. Finally " +
        "write 1-3 search queries that would find the missing information.",
      prompt: ({ input }) => `Question: ${input.question}`,
    },
    // revise: rewrite from the search results, citing them.
    revise: {
      schemas: {
        input: z.object({
          question: z.string(),
          answer: z.string(),
          reflection: reflectionSchema,
          results: z.string(),
        }),
        output: revisionSchema,
      },
      model: "responder",
      system:
        "Revise your previous answer using the search results. Address what your reflection " +
        "said was missing and cut what was superfluous. Cite supporting passages inline by " +
        "their bracketed id, e.g. [S3], and list those ids in references. Cite only ids that " +
        "appear in the results. Keep it under 250 words. Then reflect again and write 1-3 " +
        "new search queries.",
      prompt: ({ input }) =>
        [
          `Question: ${input.question}`,
          `\nPrevious answer:\n${input.answer}`,
          `\nReflection — missing: ${input.reflection.missing}`,
          `Reflection — superfluous: ${input.reflection.superfluous}`,
          `\nSearch results:\n${input.results}`,
        ].join("\n"),
    },
  },
});

export const reflexionSchemas = agentSetup.schemas;

export const reflexionMachine = agentSetup.createMachine({
  id: "reflexion",
  context: ({ input }) => ({
    question: input.question,
    answer: null,
    reflection: null,
    searchQueries: [],
    searchResults: [],
    searches: [],
    attempts: [],
    references: [],
    revisions: 0,
    failure: null,
  }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "draft",
        input: ({ context }) => ({ question: context.question }),
        onDone: ({ output }) => ({
          target: "searching",
          context: {
            answer: output.result.answer,
            reflection: output.result.reflection,
            searchQueries: output.result.searchQueries,
            attempts: [
              {
                missing: output.result.reflection.missing,
                queries: output.result.searchQueries,
                cited: [],
                dropped: [],
              },
            ],
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `draft failed: ${String(event.error)}` },
        }),
      },
    },
    // execute_tools: run the reflection's queries.
    searching: {
      invoke: {
        src: "searchWeb",
        input: ({ context }) => ({ queries: context.searchQueries }),
        onDone: ({ context, output }) => ({
          target: "revising",
          context: {
            searchResults: output,
            searches: [
              ...context.searches,
              [...new Set(output.flatMap((round) => round.passages.map((passage) => passage.id)))],
            ],
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `search failed: ${String(event.error)}` },
        }),
      },
    },
    // revise: a grounded rewrite. Citations to passages this run never
    // retrieved are dropped here, and recorded.
    revising: {
      invoke: {
        src: "revise",
        input: ({ context }) => ({
          question: context.question,
          answer: context.answer ?? "",
          reflection: context.reflection ?? { missing: "", superfluous: "" },
          results: renderResults(context.searchResults),
        }),
        onDone: ({ context, output }) => {
          const retrieved = retrievedIds(context);
          const cited = [...new Set(output.result.references)];
          const kept = cited.filter((id) => retrieved.has(id));
          return {
            target: "reviewed",
            context: {
              answer: output.result.answer,
              reflection: output.result.reflection,
              searchQueries: output.result.searchQueries,
              references: kept,
              revisions: context.revisions + 1,
              attempts: [
                ...context.attempts,
                {
                  missing: output.result.reflection.missing,
                  queries: output.result.searchQueries,
                  cited: kept,
                  dropped: cited.filter((id) => !retrieved.has(id)),
                },
              ],
            },
          };
        },
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `revise failed: ${String(event.error)}` },
        }),
      },
    },
    // event_loop: stop after MAX_REVISIONS, else search on the new reflection.
    reviewed: {
      type: "choice",
      choice: ({ context }) =>
        context.revisions >= MAX_REVISIONS ? { target: "done" } : { target: "searching" },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        answer: context.answer ?? "",
        references: renderReferences(context),
        revisions: context.revisions,
        trail: renderTrail(context),
      }),
    },
    // Best effort: the latest answer, if any draft or revision landed.
    failed: {
      type: "final",
      output: ({ context }) => ({
        answer: context.answer ?? `No answer: ${context.failure ?? "unknown failure"}.`,
        references: renderReferences(context),
        revisions: context.revisions,
        trail: renderTrail(context),
      }),
    },
  },
});

export interface RunReflexionOptions {
  question?: string;
  /** Injected for tests; the direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export interface ReflexionResult {
  answer: string;
  references: string[];
  revisions: number;
  trail: string;
  /** Every state the run settled in; the last one is `done` or `failed`. */
  progress: string[];
}

/** Runs the Reflexion loop and records its state progress. */
export async function runReflexionExample(
  options: RunReflexionOptions = {},
): Promise<ReflexionResult> {
  const {
    question = "How should a small team roll out an AI coding assistant?",
    generateText,
    onProgress,
  } = options;

  const progress: string[] = [];
  const result = await runAgent(reflexionMachine, {
    input: { question },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    onTransition: (snapshot) => {
      const state = getStatePath(snapshot);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Reflexion example did not complete: ${result.status}`);
  }
  return { ...result.output, progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runReflexionExample({
      onProgress: (state) => console.log(`  → ${state}`),
    });
    console.log(`\n${result.trail}\n\n${result.answer}\n\n${result.references.join("\n")}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
