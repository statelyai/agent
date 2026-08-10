/**
 * Chat-with-PDF quiz mode — the same recipe agentcn ships, with the sequencing
 * lifted out of the prompt and into the machine.
 *
 * The agentcn recipe (`registry/*​/chat-with-pdf/instructions.md`) writes the
 * quiz loop as prose the model is asked to obey:
 *
 *   - "Ask ONE question at a time"
 *   - "After 3-4 questions, call the tool AGAIN to get fresh content from
 *     different pages"
 *   - "ALWAYS include the documentId parameter to query the correct document"
 *   - "Every question MUST include a hint telling the user which page has the
 *     answer"
 *   - "ONLY create questions from retrieved content"
 *   - "If multiple documents exist, ask the user which one they want"
 *
 * Those are a counter, a coverage set, a piece of session state, a formatting
 * invariant, a grounding invariant, and a branch. Written as instructions they
 * hold for a few turns and then drift, because the *rules* live in the system
 * prompt but the *state they talk about* lives only in conversation history.
 *
 * Here each one is structure instead:
 *   - one question per entry into `asking`, so "one at a time" is not a request
 *   - `sinceRefresh` / `refreshEvery` guard, so the refresh is a transition
 *   - `pagesCovered` passed to retrieval as `excludePages`, so "different pages"
 *     is enforced by the query, not remembered by the model
 *   - `documentId` in context, threaded into every retrieval by the machine
 *   - the page hint is read off the retrieved chunk, never generated
 *   - grading is grounded on the exact chunk that produced the question
 *   - `choosingDocument` is a real idle state, so an ambiguous corpus cannot be
 *     silently guessed past
 *
 * What stays prose: voice and question formatting (`QUIZ_VOICE`). Models follow
 * that well, and encoding it as states would be ceremony.
 *
 * Retrieval is honest keyword scoring over an in-file corpus (same approach as
 * `examples/rag`). A real build swaps `queryPdfContent` for a vector store; the
 * machine shape is unchanged.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/chat-with-pdf/index.ts
 */
import { z } from "zod";
import type { SnapshotFrom } from "xstate";
import { createAsyncLogic } from "xstate";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { createAgentSchemas, getStateMeta, runAgent, setupAgent } from "@statelyai/agent";

/**
 * The part of the original instructions.md that is genuinely prose: tone and
 * question shape. Everything the original said about *sequencing* is gone from
 * this string — it moved into the machine below.
 */
const QUIZ_VOICE = [
  "You write quiz questions from a passage of a document.",
  "Write exactly one question from the passage you are given.",
  "Mix question types across a session: multiple choice, short answer, true/false.",
  "For multiple choice, give four plausible options; exactly one is correct.",
  "If the passage contains code, include the code in the question so it can be",
  "answered without opening the document.",
  "Be encouraging — learning is the goal.",
].join("\n");

/** A page of an indexed document. Stands in for a chunk in a vector store. */
const chunkSchema = z.object({
  documentId: z.string(),
  pageNumber: z.number(),
  content: z.string(),
});

type Chunk = z.infer<typeof chunkSchema>;

const questionSchema = z.object({
  type: z.enum(["multiple-choice", "short-answer", "true-false"]),
  question: z.string(),
  /** Empty for short-answer and true/false. */
  choices: z.array(z.string()),
});

const gradeSchema = z.object({
  correct: z.boolean(),
  /** The answer the passage supports, shown back to the learner. */
  expected: z.string(),
  explanation: z.string(),
});

/**
 * Sample data: two indexed "documents". Two, not one, so the ambiguous-corpus
 * branch is real rather than hypothetical.
 */
