/**
 * STORM writer — outline a topic, interview it from several perspectives in
 * parallel, refine the outline from the interviews, then write the article
 * section by section.
 *
 * Ported from LangGraph's STORM tutorial (Shao et al. 2024, "Assisting in
 * Writing Wikipedia-like Articles From Scratch with Large Language Models").
 * The idea: an article is better researched when several simulated editors,
 * each with a different angle, interview a grounded expert before anyone
 * writes.
 *
 * NOTE ON SEARCH: LangGraph's expert answers with live web search (Tavily,
 * DuckDuckGo). This example calls NO network: the expert's search is keyword
 * overlap over `SAMPLE_INDEX`, a tiny in-file corpus, and every hit is
 * prefixed `[sample source]`. Swap the `searchSources` actor for a real search
 * tool and both machines are unchanged.
 *
 * LangGraph shape (tutorials/storm):
 *
 *   START → generate_outline → expand_topics → generate_perspectives
 *         → conduct_interviews (one interview subgraph per editor, in parallel)
 *              interview: ask_question → answer_question (search) ─┬─ ask_question
 *                                                                  └─ END (N turns or "Thank you so much")
 *         → refine_outline → index_references → write_sections → write_article → END
 *
 * Here the interview subgraph is its own exported machine, spawned once per
 * editor, and every loop is a counter against an exported constant:
 *
 *   storm:     outlining → choosingPerspectives → checkingEditors ─┬─ interviewing → collectingInterviews
 *                                                                   └─ failed (no editors)
 *              collectingInterviews → checkingInterviews → refiningOutline → checkingOutline
 *              → writingSection ⇄ nextSection → writingArticle → done
 *   interview: asking ─┬─ researching → answering → checkingTurns ─┬─ asking (turns < MAX_INTERVIEW_TURNS)
 *                      └─ done ("finished")                        └─ done
 *
 * What maps to what:
 *   - generate_outline          → `outlining` (request `draftOutline`)
 *   - generate_perspectives     → `choosingPerspectives` + `checkingEditors` (cap at MAX_EDITORS)
 *   - conduct_interviews        → `interviewing` spawns one `interviewMachine` per editor;
 *                                 `collectingInterviews` reduces transcripts as each lands
 *   - ask_question              → interview `asking` (request `askQuestion`)
 *   - answer_question's search  → interview `researching` (sample-data actor)
 *   - answer_question           → interview `answering` (request `answerQuestion`)
 *   - route_messages            → interview `checkingTurns` (a `choice` state) + `asking`'s onDone
 *   - refine_outline            → `refiningOutline` (headings past MAX_SECTIONS are dropped, counted)
 *   - write_sections            → `writingSection` ⇄ `nextSection`, one request per heading
 *   - write_article             → `writingArticle`
 *
 * Differences from LangGraph worth calling out:
 *   - Scope is deliberately small: MAX_EDITORS = 2, MAX_INTERVIEW_TURNS = 2,
 *     MAX_SECTIONS = 4. LangGraph's tutorial bounds the interview with a
 *     max_num_turns check in a router function; here each bound is a guard
 *     over a context counter you can read off the diagram.
 *   - Editors and headings the model proposes beyond the caps are dropped and
 *     COUNTED in the trail, not silently truncated.
 *   - expand_topics (related-subject survey) and index_references (a vector
 *     store of cited pages) are folded away: the sample index plays both parts.
 *   - A failed interview is counted, not fatal. Zero usable interviews, zero
 *     editors, or an empty outline land in `failed` with the trail so far.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/storm-writer/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getStatePath,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
  type DoneActorEventOf,
} from "@statelyai/agent";

const models = {
  writer: openai("gpt-6-luna"),
  editor: openai("gpt-6-luna"),
  expert: openai("gpt-6-luna"),
};

/** Perspectives interviewed; extra editors the model proposes are dropped. */
export const MAX_EDITORS = 2;
/** Question/answer exchanges per interview. */
export const MAX_INTERVIEW_TURNS = 2;
/** Sections written; extra headings in the refined outline are dropped. */
export const MAX_SECTIONS = 4;

