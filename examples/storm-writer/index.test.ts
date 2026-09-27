import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentTextRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import {
  interviewMachine,
  MAX_EDITORS,
  MAX_INTERVIEW_TURNS,
  MAX_SECTIONS,
  runStormWriterExample,
  stormWriterMachine,
} from "./index.js";

const editors = [
  { name: "Ada", affiliation: "Systems lab", focus: "reliability" },
  { name: "Ben", affiliation: "Product team", focus: "developer experience" },
  { name: "Cy", affiliation: "Security group", focus: "threats" },
];

type Input<T> = T & Record<string, unknown>;
const inputOf = <T>(request: AgentTextRequest) => request.input as Input<T>;

/**
 * Model mocked by request name. Answers read the request input, so the
 * interviews stay correct whichever one the scheduler runs first; the search
 * actor runs its real keyword logic over the sample index.
 */
function scripted(overrides: Record<string, unknown> = {}) {
  return createMockModelExecutors({
    text: {
      draftOutline: { outline: ["Overview", "History", "Uses"] },
      choosePerspectives: { editors },
      askQuestion: (request: AgentTextRequest) => ({
        question: `What should readers know about ${inputOf<{ topic: string }>(request).topic}?`,
        finished: false,
      }),
      answerQuestion: (request: AgentTextRequest) => ({
        answer: `Answered from ${inputOf<{ sources: string[] }>(request).sources.length} source(s).`,
      }),
      refineOutline: {
        outline: ["Overview", "Control flow", "Budgets", "Inspection", "Limits", "Outlook"],
      },
      writeSection: (request: AgentTextRequest) => ({
        section: `Body of ${inputOf<{ heading: string }>(request).heading}.`,
      }),
      writeArticle: (request: AgentTextRequest) => ({
        article: inputOf<{ sections: Array<{ heading: string; body: string }> }>(request)
          .sections.map((section) => `## ${section.heading}\n${section.body}`)
          .join("\n\n"),
      }),
      ...overrides,
    },
  });
}

/** Coordinator trajectory with repeated states (one per landed child) collapsed. */
const collapse = (progress: string[]) =>
  progress.filter((state, index) => state !== progress[index - 1]);

test("happy path: capped editors interview in parallel, capped sections are written", async () => {
  const executors = scripted();
  const result = await runStormWriterExample({
    topic: "state machines for AI agents",
    generateText: executors.generateText,
  });
  expect(collapse(result.progress)).toEqual([
    "outlining",
    "choosingPerspectives",
    "collectingInterviews",
    "refiningOutline",
    "writingSection",
    "writingArticle",
    "done",
  ]);
  const count = (name: string) => executors.calls.filter((call) => call.name === name).length;
  // MAX_EDITORS interviews, each running MAX_INTERVIEW_TURNS exchanges.
  expect(result.interviews).toBe(MAX_EDITORS);
  expect(count("askQuestion")).toBe(MAX_EDITORS * MAX_INTERVIEW_TURNS);
  expect(count("answerQuestion")).toBe(MAX_EDITORS * MAX_INTERVIEW_TURNS);
  // Six refined headings, MAX_SECTIONS written.
  expect(count("writeSection")).toBe(MAX_SECTIONS);
  expect(result.sections).toBe(MAX_SECTIONS);
  expect(result.outline).toEqual(["Overview", "Control flow", "Budgets", "Inspection"]);
  expect(result.article).toContain("## Inspection\nBody of Inspection.");
  expect(result.trail).toContain("Outline: 4 heading(s) (2 dropped past 4)");
  expect(result.trail).toContain("Editors: 2 (1 dropped past 2)");
  expect(result.trail).toContain("Interviews: 2 (4 exchange(s))");
  // The writer sees transcripts grounded in the sample index.
  const writeCall = executors.calls.find((call) => call.name === "writeSection")!;
  const interviews = (writeCall.input as { interviews: string[] }).interviews;
  expect(interviews).toHaveLength(2);
  expect(interviews.join("\n")).toContain("[sample source] State machines give AI agents");
});

test("an editor that says it is finished ends its interview before the turn cap", async () => {
  const executors = scripted({
    askQuestion: { question: "Thank you so much for your help!", finished: true },
  });
  const result = await runStormWriterExample({ generateText: executors.generateText });
  expect(result.finalState).toBe("done");
  expect(executors.calls.filter((call) => call.name === "answerQuestion")).toHaveLength(0);
  expect(result.trail).toContain("Interviews: 2 (0 exchange(s))");
});

test("zero proposed editors ends in `failed`", async () => {
  const result = await runStormWriterExample({
    generateText: scripted({ choosePerspectives: { editors: [] } }).generateText,
  });
  expect(result.finalState).toBe("failed");
  expect(result.progress).not.toContain("collectingInterviews");
  expect(result.trail).toContain("Stopped: No perspectives to interview.");
});

test("an interview that errors is counted; the other still feeds the article", async () => {
  const executors = scripted({
    askQuestion: (request: AgentTextRequest) => {
      if (inputOf<{ editor: { name: string } }>(request).editor.name === "Ben") {
        throw new Error("editor model down");
      }
      return { question: "What should readers know about agent loops?", finished: false };
    },
  });
  const result = await runStormWriterExample({ generateText: executors.generateText });
  expect(result.finalState).toBe("done");
  expect(result.interviews).toBe(1);
  expect(result.trail).toContain("Interviews: 1 (2 exchange(s), 1 failed)");
});

test("every interview failing ends in `failed`", async () => {
  const result = await runStormWriterExample({
    generateText: scripted({
      askQuestion: () => {
        throw new Error("editor model down");
      },
    }).generateText,
  });
  expect(result.finalState).toBe("failed");
  expect(result.progress).not.toContain("refiningOutline");
  expect(result.trail).toContain("No interview produced a usable transcript.");
});

test("a section failure ends in `failed` with the sections written so far", async () => {
  const result = await runStormWriterExample({
    generateText: scripted({
      writeSection: [
        { section: "First body." },
        () => {
          throw new Error("writer timeout");
        },
      ],
    }).generateText,
  });
  expect(result.finalState).toBe("failed");
  expect(result.sections).toBe(1);
  expect(result.article).toContain("## Overview\nFirst body.");
  expect(result.trail).toContain("writeSection failed");
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as string[];
  expect(starters).toHaveLength(4);
  const offIndex = starters.filter((topic) => topic.includes("off-index"));
  expect(offIndex).toHaveLength(1);
  for (const topic of starters) {
    const executors = scripted();
    const result = await runStormWriterExample({ topic, generateText: executors.generateText });
    expect(result.finalState).toBe("done");
    const answers = executors.calls
      .filter((call) => call.name === "answerQuestion")
      .flatMap((call) => (call.input as { sources: string[] }).sources);
    const grounded = answers.some((source) => !source.includes("No sample passages"));
    expect(grounded).toBe(!offIndex.includes(topic));
  }
});

test("both machines are structurally sound", () => {
  lintAgentMachine(stormWriterMachine, { throw: true });
  lintAgentMachine(interviewMachine, { throw: true });
});