export const SAMPLE_LIBRARY: Array<{ id: string; title: string; pages: Chunk[] }> = [
  {
    id: "statecharts",
    title: "Statecharts in Practice",
    pages: [
      "A state machine is in exactly one of a finite set of states at a time. Events cause transitions between those states.",
      "Context is the extended state of a machine: arbitrary data stored alongside the finite state and updated during transitions.",
      "A guard is a condition that must hold for a transition to be taken. Guards are how illegal transitions stay impossible.",
      "Invoking an actor starts it when a state is entered and stops it when the state is exited. onDone and onError handle its result.",
      "Hierarchical states nest: a parent state's transitions apply to every child, so shared handling is written once.",
      "Parallel states run several regions at the same time. The machine is in one state per region.",
      "A final state signals that a machine or region is done. A top-level final state produces the machine's output.",
      "History states remember which child was active when a parent was last exited, so re-entry resumes where it left off.",
      "Snapshots serialize the whole running state, which is what makes a paused machine resumable in a different process.",
    ].map((content, index) => ({ documentId: "statecharts", pageNumber: index + 1, content })),
  },
  {
    id: "retrieval",
    title: "Retrieval Systems",
    pages: [
      "Chunking splits a document into passages small enough to embed but large enough to stand alone when read.",
      "An embedding maps text to a vector so that semantically similar passages land near each other.",
      "Top-k retrieval returns the k nearest chunks to a query vector. Larger k trades precision for recall.",
      "Stratified sampling draws from early, middle, and late sections instead of clustering on whichever section scores highest.",
      "Grounding means answering only from retrieved text. An answer with no supporting chunk is a hallucination regardless of how plausible it reads.",
      "Citations tie each claim back to the passage it came from, which is what makes a grounded answer checkable.",
    ].map((content, index) => ({ documentId: "retrieval", pageNumber: index + 1, content })),
  },
];

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "of",
  "to",
  "in",
  "and",
  "what",
  "how",
  "why",
  "do",
  "does",
  "about",
  "for",
  "with",
  "that",
  "this",
  "it",
]);