/**
 * Sample data: a stand-in for the expert's web search, covering three topics.
 * Anything else finds nothing — honestly reported as such.
 */
export const SAMPLE_INDEX: Array<{ id: string; text: string }> = [
  {
    id: "fsm-control",
    text: "State machines give AI agents explicit control flow: each state names what the agent is doing and which transitions are legal next.",
  },
  {
    id: "fsm-budgets",
    text: "Loop budgets in agent state machines are counters checked by guards, so a runaway agent loop ends in a named failure state.",
  },
  {
    id: "fsm-inspection",
    text: "Because a state machine is data, tools can render, lint, and replay an agent's run transition by transition.",
  },
  {
    id: "rag-basics",
    text: "Retrieval-augmented generation fetches relevant documents at query time and conditions the model's generation on them.",
  },
  {
    id: "rag-grading",
    text: "Corrective retrieval grades retrieved documents and falls back to another source when retrieval is weak.",
  },
  {
    id: "injection-attack",
    text: "Prompt injection hides instructions inside untrusted input so the model follows the attacker instead of the developer.",
  },
  {
    id: "injection-defenses",
    text: "Defenses against prompt injection include privilege separation, allow-listed tools, and human approval before side effects.",
  },
];

const SOURCE_PREFIX = "[sample source] ";
const NO_SOURCES = `${SOURCE_PREFIX}No sample passages matched this question.`;

const STOP_WORDS = new Set([
  "about",
  "does",
  "from",
  "have",
  "into",
  "know",
  "more",
  "should",
  "that",
  "their",
  "they",
  "this",
  "what",
  "when",
  "which",
  "with",
  "would",
  "your",
  "readers",
]);

/** Honest keyword overlap (NOT embeddings, NOT a live search API). Top 2. */
function searchSampleIndex(input: { topic: string; question: string }): string[] {
  const terms = new Set(
    `${input.topic} ${input.question}`
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word)),
  );
  const hits = SAMPLE_INDEX.map((entry) => ({
    text: entry.text,
    score: [...terms].filter((term) => entry.text.toLowerCase().includes(term)).length,
  }))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .map((hit) => `${SOURCE_PREFIX}${hit.text}`);
  return hits.length > 0 ? hits : [NO_SOURCES];
}

const editorSchema = z.object({
  name: z.string(),
  affiliation: z.string(),
  focus: z.string(),
});
type Editor = z.infer<typeof editorSchema>;

const exchangeSchema = z.object({
  question: z.string(),
  answer: z.string(),
  sources: z.array(z.string()),
});
type Exchange = z.infer<typeof exchangeSchema>;

