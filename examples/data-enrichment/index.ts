/**
 * Data enrichment — LangGraph's company-researcher template as a
 * schema-completeness loop with a visible search budget.
 *
 * The idea: given a company and a target schema (founded, headquarters, CEO,
 * employee count), search, read the results, and fill the schema. Keep going
 * until every requested field has a value AND a reviewer is satisfied with the
 * record, or the loop budget runs out.
 *
 * NOTE ON SEARCH: LangGraph's template calls Tavily search and a page scraper.
 * This example calls NO network: search is keyword overlap over
 * `SAMPLE_WEB_INDEX`, a tiny in-file index of passages about three FICTIONAL
 * companies, and every hit is prefixed `[sample web result]`. Swap the
 * `searchWeb` actor for a real search tool and the machine is unchanged.
 *
 * LangGraph shape (langchain-ai/data-enrichment, company-researcher):
 *
 *   START → call_agent_model ─┬─ tools (search / scrape) → call_agent_model
 *                             └─ Info tool → reflect ─┬─ END (satisfactory)
 *                                                     └─ call_agent_model (feedback)
 *           (the whole loop bounded by max_loops)
 *
 * Here the agent node is split into the three things it actually does, and the
 * two routing edges are states you can point at:
 *
 *   planningSearch → searching → extracting → checkingCompleteness ─┬─ reflecting → reviewed ─┬─ done
 *         ↑                                                         │                         ├─ planningSearch
 *         └───────────────── missing fields, loops < MAX_LOOPS ─────┤                         └─ failed
 *                                                                   └─ failed (budget spent)
 *
 * What maps to what:
 *   - call_agent_model (search tool call)  → `planningSearch` (a request returning one query)
 *   - tools: search / scrape               → `searching` (sample-data actor, labeled)
 *   - call_agent_model (Info tool call)    → `extracting` (structured output over a FIXED schema)
 *   - "is the Info payload complete?"      → `checkingCompleteness` (a `choice` state)
 *   - reflect                              → `reflecting` (ONE Jev call, one `noul` per field — see note)
 *   - reflect's conditional edge           → `reviewed` (a `choice` state)
 *   - max_loops                            → `loops` in context vs the exported `MAX_LOOPS`
 *
 * Differences from LangGraph worth calling out:
 *   - Completeness is checked by the machine, not the model. LangGraph asks the
 *     model to call the Info tool when it thinks it is done; here a `choice`
 *     state reads the record and only sends a COMPLETE record to reflection.
 *     A model that "gives up" early cannot skip a missing field.
 *   - The budget covers both loops: a missing field AND a reviewer rejection
 *     each cost one search pass, and both exits land in `failed` with the
 *     partial record when `MAX_LOOPS` is spent. LangGraph's max_loops ends the
 *     run by returning whatever the Info tool last saw, with no signal that
 *     it is incomplete.
 *   - One query per pass instead of a free-form tool-calling turn, so every
 *     search is a transition in the trail.
 *   - Reflection is a JUDGMENT, not a generation. LangGraph asks a chat model
 *     for `{ is_satisfactory, reason }`. Here `reflecting` invokes a TypeSafe
 *     System One actor (Jev) with the company, the requested fields of the
 *     record, and every passage as state, and asks one `noul` per requested
 *     field ("does a passage state `record.<field>`?"). The record is
 *     satisfactory when every probability clears `SUPPORT_THRESHOLD`; the
 *     feedback that steers the next search is RENDERED from the fields that
 *     did not, so it names exactly what to look for. The text model is
 *     reserved for the query and the extraction.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_API_KEY=... npx tsx examples/data-enrichment/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { noul, type TypeSafeClient } from "@typesafe-ai/sdk";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { createSystemOneLogic } from "@statelyai/agent/typesafe";
import { getStatePath, runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

const models = {
  researcher: openai("gpt-5.4-mini"),
};

/** Search passes (plan → search → extract) before the run ends in `failed`. */
export const MAX_LOOPS = 3;

/** New passages one search pass may add. */
export const SEARCH_LIMIT = 2;

export const FIELDS = ["founded", "headquarters", "ceo", "employees"] as const;
export type Field = (typeof FIELDS)[number];

const FIELD_LABELS: Record<Field, string> = {
  founded: "Founded",
  headquarters: "Headquarters",
  ceo: "CEO",
  employees: "Employees",
};

/**
 * Sample data: a stand-in for web search results about three FICTIONAL
 * companies. Each passage carries one or two fields; `facts` records which, so
 * tests can check what a passage actually supports. Cedar Grid Energy's
 * headcount appears nowhere, on purpose.
 */