/** Shared content words between a topic and a page. Not embeddings. */
function scorePage(topic: string, text: string): number {
  const terms = new Set(
    topic
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

/**
 * Take from early, middle, and late thirds in turn.
 *
 * The original instructions asked the model to notice that "the tool returns a
 * stratified sample". Here the tool actually returns one.
 */
function stratify(pages: Chunk[], limit: number): Chunk[] {
  if (pages.length <= limit) return pages;
  const third = Math.ceil(pages.length / 3);
  const bands = [pages.slice(0, third), pages.slice(third, third * 2), pages.slice(third * 2)];
  const out: Chunk[] = [];
  for (let round = 0; out.length < limit; round += 1) {
    const before = out.length;
    for (const band of bands) {
      const page = band[round];
      if (page && out.length < limit) out.push(page);
    }
    // Every band is exhausted — stop rather than spin.
    if (out.length === before) break;
  }
  return out;
}

export interface QueryPdfInput {
  documentId: string;
  topic: string;
  pageStart: number | null;
  pageEnd: number | null;
  /** Pages already quizzed on. The query never returns these. */
  excludePages: number[];
  limit: number;
}

/** Page-range filter, keyword score, exclusion, then stratified sample. */
export function queryPdfContent(input: QueryPdfInput): Chunk[] {
  const document = SAMPLE_LIBRARY.find((entry) => entry.id === input.documentId);
  if (!document) return [];
  const excluded = new Set(input.excludePages);
  const inRange = document.pages.filter(
    (page) =>
      !excluded.has(page.pageNumber) &&
      (input.pageStart === null || page.pageNumber >= input.pageStart) &&
      (input.pageEnd === null || page.pageNumber <= input.pageEnd),
  );
  // A blank topic means "anywhere in range" — keep page order and stratify.
  const candidates = input.topic.trim()
    ? inRange
        .map((page) => ({ page, score: scorePage(input.topic, page.content) }))
        .filter((scored) => scored.score > 0)
        .sort(
          (left, right) => right.score - left.score || left.page.pageNumber - right.page.pageNumber,
        )
        .map((scored) => scored.page)
    : inRange;
  return stratify(candidates, input.limit);
}

const askedQuestionSchema = z.object({
  pageNumber: z.number(),
  prompt: z.string(),
  /** The exact passage the question came from — grading is grounded on it. */
  sourceText: z.string(),
});

const resultSchema = z.object({
  pageNumber: z.number(),
  prompt: z.string(),
  answer: z.string(),
  correct: z.boolean(),
  explanation: z.string(),
});

const models = defineModels({
  quiz: openai("gpt-5.4-mini"),
});

/** Typed `meta.interaction` hints a host reads off an idle snapshot. */
const metaSchema = z.object({
  interaction: z
    .object({
      label: z.string(),
      events: z
        .record(
          z.string(),
          z.object({
            label: z.string().optional(),
            style: z.enum(["primary", "danger", "default"]).optional(),
          }),
        )
        .optional(),
      textEvent: z.string().optional(),
    })
    .optional(),
});

export const chatWithPdfSchemas = createAgentSchemas({
  meta: metaSchema,
  context: z.object({
    /** Session state, not a prompt reminder: every retrieval reads it. */
    documentId: z.string().nullable(),
    documentTitle: z.string(),
    topic: z.string(),
    pageStart: z.number().nullable(),
    pageEnd: z.number().nullable(),
    maxQuestions: z.number(),
    /** Refresh retrieval after this many questions. Was "after 3-4 questions". */
    refreshEvery: z.number(),
    chunks: z.array(chunkSchema),
    chunkCursor: z.number(),
    /** Was "get fresh content from different pages". Now a query parameter. */
    pagesCovered: z.array(z.number()),
    questionsAsked: z.number(),
    sinceRefresh: z.number(),
    pending: askedQuestionSchema.nullable(),
    results: z.array(resultSchema),
    /** Rendered label for whatever the idle state is waiting on. */
    prompt: z.string(),
    /** Verdict on the previous answer, shown above the next question. */
    lastGrade: z.string(),
    /** Set when retrieval comes back empty; explains an early summary. */
    exhausted: z.boolean(),
  }),
  // Defaults are declared once, here: `runAgent` validates input against this
  // schema before the actor starts, so the context factory below receives them
  // already filled. A run can start with nothing but a question budget — the
  // machine resolves the rest (document choice included) as states.
  input: z.object({
    documentId: z.string().nullable().default(null),
    topic: z.string().default(""),
    pageStart: z.number().nullable().default(null),
    pageEnd: z.number().nullable().default(null),
    maxQuestions: z.number().default(6),
    refreshEvery: z.number().default(3),
  }),
  output: z.object({
    documentId: z.string(),
    correct: z.number(),
    answered: z.number(),
    pagesCovered: z.array(z.number()),
    results: z.array(resultSchema),
    exhausted: z.boolean(),
  }),
  events: {
    /** Free text at the document picker; matched against id or title. */
    SELECT_DOCUMENT: z.object({ documentId: z.string() }),
    ANSWER: z.object({ text: z.string() }),
    SKIP: z.object({}),
    STOP: z.object({}),
  },
  emitted: {
    QUESTION: z.object({ prompt: z.string(), pageNumber: z.number() }),
    GRADED: z.object({ correct: z.boolean(), expected: z.string(), explanation: z.string() }),
  },
});

const agentSetup = setupAgent({
  schemas: chatWithPdfSchemas,
  models,
  // Deterministic idle detection: the states waiting on the human are exactly
  // the ones tagged `waiting`.
  isSuspended: (snapshot) => snapshot.hasTag("waiting"),
  actors: {
    // Plain typed actor — no model in the retrieval path.
    retrieve: createAsyncLogic<Chunk[], QueryPdfInput>({
      run: async ({ input }) => queryPdfContent(input),
    }),
  },
  requests: {
    writeQuestion: {
      schemas: {
        input: z.object({
          passage: z.string(),
          questionNumber: z.number(),
          askedSoFar: z.array(z.string()),
        }),
        output: questionSchema,
      },
      model: "quiz",
      system: QUIZ_VOICE,
      prompt: ({ input }) =>
        [
          `Passage:\n${input.passage}`,
          input.askedSoFar.length
            ? `\nAlready asked (vary the type and angle):\n${input.askedSoFar.join("\n")}`
            : "",
          `\nWrite question ${input.questionNumber} from this passage only.`,
        ].join("\n"),
    },
    gradeAnswer: {
      schemas: {
        input: z.object({
          prompt: z.string(),
          answer: z.string(),
          // Grading sees the source passage, so it cannot grade from memory.
          sourceText: z.string(),
          pageNumber: z.number(),
        }),
        output: gradeSchema,
      },
      model: "quiz",
      system:
        "Grade a quiz answer against the source passage ONLY. Be encouraging. " +
        "Accept answers that are right in substance even if worded differently. " +
        "Return `expected` as the answer the passage supports, in one line. " +
        "In the explanation, quote or paraphrase the passage and name the page.",
      prompt: ({ input }) =>
        [
          `Source passage (page ${input.pageNumber}):\n${input.sourceText}`,
          `\nQuestion: ${input.prompt}`,
          `Learner's answer: ${input.answer}`,
        ].join("\n"),
    },
  },
  states: {
    // `asking` always sets `pending` before `awaitingAnswer` / `grading` read
    // it, so those two states can be narrowed non-null.
    awaitingAnswer: { context: { pending: askedQuestionSchema } },
    grading: { context: { pending: askedQuestionSchema } },
  },
});

type QuizContext = {
  chunks: Chunk[];
  chunkCursor: number;
  questionsAsked: number;
  maxQuestions: number;
  sinceRefresh: number;
  refreshEvery: number;
};

/**
 * The whole quiz loop, in one place instead of four prose bullets:
 * budget spent → stop; refresh due or batch drained → retrieve fresh pages;
 * otherwise → next question from the current batch.
 */
function nextStep(context: QuizContext): "summary" | "retrieving" | "asking" {
  if (context.questionsAsked >= context.maxQuestions) return "summary";
  if (context.sinceRefresh >= context.refreshEvery) return "retrieving";
  if (context.chunkCursor >= context.chunks.length) return "retrieving";
  return "asking";
}

/** The one-line verdict shown above the next question. */
function renderGrade(grade: z.infer<typeof gradeSchema>): string {
  const verdict = grade.correct ? "Correct" : "Incorrect";
  // `expected` usually arrives as a full sentence, so joining it with the
  // sentence-ending period below renders "…set of states..".
  const expected = grade.expected.trim().replace(/[.!?]+$/, "");
  return `${verdict} — the answer is ${expected}. ${grade.explanation}`;
}

/**
 * The passage the grade was grounded on, quoted in one line with its page.
 * The learner sees the evidence, not just the verdict.
 */
function citeSource(pageNumber: number, sourceText: string): string {
  const text = sourceText.trim();
  const sentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  const snippet = sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
  return `Source (page ${pageNumber}): "${snippet}"`;
}

/** Assemble the display text. The page hint comes from the chunk, not the model. */
function renderQuestion(question: z.infer<typeof questionSchema>, pageNumber: number): string {
  const choices = question.choices.length
    ? "\n" + question.choices.map((choice, i) => `${"ABCD"[i]}) ${choice}`).join("\n")
    : "";
  return `${question.question}${choices}\n(Hint: see page ${pageNumber})`;
}

const PICKER_PROMPT =
  "Which document do you want to be quizzed on? " +
  SAMPLE_LIBRARY.map((entry) => `${entry.title} (${entry.id})`).join(", ");

export const chatWithPdfMachine = agentSetup.createMachine({
  id: "chat-with-pdf-quiz",
  context: ({ input }) => ({
    documentId: input.documentId,
    documentTitle: SAMPLE_LIBRARY.find((entry) => entry.id === input.documentId)?.title ?? "",
    topic: input.topic,
    pageStart: input.pageStart,
    pageEnd: input.pageEnd,
    maxQuestions: input.maxQuestions,
    refreshEvery: input.refreshEvery,
    chunks: [],
    chunkCursor: 0,
    pagesCovered: [],
    questionsAsked: 0,
    sinceRefresh: 0,
    pending: null,
    results: [],
    prompt: "",
    lastGrade: "",
    exhausted: false,
  }),
  initial: "selectingDocument",
  states: {
    /**
     * "If multiple documents exist, ask the user which one" as a branch, not a
     * request. A known id goes straight through; a single-document library is
     * chosen automatically; anything else has to be resolved before retrieval
     * can run at all.
     */
    selectingDocument: {
      always: ({ context }) => {
        const named = SAMPLE_LIBRARY.find((entry) => entry.id === context.documentId);
        if (named) {
          return { target: "retrieving", context: { documentTitle: named.title } };
        }
        if (SAMPLE_LIBRARY.length === 1) {
          const only = SAMPLE_LIBRARY[0]!;
          return {
            target: "retrieving",
            context: { documentId: only.id, documentTitle: only.title },
          };
        }
        return { target: "choosingDocument", context: { prompt: PICKER_PROMPT } };
      },
    },

    // Idle: no invoke, so the run settles here for a host to resume.
    choosingDocument: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{prompt}",
          events: { SELECT_DOCUMENT: { label: "Choose" } },
          textEvent: "SELECT_DOCUMENT",
        },
      },
      on: {
        // An unrecognized choice returns `undefined`: the transition is illegal,
        // the machine stays put, and no retrieval runs against a guessed id.
        SELECT_DOCUMENT: ({ event }) => {
          const wanted = event.documentId.trim().toLowerCase();
          const match = SAMPLE_LIBRARY.find(
            (entry) => entry.id.toLowerCase() === wanted || entry.title.toLowerCase() === wanted,
          );
          return match
            ? {
                target: "retrieving",
                context: { documentId: match.id, documentTitle: match.title },
              }
            : undefined;
        },
      },
    },

    retrieving: {
      invoke: {
        src: "retrieve",
        // `documentId` and `excludePages` are threaded by the machine. The model
        // is never asked to remember either.
        input: ({ context }) => ({
          documentId: context.documentId ?? "",
          topic: context.topic,
          pageStart: context.pageStart,
          pageEnd: context.pageEnd,
          excludePages: context.pagesCovered,
          limit: context.refreshEvery,
        }),
        onDone: ({ output }) =>
          output.length === 0
            ? // Nothing fresh left in range. Prose has no answer for this case;
              // a machine ends the session and says why.
              { target: "summary", context: { exhausted: true } }
            : { target: "asking", context: { chunks: output, chunkCursor: 0, sinceRefresh: 0 } },
        onError: { target: "summary", context: { exhausted: true } },
      },
    },

    /**
     * One entry, one question. "Ask ONE question at a time" is not an
     * instruction here — there is no state in which two can be posed.
     */
    asking: {
      invoke: {
        src: "writeQuestion",
        input: ({ context }) => ({
          passage: context.chunks[context.chunkCursor]?.content ?? "",
          questionNumber: context.questionsAsked + 1,
          askedSoFar: context.results.map((result) => result.prompt),
        }),
        onDone: ({ context, output }, enq) => {
          const chunk = context.chunks[context.chunkCursor]!;
          const prompt = renderQuestion(output, chunk.pageNumber);
          enq.emit({ type: "QUESTION", prompt, pageNumber: chunk.pageNumber });
          return {
            target: "awaitingAnswer",
            context: {
              pending: { pageNumber: chunk.pageNumber, prompt, sourceText: chunk.content },
              prompt,
              chunkCursor: context.chunkCursor + 1,
              questionsAsked: context.questionsAsked + 1,
              sinceRefresh: context.sinceRefresh + 1,
              pagesCovered: [...context.pagesCovered, chunk.pageNumber],
            },
          };
        },
        onError: { target: "summary" },
      },
    },

    awaitingAnswer: {
      tags: ["waiting"],
      meta: {
        interaction: {
          // `{lastGrade}` puts the verdict on the previous answer above the
          // question, so a host never jumps to the next one silently.
          label: "{lastGrade}\n\n{prompt}",
          events: {
            ANSWER: { label: "Answer", style: "primary" },
            SKIP: { label: "Skip" },
            STOP: { label: "End quiz", style: "danger" },
          },
          textEvent: "ANSWER",
        },
      },
      on: {
        ANSWER: ({ event }) => ({
          target: "grading",
          context: { prompt: event.text },
        }),
        // Skipping still advances the loop through the same function grading
        // uses, so the two paths cannot drift apart.
        SKIP: ({ context }) => ({ target: nextStep(context), context: { lastGrade: "" } }),
        STOP: { target: "summary" },
      },
    },

    grading: {
      invoke: {
        src: "gradeAnswer",
        input: ({ context }) => ({
          prompt: context.pending.prompt,
          answer: context.prompt,
          sourceText: context.pending.sourceText,
          pageNumber: context.pending.pageNumber,
        }),
        onDone: ({ context, output }, enq) => {
          enq.emit({
            type: "GRADED",
            correct: output.correct,
            expected: output.expected,
            explanation: output.explanation,
          });
          const results = [
            ...context.results,
            {
              pageNumber: context.pending.pageNumber,
              prompt: context.pending.prompt,
              answer: context.prompt,
              correct: output.correct,
              explanation: output.explanation,
            },
          ];
          return {
            target: nextStep(context),
            context: {
              results,
              pending: null,
              lastGrade:
                renderGrade(output) +
                "\n" +
                citeSource(context.pending.pageNumber, context.pending.sourceText),
            },
          };
        },
        onError: ({ context }) => ({
          target: nextStep(context),
          context: { pending: null, lastGrade: "" },
        }),
      },
    },

    summary: {
      type: "final",
      output: ({ context }) => ({
        documentId: context.documentId ?? "",
        correct: context.results.filter((result) => result.correct).length,
        answered: context.results.length,
        pagesCovered: context.pagesCovered,
        results: context.results,
        exhausted: context.exhausted,
      }),
    },
  },
});

