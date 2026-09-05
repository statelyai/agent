import { describe, expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";
import {
  chatWithPdfMachine,
  idlePrompt,
  queryPdfContent,
  SAMPLE_LIBRARY,
  type LearnerEvent,
} from "./index.js";

type MachineInput = {
  documentId?: string | null;
  topic?: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  maxQuestions?: number;
  refreshEvery?: number;
};

interface PlayOptions {
  input?: MachineInput;
  /** Consumed in order on each idle settle. */
  learnerEvents: LearnerEvent[];
  /** Grade every answer as correct unless this says otherwise. */
  grade?: (answer: string) => boolean;
  /** The `expected` string the grader returns. */
  expected?: string;
}

interface PlayResult {
  status: string;
  output?: {
    documentId: string;
    correct: number;
    answered: number;
    pagesCovered: number[];
    results: Array<{ pageNumber: number; prompt: string; correct: boolean }>;
    exhausted: boolean;
  };
  /** Passages `writeQuestion` was given, in order. */
  passages: string[];
  /** Prompts `gradeAnswer` was given, in order. */
  gradePrompts: string[];
  /** Every idle label the run settled on. */
  idleLabels: string[];
}

async function play(options: PlayOptions): Promise<PlayResult> {
  const passages: string[] = [];
  const gradePrompts: string[] = [];
  const idleLabels: string[] = [];
  let questionNumber = 0;

  const generateText: AgentRequestExecutor = async (request) => {
    if (request.system?.includes("Grade a quiz answer")) {
      gradePrompts.push(request.prompt ?? "");
      const answer = (request.prompt ?? "").match(/Learner's answer: (.*)/)?.[1] ?? "";
      return {
        output: {
          correct: options.grade ? options.grade(answer) : true,
          expected: options.expected ?? "the expected answer",
          explanation: `graded "${answer}"`,
        },
      };
    }
    // writeQuestion
    const passage = (request.prompt ?? "").match(/Passage:\n(.*)/)?.[1] ?? "";
    passages.push(passage);
    questionNumber += 1;
    return {
      output: {
        type: "short-answer",
        question: `Q${questionNumber} about: ${passage.slice(0, 24)}`,
        choices: [],
      },
    };
  };

  const queue = [...options.learnerEvents];
  let result = await runAgent(chatWithPdfMachine, {
    input: options.input ?? {},
    executors: { generateText },
  });

  while (result.status === "idle") {
    idleLabels.push(idlePrompt(result.snapshot));
    const event = queue.shift();
    if (!event) break;
    result = await runAgent(chatWithPdfMachine, {
      snapshot: result.persist(),
      event,
      executors: { generateText },
    });
  }

  return {
    status: result.status,
    output: result.status === "done" ? (result.output as PlayResult["output"]) : undefined,
    passages,
    gradePrompts,
    idleLabels,
  };
}

const answers = (count: number): LearnerEvent[] =>
  Array.from({ length: count }, (_, i) => ({ type: "ANSWER", text: `answer ${i + 1}` }));

describe("chat-with-pdf quiz mode", () => {
  test("one question per idle settle: the machine cannot pose two at once", async () => {
    const result = await play({
      input: { documentId: "statecharts", maxQuestions: 4, refreshEvery: 2 },
      learnerEvents: answers(4),
    });

    expect(result.status).toBe("done");
    // Four questions asked, four idle settles, four gradings. No batching.
    expect(result.passages).toHaveLength(4);
    expect(result.idleLabels).toHaveLength(4);
    expect(result.output?.answered).toBe(4);
    // Each idle label is exactly the one pending question.
    for (const label of result.idleLabels) {
      expect(label.match(/^Q\d+ about:/m)).not.toBeNull();
      expect(label.match(/Hint: see page \d+/g)).toHaveLength(1);
    }
  });

  test("covered pages are excluded by the query, so refreshed batches never repeat a page", async () => {
    // 6 questions with refreshEvery 2 forces three retrievals.
    const result = await play({
      input: { documentId: "statecharts", maxQuestions: 6, refreshEvery: 2 },
      learnerEvents: answers(6),
    });

    expect(result.status).toBe("done");
    const pages = result.output!.pagesCovered;
    expect(pages).toHaveLength(6);
    expect(new Set(pages).size).toBe(6);
    // Passages came from distinct pages too, not the same top-scoring chunk.
    expect(new Set(result.passages).size).toBe(6);
  });

  test("documentId is threaded by the machine: every passage comes from the chosen document", async () => {
    const result = await play({
      input: { documentId: "retrieval", maxQuestions: 4, refreshEvery: 2 },
      learnerEvents: answers(4),
    });

    const chosen = SAMPLE_LIBRARY.find((entry) => entry.id === "retrieval")!;
    const owned = new Set(chosen.pages.map((page) => page.content));
    expect(result.passages.length).toBeGreaterThan(0);
    for (const passage of result.passages) {
      expect(owned.has(passage)).toBe(true);
    }
    expect(result.output?.documentId).toBe("retrieval");
  });

  test("grading is grounded on the exact passage the question came from", async () => {
    const result = await play({
      input: { documentId: "statecharts", maxQuestions: 3, refreshEvery: 3 },
      learnerEvents: answers(3),
    });

    expect(result.gradePrompts).toHaveLength(3);
    result.gradePrompts.forEach((prompt, index) => {
      expect(prompt).toContain(result.passages[index]!);
      expect(prompt).toMatch(/Source passage \(page \d+\)/);
    });
  });

  test("an ambiguous library stops at the document picker, and an unknown choice does not advance", async () => {
    const result = await play({
      input: { maxQuestions: 2, refreshEvery: 2 },
      learnerEvents: [
        { type: "SELECT_DOCUMENT", documentId: "not-a-document" },
        { type: "SELECT_DOCUMENT", documentId: "Retrieval Systems" },
        ...answers(2),
      ],
    });

    expect(result.status).toBe("done");
    // First settle is the picker; the rejected choice leaves the machine there.
    expect(result.idleLabels[0]).toContain("Which document");
    expect(result.idleLabels[1]).toContain("Which document");
    // No retrieval ran against a guessed id.
    expect(result.passages.length).toBe(2);
    expect(result.output?.documentId).toBe("retrieval");
  });

  test("running out of fresh pages ends the session instead of repeating", async () => {
    // The retrieval doc has 6 pages; ask for 8.
    const result = await play({
      input: { documentId: "retrieval", maxQuestions: 8, refreshEvery: 2 },
      learnerEvents: answers(8),
    });

    expect(result.status).toBe("done");
    expect(result.output?.exhausted).toBe(true);
    expect(result.output?.answered).toBe(6);
    expect(new Set(result.output!.pagesCovered).size).toBe(6);
  });

  test("the grade for an answer is visible above the next question", async () => {
    const wrong = await play({
      input: { documentId: "statecharts", maxQuestions: 3, refreshEvery: 3 },
      learnerEvents: answers(3),
      grade: (answer) => answer !== "answer 1",
    });

    expect(wrong.status).toBe("done");
    // The second idle label leads with the verdict on the first answer, naming
    // the expected answer, and the question follows it.
    const second = wrong.idleLabels[1]!;
    expect(second).toContain("Incorrect — the answer is the expected answer.");
    expect(second).toContain('graded "answer 1"');
    expect(second.indexOf("Incorrect")).toBeLessThan(second.indexOf("Q2 about:"));
    // The feedback quotes the passage it was grounded on, with its page.
    expect(second).toContain('Source (page 1): "A state machine is in exactly one');

    // ... and a correct answer is acknowledged just as visibly.
    const third = wrong.idleLabels[2]!;
    expect(third).toContain("Correct — the answer is the expected answer.");
    expect(third).toContain('graded "answer 2"');

    // The first question has nothing to grade yet, so it stands alone.
    expect(wrong.idleLabels[0]).toMatch(/^Q1 about:/);
  });

  test("an expected answer that already ends in a period is not double-punctuated", async () => {
    const result = await play({
      input: { documentId: "statecharts", maxQuestions: 2, refreshEvery: 2 },
      learnerEvents: answers(2),
      expected: "a finite set of states.",
    });

    const second = result.idleLabels[1]!;
    expect(second).toContain("the answer is a finite set of states.");
    expect(second).not.toContain("states..");
  });

  test("SKIP advances the loop without scoring", async () => {
    const result = await play({
      input: { documentId: "statecharts", maxQuestions: 3, refreshEvery: 3 },
      learnerEvents: [{ type: "SKIP" }, ...answers(2)],
    });

    expect(result.status).toBe("done");
    expect(result.passages).toHaveLength(3);
    // Three questions posed, only two graded.
    expect(result.output?.answered).toBe(2);
    expect(result.output?.pagesCovered).toHaveLength(3);
  });

  test("STOP ends with the score so far", async () => {
    const result = await play({
      input: { documentId: "statecharts", maxQuestions: 6, refreshEvery: 3 },
      learnerEvents: [{ type: "ANSWER", text: "yes" }, { type: "STOP" }],
    });

    expect(result.status).toBe("done");
    expect(result.output?.answered).toBe(1);
    expect(result.output?.correct).toBe(1);
  });

  test("retrieval stratifies across the document instead of clustering", () => {
    const chunks = queryPdfContent({
      documentId: "statecharts",
      topic: "",
      pageStart: null,
      pageEnd: null,
      excludePages: [],
      limit: 3,
    });

    expect(chunks).toHaveLength(3);
    // Nine pages, thirds are 1-3 / 4-6 / 7-9: one page from each band.
    expect(chunks.map((chunk) => chunk.pageNumber)).toEqual([1, 4, 7]);
  });

  test("page range is honored by the query", () => {
    const chunks = queryPdfContent({
      documentId: "statecharts",
      topic: "",
      pageStart: 4,
      pageEnd: 6,
      excludePages: [5],
      limit: 5,
    });

    expect(chunks.map((chunk) => chunk.pageNumber)).toEqual([4, 6]);
  });
});