export const SAMPLE_WEB_INDEX: Array<{
  id: string;
  text: string;
  facts: Partial<Record<Field, string>>;
}> = [
  {
    id: "northwind-profile",
    text: "Northwind Robotics was founded in 2014 and is headquartered in Pittsburgh, Pennsylvania.",
    facts: { founded: "2014", headquarters: "Pittsburgh, Pennsylvania" },
  },
  {
    id: "northwind-team",
    text: "Northwind Robotics CEO Dana Okafor leads a team of about 320 employees building warehouse robots.",
    facts: { ceo: "Dana Okafor", employees: "about 320" },
  },
  {
    id: "bluefin-history",
    text: "Bluefin Analytics was founded in 2019 by two former actuaries.",
    facts: { founded: "2019" },
  },
  {
    id: "bluefin-office",
    text: "Bluefin Analytics opened its headquarters in Lisbon, Portugal, after a Series A round.",
    facts: { headquarters: "Lisbon, Portugal" },
  },
  {
    id: "bluefin-leadership",
    text: "Bluefin Analytics named Priya Raman CEO in 2023; the company has 85 employees.",
    facts: { ceo: "Priya Raman", employees: "85" },
  },
  {
    id: "cedar-origin",
    text: "Cedar Grid Energy was founded in 2008 as a municipal microgrid operator.",
    facts: { founded: "2008" },
  },
  {
    id: "cedar-hq",
    text: "Cedar Grid Energy is headquartered in Boise, Idaho.",
    facts: { headquarters: "Boise, Idaho" },
  },
  {
    id: "cedar-ceo",
    text: "Cedar Grid Energy CEO Marcus Bell announced a battery storage pilot this spring.",
    facts: { ceo: "Marcus Bell" },
  },
];

const PASSAGE_PREFIX = "[sample web result] ";

/** Query terms: lowercased content words longer than two letters. */
function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
}

/**
 * Honest keyword search (NOT a live search API): passages that name the
 * company, not already seen, ranked by how many query terms they share.
 */