type QuizSnapshot = SnapshotFrom<typeof chatWithPdfMachine>;

/** What a host sends to unblock an idle machine. */
export type LearnerEvent =
  | { type: "SELECT_DOCUMENT"; documentId: string }
  | { type: "ANSWER"; text: string }
  | { type: "SKIP" }
  | { type: "STOP" };

/** `{key}` placeholders in interaction labels resolve against context. */
export function resolveInteractionLabel(label: string, context: Record<string, unknown>): string {
  return label
    .replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = context[key];
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    })
    .trim();
}

/** Prompt for whatever the idle state is waiting on, from its meta hint. */
export function idlePrompt(snapshot: QuizSnapshot): string {
  const interaction = getStateMeta(snapshot).interaction;
  return resolveInteractionLabel(interaction?.label ?? "?", snapshot.context);
}

/** Route free text to the idle state's `textEvent`. */
export function toLearnerEvent(snapshot: QuizSnapshot, text: string): LearnerEvent {
  if (text.toLowerCase() === "stop") return { type: "STOP" };
  if (text.toLowerCase() === "skip") return { type: "SKIP" };
  const textEvent = getStateMeta(snapshot).interaction?.textEvent ?? "ANSWER";
  return textEvent === "SELECT_DOCUMENT"
    ? { type: "SELECT_DOCUMENT", documentId: text }
    : { type: "ANSWER", text };
}