function renderInterview(editor: Editor, exchanges: Exchange[], closing: string | null): string {
  return [
    `Interview with ${editor.name} (${editor.affiliation}; focus: ${editor.focus})`,
    ...exchanges.flatMap((exchange) => [
      `Q: ${exchange.question}`,
      `A: ${exchange.answer}`,
      ...exchange.sources.map((source) => `  ${source}`),
    ]),
    ...(closing ? [`Q: ${closing}`] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The interview subgraph: one editor, one grounded expert, bounded turns.
// ---------------------------------------------------------------------------

const interviewContextSchema = z.object({
  topic: z.string(),
  editor: editorSchema,
  exchanges: z.array(exchangeSchema),
  // Completed exchanges. Compared against MAX_INTERVIEW_TURNS.
  turns: z.number(),
  // The question in flight, and what the search found for it.
  question: z.string().nullable(),
  sources: z.array(z.string()),
  // The editor's closing line when it ends the interview itself.
  closing: z.string().nullable(),
  failure: z.string().nullable(),
});

const interviewSetup = setupAgent({
  models,
  context: interviewContextSchema,
  input: z.object({ topic: z.string(), editor: editorSchema }),
  // `failed` marks an interview cut short by an error; its exchanges still count.
  output: z.object({ transcript: z.string(), exchanges: z.number(), failed: z.boolean() }),
  actors: {
    searchSources: createAsyncLogic<string[], { topic: string; question: string }>({
      run: async ({ input }) => searchSampleIndex(input),
    }),
  },
  requests: {
    askQuestion: {
      schemas: {
        input: z.object({ topic: z.string(), editor: editorSchema, transcript: z.string() }),
        output: z.object({ question: z.string(), finished: z.boolean() }),
      },
      model: "editor",
      system:
        "You are a Wikipedia editor interviewing an expert to research an article. Stay in " +
        "your persona and focus. Ask ONE new question. When you have what you need, set " +
        "finished to true and thank the expert instead of asking.",
      prompt: ({ input }) =>
        [
          `Topic: ${input.topic}`,
          `You are ${input.editor.name} (${input.editor.affiliation}). Focus: ${input.editor.focus}`,
          input.transcript,
        ].join("\n"),
    },
    answerQuestion: {
      schemas: {
        input: z.object({ topic: z.string(), question: z.string(), sources: z.array(z.string()) }),
        output: z.object({ answer: z.string() }),
      },
      model: "expert",
      system:
        "You are an expert answering an editor's question. Use ONLY the sources. If they do " +
        "not cover the question, say so. At most three sentences.",
      prompt: ({ input }) =>
        [`Topic: ${input.topic}`, `Question: ${input.question}`, "Sources:", ...input.sources].join(
          "\n",
        ),
    },
  },
});

export const interviewMachine = interviewSetup.createMachine({
  id: "storm-interview",
  context: ({ input }) => ({
    topic: input.topic,
    editor: input.editor,
    exchanges: [],
    turns: 0,
    question: null,
    sources: [],
    closing: null,
    failure: null,
  }),
  output: ({ context }) => ({
    transcript: [
      renderInterview(context.editor, context.exchanges, context.closing),
      ...(context.failure ? [`(interview cut short: ${context.failure})`] : []),
    ].join("\n"),
    exchanges: context.exchanges.length,
    failed: context.failure !== null,
  }),
  initial: "asking",
  states: {
    // The editor asks, or ends the interview ("Thank you so much").
    asking: {
      invoke: {
        src: "askQuestion",
        input: ({ context }) => ({
          topic: context.topic,
          editor: context.editor,
          transcript: renderInterview(context.editor, context.exchanges, null),
        }),
        onDone: ({ output }) =>
          output.result.finished
            ? { target: "done", context: { closing: output.result.question } }
            : { target: "researching", context: { question: output.result.question } },
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `askQuestion failed: ${String(event.error)}` },
        }),
      },
    },
    researching: {
      invoke: {
        src: "searchSources",
        input: ({ context }) => ({ topic: context.topic, question: context.question ?? "" }),
        onDone: ({ output }) => ({ target: "answering", context: { sources: output } }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `search failed: ${String(event.error)}` },
        }),
      },
    },
    answering: {
      invoke: {
        src: "answerQuestion",
        input: ({ context }) => ({
          topic: context.topic,
          question: context.question ?? "",
          sources: context.sources,
        }),
        onDone: ({ context, output }) => ({
          target: "checkingTurns",
          context: {
            exchanges: [
              ...context.exchanges,
              {
                question: context.question ?? "",
                answer: output.result.answer,
                sources: context.sources,
              },
            ],
            turns: context.turns + 1,
            question: null,
            sources: [],
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `answerQuestion failed: ${String(event.error)}` },
        }),
      },
    },
    checkingTurns: {
      type: "choice",
      choice: ({ context }) =>
        context.turns < MAX_INTERVIEW_TURNS ? { target: "asking" } : { target: "done" },
    },
    done: { type: "final" },
    // Best-effort: the exchanges so far, marked as cut short.
    failed: { type: "final" },
  },
});