function searchIndex(input: { company: string; query: string; seen: string[] }): string[] {
  const company = input.company.toLowerCase();
  const queryTerms = new Set(terms(input.query));
  return SAMPLE_WEB_INDEX.map((entry) => `${PASSAGE_PREFIX}${entry.text}`)
    .filter((text) => text.toLowerCase().includes(company) && !input.seen.includes(text))
    .map((text) => ({
      text,
      score: terms(text).filter((term) => queryTerms.has(term)).length,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, SEARCH_LIMIT)
    .map((hit) => hit.text);
}

// A fixed object keeps the structured-output schema simple: every field is
// present, `null` meaning "not found yet".
const recordSchema = z.object({
  founded: z.string().nullable(),
  headquarters: z.string().nullable(),
  ceo: z.string().nullable(),
  employees: z.string().nullable(),
});
type CompanyRecord = z.infer<typeof recordSchema>;

const EMPTY_RECORD: CompanyRecord = {
  founded: null,
  headquarters: null,
  ceo: null,
  employees: null,
};

const fieldsSchema = z.array(z.enum(FIELDS)).min(1);

const contextSchema = z.object({
  company: z.string(),
  fields: fieldsSchema,
  // The current search pass's query; `null` before the first pass.
  query: z.string().nullable(),
  // Every passage read so far, in order. Extraction always sees all of them.
  passages: z.array(z.string()),
  record: recordSchema,
  // Completed search passes. Compared against MAX_LOOPS.
  loops: z.number(),
  // The reviewer's last verdict; `null` until `reflecting` has run.
  review: z.object({ satisfactory: z.boolean(), feedback: z.string() }).nullable(),
  // Why the run failed; `null` unless it did.
  failure: z.string().nullable(),
});
type EnrichmentContext = z.infer<typeof contextSchema>;

/** Requested fields that still have no value. */
function missingFields(context: Pick<EnrichmentContext, "fields" | "record">): Field[] {
  return context.fields.filter((field) => context.record[field] === null);
}

/** A newly extracted value wins; a field the extractor dropped keeps its old value. */
function mergeRecord(previous: CompanyRecord, next: CompanyRecord): CompanyRecord {
  return {
    founded: next.founded ?? previous.founded,
    headquarters: next.headquarters ?? previous.headquarters,
    ceo: next.ceo ?? previous.ceo,
    employees: next.employees ?? previous.employees,
  };
}

/** A value counts as backed by the passages when Jev's probability clears this. */
export const SUPPORT_THRESHOLD = 0.5;

/**
 * reflect as a System One judgment: the company, the requested fields of the
 * record, and every passage are the state, and each requested field gets its
 * own `noul`. One call, one probability per field, no prose. `client` is
 * injected by tests and hosts; omitted, the SDK reads `TYPESAFE_API_KEY`.
 */
export function createReviewRecord(client?: TypeSafeClient) {
  return createSystemOneLogic({
    client,
    state: (input: {
      company: string;
      fields: Field[];
      passages: string[];
      record: CompanyRecord;
    }) => ({
      company: input.company,
      record: Object.fromEntries(input.fields.map((field) => [field, input.record[field]])),
      passages: input.passages,
    }),
    questions: (input) =>
      Object.fromEntries(
        input.fields.map((field) => [
          field,
          noul(
            `Does a passage in \`passages\` directly state \`record.${field}\` ` +
              `(the ${FIELD_LABELS[field].toLowerCase()}) for \`company\`?`,
            {
              true: "A passage about this company states this exact value.",
              false:
                "No passage states it, a passage contradicts it, or the passage is about another company.",
            },
          ),
        ]),
      ),
  });
}

/** The reviewer feedback, rendered from the fields Jev did not find backed. */
function renderReviewFeedback(unsupported: Field[]): string {
  return unsupported.length === 0
    ? "Every value is backed by a passage."
    : `Not backed by the passages: ${unsupported.map((field) => FIELD_LABELS[field]).join(", ")}. Search for these again.`;
}

/** `Founded: 2014` lines for the requested fields. */
function renderRecord(context: EnrichmentContext): string {
  return context.fields
    .map((field) => `${FIELD_LABELS[field]}: ${context.record[field] ?? "(not found)"}`)
    .join("\n");
}

const outputSchema = z.object({
  summary: z.string(),
  record: recordSchema,
  loops: z.number(),
  missingFields: z.array(z.enum(FIELDS)),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({
    company: z.string(),
    fields: fieldsSchema.default([...FIELDS]),
  }),
  output: outputSchema,
  actors: {
    // tools: search. Sample-data stand-in for Tavily/scrape; see the header.
    searchWeb: createAsyncLogic<string[], { company: string; query: string; seen: string[] }>({
      run: async ({ input }) => searchIndex(input),
    }),
    // reflect: a Jev judgment per requested field (see createReviewRecord).
    reviewRecord: createReviewRecord(),
  },
  requests: {
    // call_agent_model, search turn: one query aimed at the missing fields.
    planSearch: {
      schemas: {
        input: z.object({
          company: z.string(),
          missingFields: z.array(z.string()),
          feedback: z.string().nullable(),
        }),
        output: z.object({ query: z.string() }),
      },
      model: "researcher",
      system:
        "You research companies. Write ONE short keyword search query that will find the " +
        "missing fields for the company. Include the company name. If reviewer feedback is " +
        "present, target what it says is wrong.",
      prompt: ({ input }) =>
        [
          `Company: ${input.company}`,
          `Missing fields: ${input.missingFields.join(", ") || "(none — re-check the record)"}`,
          `Reviewer feedback: ${input.feedback ?? "none"}`,
        ].join("\n"),
    },
    // call_agent_model, Info turn: fill the schema from the passages read so far.
    extractRecord: {
      schemas: {
        input: z.object({
          company: z.string(),
          passages: z.array(z.string()),
          record: recordSchema,
        }),
        output: z.object({ record: recordSchema }),
      },
      model: "researcher",
      system:
        "Fill the company record using ONLY the passages. Keep existing values unless a " +
        "passage contradicts them. Use null for any field no passage states. Never guess.",
      prompt: ({ input }) =>
        [
          `Company: ${input.company}`,
          `Current record: ${JSON.stringify(input.record)}`,
          "Passages:",
          ...(input.passages.length
            ? input.passages.map((passage, i) => `[${i + 1}] ${passage}`)
            : ["(none found)"]),
        ].join("\n"),
    },
  },
});

export const dataEnrichmentSchemas = agentSetup.schemas;

export const dataEnrichmentMachine = agentSetup.createMachine({
  id: "data-enrichment",
  context: ({ input }) => ({
    company: input.company,
    fields: input.fields,
    query: null,
    passages: [],
    record: EMPTY_RECORD,
    loops: 0,
    review: null,
    failure: null,
  }),
  initial: "planningSearch",
  states: {
    planningSearch: {
      invoke: {
        src: "planSearch",
        input: ({ context }) => ({
          company: context.company,
          missingFields: missingFields(context),
          feedback: context.review?.feedback ?? null,
        }),
        onDone: ({ output }) => ({
          target: "searching",
          context: { query: output.result.query },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `planSearch failed: ${String(event.error)}` },
        }),
      },
    },
    searching: {
      invoke: {
        src: "searchWeb",
        input: ({ context }) => ({
          company: context.company,
          query: context.query ?? context.company,
          seen: context.passages,
        }),
        // One search pass spent, whatever it found.
        onDone: ({ context, output }) => ({
          target: "extracting",
          context: { passages: [...context.passages, ...output], loops: context.loops + 1 },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `search failed: ${String(event.error)}` },
        }),
      },
    },
    extracting: {
      invoke: {
        src: "extractRecord",
        input: ({ context }) => ({
          company: context.company,
          passages: context.passages,
          record: context.record,
        }),
        onDone: ({ context, output }) => ({
          target: "checkingCompleteness",
          context: { record: mergeRecord(context.record, output.result.record) },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `extractRecord failed: ${String(event.error)}` },
        }),
      },
    },
    // Only a complete record goes to review. Otherwise search again while the
    // budget lasts, then fail with what was found.
    checkingCompleteness: {
      type: "choice",
      choice: ({ context }) => {
        if (missingFields(context).length === 0) return { target: "reflecting" };
        if (context.loops < MAX_LOOPS) return { target: "planningSearch" };
        return {
          target: "failed",
          context: {
            failure: `Search budget spent after ${MAX_LOOPS} passes with fields still missing.`,
          },
        };
      },
    },
    reflecting: {
      invoke: {
        src: "reviewRecord",
        input: ({ context }) => ({
          company: context.company,
          fields: context.fields,
          passages: context.passages,
          record: context.record,
        }),
        // Satisfactory iff every requested field clears the threshold; the
        // feedback names the ones that did not.
        onDone: ({ context, output }) => {
          const unsupported = context.fields.filter(
            (field) => (output.answers[field]?.noul ?? 0) < SUPPORT_THRESHOLD,
          );
          return {
            target: "reviewed",
            context: {
              review: {
                satisfactory: unsupported.length === 0,
                feedback: renderReviewFeedback(unsupported),
              },
            },
          };
        },
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `reviewRecord failed: ${String(event.error)}` },
        }),
      },
    },
    // reflect's conditional edge. A rejection costs a search pass like a gap does.
    reviewed: {
      type: "choice",
      choice: ({ context }) => {
        if (context.review?.satisfactory === true) return { target: "done" };
        if (context.loops < MAX_LOOPS) return { target: "planningSearch" };
        return {
          target: "failed",
          context: {
            failure: `Reviewer still unsatisfied after ${MAX_LOOPS} passes: ${context.review?.feedback ?? ""}`,
          },
        };
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        summary: `${context.company}\n${renderRecord(context)}`,
        record: context.record,
        loops: context.loops,
        missingFields: [],
      }),
    },
    // Best-effort terminal: the partial record, and why it stopped.
    failed: {
      type: "final",
      output: ({ context }) => ({
        summary: [
          `${context.company} (incomplete)`,
          renderRecord(context),
          context.failure ?? "Enrichment failed.",
        ].join("\n"),
        record: context.record,
        loops: context.loops,
        missingFields: missingFields(context),
      }),
    },
  },
});