export async function main() {
  const shared = {
    executors: createAiSdkExecutors({ models }),
    on: {
      QUESTION: ({ prompt }: { prompt: string }) => console.log(`\n${prompt}`),
      GRADED: (grade: { correct: boolean; expected: string; explanation: string }) =>
        console.log(`${grade.correct ? "✓" : "✗"} ${renderGrade(grade)}`),
    },
    onTransition: (snapshot: QuizSnapshot) =>
      console.log("[state]", JSON.stringify(snapshot.value)),
  };

  let result = await runAgent(chatWithPdfMachine, {
    input: { maxQuestions: 6, refreshEvery: 3 },
    ...shared,
  });

  while (result.status === "idle") {
    const text = await promptLine(`${idlePrompt(result.snapshot)}\n> `);
    result = await runAgent(chatWithPdfMachine, {
      snapshot: result.persistedSnapshot,
      event: toLearnerEvent(result.snapshot, text),
      ...shared,
    });
  }

  if (result.status !== "done") {
    throw new Error(`Quiz did not complete: ${result.status}`);
  }

  console.log(
    `\nScore: ${result.output.correct}/${result.output.answered} — pages covered: ` +
      result.output.pagesCovered.join(", ") +
      (result.output.exhausted ? " (ran out of fresh pages)" : ""),
  );
}

/** Prompt once on stdin and resolve the trimmed reply. */
async function promptLine(query: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