// ---------------------------------------------------------------------------
// The STORM coordinator.
// ---------------------------------------------------------------------------

const INTERVIEW_PREFIX = "interview-";

const contextSchema = z.object({
  topic: z.string(),
  outline: z.array(z.string()),
  editors: z.array(editorSchema),
  droppedEditors: z.number(),
  // Transcripts keyed by spawned interview id, as each one lands.
  transcripts: z.record(z.string(), z.string()),
  exchanges: z.number(),
  failedInterviews: z.array(z.string()),
  // Interviews spawned, and interviews settled (finished or errored).
  expected: z.number(),
  settled: z.number(),
  droppedHeadings: z.number(),
  // The heading being written. Compared against MAX_SECTIONS.
  sectionIndex: z.number(),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })),
  article: z.string().nullable(),
  failure: z.string().nullable(),
});
type StormContext = z.infer<typeof contextSchema>;

/** The plain-language run trail, rendered from counts in context. */
function renderTrail(context: StormContext): string {
  const interviews = Object.keys(context.transcripts).length;
  return [
    `Outline: ${context.outline.length} heading(s)` +
      (context.droppedHeadings ? ` (${context.droppedHeadings} dropped past ${MAX_SECTIONS})` : ""),
    `Editors: ${context.editors.length}` +
      (context.droppedEditors ? ` (${context.droppedEditors} dropped past ${MAX_EDITORS})` : ""),
    `Interviews: ${interviews} (${context.exchanges} exchange(s)` +
      (context.failedInterviews.length ? `, ${context.failedInterviews.length} failed)` : ")"),
    `Sections written: ${context.sections.length}`,
    ...(context.failure ? [`Stopped: ${context.failure}`] : []),
  ].join("\n");
}

const outputSchema = z.object({
  article: z.string(),
  outline: z.array(z.string()),
  interviews: z.number(),
  sections: z.number(),
  trail: z.string(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ topic: z.string() }),
  output: outputSchema,
  actors: { interview: interviewMachine },
  requests: {
    draftOutline: {
      schemas: {
        input: z.object({ topic: z.string() }),
        output: z.object({ outline: z.array(z.string()) }),
      },
      model: "writer",
      system: "Draft a Wikipedia-style outline for the topic: three to five section headings.",
      prompt: ({ input }) => `Topic: ${input.topic}`,
    },
    choosePerspectives: {
      schemas: {
        input: z.object({ topic: z.string(), outline: z.array(z.string()) }),
        output: z.object({ editors: z.array(editorSchema) }),
      },
      model: "writer",
      system:
        "Propose distinct editors who would research this topic from different angles. Each " +
        "has a name, an affiliation, and the focus they care about.",
      prompt: ({ input }) => `Topic: ${input.topic}\nDraft outline:\n${input.outline.join("\n")}`,
    },
    refineOutline: {
      schemas: {
        input: z.object({
          topic: z.string(),
          outline: z.array(z.string()),
          interviews: z.array(z.string()),
        }),
        output: z.object({ outline: z.array(z.string()) }),
      },
      model: "writer",
      system:
        "Refine the outline using what the interviews found. Keep headings the interviews can " +
        "support; drop the rest. Return section headings only.",
      prompt: ({ input }) =>
        [
          `Topic: ${input.topic}`,
          `Draft outline:\n${input.outline.join("\n")}`,
          `Interviews:\n${input.interviews.join("\n\n")}`,
        ].join("\n\n"),
    },
    writeSection: {
      schemas: {
        input: z.object({
          topic: z.string(),
          heading: z.string(),
          interviews: z.array(z.string()),
        }),
        output: z.object({ section: z.string() }),
      },
      model: "writer",
      system:
        "Write one article section under the heading, using ONLY facts from the interviews. " +
        "Cite sources inline as [sample source]. At most one paragraph.",
      prompt: ({ input }) =>
        `Topic: ${input.topic}\nHeading: ${input.heading}\n\nInterviews:\n${input.interviews.join("\n\n")}`,
    },
    writeArticle: {
      schemas: {
        input: z.object({
          topic: z.string(),
          sections: z.array(z.object({ heading: z.string(), body: z.string() })),
        }),
        output: z.object({ article: z.string() }),
      },
      model: "writer",
      system:
        "Assemble the sections into one article with a short lead paragraph. Keep each section's " +
        "heading and citations. Add no new facts.",
      prompt: ({ input }) =>
        [
          `Topic: ${input.topic}`,
          ...input.sections.map((section) => `## ${section.heading}\n${section.body}`),
        ].join("\n\n"),
    },
  },
});