export interface RunDataEnrichmentOptions {
  company?: string;
  fields?: Field[];
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Injected for tests; direct run lets the SDK read `TYPESAFE_API_KEY`. */
  jevClient?: TypeSafeClient;
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export type DataEnrichmentResult = z.infer<typeof outputSchema> & {
  /** `done` or `failed`. */
  finalState: string;
  progress: string[];
};

/** Runs the enrichment loop; records state progress so every pass is observable. */
export async function runDataEnrichmentExample(
  options: RunDataEnrichmentOptions = {},
): Promise<DataEnrichmentResult> {
  const { company = "Northwind Robotics", fields, generateText, jevClient, onProgress } = options;
  const progress: string[] = [];
  const result = await runAgent(dataEnrichmentMachine, {
    input: { company, ...(fields ? { fields } : {}) },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    ...(jevClient ? { actors: { reviewRecord: createReviewRecord(jevClient) } } : {}),
    onTransition: (snapshot) => {
      const state = getStatePath(snapshot);
      progress.push(state);
      onProgress?.(state);
    },
  });
  if (result.status !== "done") {
    throw new Error(`Data enrichment example did not complete: ${result.status}`);
  }
  return { ...result.output, finalState: progress.at(-1) ?? "", progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runDataEnrichmentExample({
      company: "Bluefin Analytics",
      onProgress: (state) => console.log(`  → ${state}`),
    });
    console.log(`\n${result.summary}\n(${result.loops} search pass(es), ${result.finalState})`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