export const stormWriterSchemas = agentSetup.schemas;

export const stormWriterMachine = agentSetup.createMachine({
  id: "storm-writer",
  context: ({ input }) => ({
    topic: input.topic,
    outline: [],
    editors: [],
    droppedEditors: 0,
    transcripts: {},
    exchanges: 0,
    failedInterviews: [],
    expected: 0,
    settled: 0,
    droppedHeadings: 0,
    sectionIndex: 0,
    sections: [],
    article: null,
    failure: null,
  }),
  initial: "outlining",
  states: {
    outlining: {
      invoke: {
        src: "draftOutline",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({
          target: "choosingPerspectives",
          context: { outline: output.result.outline },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `draftOutline failed: ${String(event.error)}` },
        }),
      },
    },
    choosingPerspectives: {
      invoke: {
        src: "choosePerspectives",
        input: ({ context }) => ({ topic: context.topic, outline: context.outline }),
        onDone: ({ output }) => ({
          target: "checkingEditors",
          context: { editors: output.result.editors },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `choosePerspectives failed: ${String(event.error)}` },
        }),
      },
    },
    // Zero editors is a dead end; more than MAX_EDITORS are dropped and counted.
    checkingEditors: {
      type: "choice",
      choice: ({ context }) =>
        context.editors.length === 0
          ? { target: "failed", context: { failure: "No perspectives to interview." } }
          : {
              target: "interviewing",
              context: {
                editors: context.editors.slice(0, MAX_EDITORS),
                droppedEditors: Math.max(0, context.editors.length - MAX_EDITORS),
                expected: Math.min(context.editors.length, MAX_EDITORS),
                settled: 0,
              },
            },
    },
    // DYNAMIC FAN-OUT: one interview child per editor, running in parallel.
    interviewing: {
      entry: ({ context, actors }, enq) => {
        context.editors.forEach((editor, index) => {
          enq.spawn(actors.interview, {
            id: `${INTERVIEW_PREFIX}${index}`,
            input: { topic: context.topic, editor },
          });
        });
      },
      always: { target: "collectingInterviews" },
    },
    // REDUCE: fold each transcript in as its interview lands; an errored
    // interview still counts as settled so the run cannot park here.
    collectingInterviews: {
      on: {
        "xstate.done.actor": ({ context, event }) => {
          const { actorId, output } = event as DoneActorEventOf<typeof interviewMachine>;
          if (!actorId.startsWith(INTERVIEW_PREFIX)) return undefined;
          // An interview that errored before any exchange has nothing to use.
          const usable = !output.failed || output.exchanges > 0;
          const next = {
            settled: context.settled + 1,
            transcripts: usable
              ? { ...context.transcripts, [actorId]: output.transcript }
              : context.transcripts,
            exchanges: context.exchanges + output.exchanges,
            failedInterviews: output.failed
              ? [...context.failedInterviews, actorId]
              : context.failedInterviews,
          };
          return next.settled >= context.expected
            ? { target: "checkingInterviews" as const, context: next }
            : { context: next };
        },
        "xstate.error.actor": ({ context, event }) => {
          const { actorId } = event as unknown as { actorId: string };
          if (!actorId.startsWith(INTERVIEW_PREFIX)) return undefined;
          const next = {
            settled: context.settled + 1,
            failedInterviews: [...context.failedInterviews, actorId],
          };
          return next.settled >= context.expected
            ? { target: "checkingInterviews" as const, context: next }
            : { context: next };
        },
      },
    },
    checkingInterviews: {
      type: "choice",
      choice: ({ context }) =>
        Object.keys(context.transcripts).length === 0
          ? { target: "failed", context: { failure: "No interview produced a usable transcript." } }
          : { target: "refiningOutline" },
    },
    refiningOutline: {
      invoke: {
        src: "refineOutline",
        input: ({ context }) => ({
          topic: context.topic,
          outline: context.outline,
          interviews: Object.values(context.transcripts),
        }),
        // Headings past MAX_SECTIONS are dropped here and counted in the trail.
        onDone: ({ output }) => ({
          target: "checkingOutline",
          context: {
            outline: output.result.outline.slice(0, MAX_SECTIONS),
            droppedHeadings: Math.max(0, output.result.outline.length - MAX_SECTIONS),
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `refineOutline failed: ${String(event.error)}` },
        }),
      },
    },
    checkingOutline: {
      type: "choice",
      choice: ({ context }) =>
        context.outline.length === 0
          ? { target: "failed", context: { failure: "The refined outline is empty." } }
          : { target: "writingSection", context: { sectionIndex: 0, sections: [] } },
    },
    writingSection: {
      invoke: {
        src: "writeSection",
        input: ({ context }) => ({
          topic: context.topic,
          heading: context.outline[context.sectionIndex] ?? "",
          interviews: Object.values(context.transcripts),
        }),
        onDone: ({ context, output }) => ({
          target: "nextSection",
          context: {
            sections: [
              ...context.sections,
              {
                heading: context.outline[context.sectionIndex] ?? "",
                body: output.result.section,
              },
            ],
            sectionIndex: context.sectionIndex + 1,
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `writeSection failed: ${String(event.error)}` },
        }),
      },
    },
    nextSection: {
      type: "choice",
      choice: ({ context }) =>
        context.sectionIndex < Math.min(context.outline.length, MAX_SECTIONS)
          ? { target: "writingSection" }
          : { target: "writingArticle" },
    },
    writingArticle: {
      invoke: {
        src: "writeArticle",
        input: ({ context }) => ({ topic: context.topic, sections: context.sections }),
        onDone: ({ output }) => ({ target: "done", context: { article: output.result.article } }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `writeArticle failed: ${String(event.error)}` },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        article: context.article ?? "",
        outline: context.outline,
        interviews: Object.keys(context.transcripts).length,
        sections: context.sections.length,
        trail: renderTrail(context),
      }),
    },
    // Best-effort terminal: whatever sections were written, and the trail.
    failed: {
      type: "final",
      output: ({ context }) => ({
        article: [
          `No finished article on "${context.topic}".`,
          ...context.sections.map((section) => `## ${section.heading}\n${section.body}`),
        ].join("\n\n"),
        outline: context.outline,
        interviews: Object.keys(context.transcripts).length,
        sections: context.sections.length,
        trail: renderTrail(context),
      }),
    },
  },
});

export interface RunStormWriterOptions {
  topic?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each coordinator transition. */
  onProgress?: (state: string) => void;
}

export type StormWriterResult = z.infer<typeof outputSchema> & {
  finalState: string;
  progress: string[];
};

/** Runs STORM; records coordinator progress so every phase is observable. */
export async function runStormWriterExample(
  options: RunStormWriterOptions = {},
): Promise<StormWriterResult> {
  const { topic = "state machines for AI agents", generateText, onProgress } = options;
  const progress: string[] = [];
  const result = await runAgent(stormWriterMachine, {
    input: { topic },
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
    throw new Error(`STORM writer example did not complete: ${result.status}`);
  }
  return { ...result.output, finalState: progress.at(-1) ?? "", progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runStormWriterExample({
      onProgress: (state) => console.log(`  → ${state}`),
    });
    console.log(`\n${result.article}\n\n${result.trail}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
