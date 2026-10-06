import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentDecisionRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors, type MockDecisionEntry } from "../mock-model.js";
import {
  MAX_RESELECTIONS,
  MAX_TOOL_CALLS,
  TOOLS_PER_SELECTION,
  TOOL_REGISTRY,
  TOOL_RELEVANCE_THRESHOLD,
  runToolRetrievalExample,
  toolRetrievalMachine,
} from "./index.js";

/** Mock only the model: the `chooseTool` decision, keyed by name. */
function scripted(chooseTool: MockDecisionEntry | MockDecisionEntry[]) {
  return createMockModelExecutors({ decisions: { chooseTool } }).decide;
}

/**
 * The Jev rerank, scripted by query: a tool listed for the query the
 * selection was asked with is relevant (0.95), every other tool is not (0.05).
 * One entry per registry tool, keyed by the tool's name like the questions.
 */
function selector(relevant: Record<string, string[]>) {
  return createMockJudge(
    Object.fromEntries(
      TOOL_REGISTRY.map((tool) => [
        tool.name,
        (state: unknown) =>
          (relevant[(state as { question: string }).question] ?? []).includes(tool.name),
      ]),
    ),
  );
}

const MARATHON = "How many miles is a 42.195 km marathon?";

/** The moves a decision request offers the model. */
const offered = (request: AgentDecisionRequest) => request.events.map((event) => event.type);

test("selects matching tools → calls one → answers", async () => {
  const result = await runToolRetrievalExample({
    question: MARATHON,
    decide: scripted([
      { type: "CALL_TOOL", tool: "km_to_miles", arg: "42.195" },
      { type: "ANSWER", answer: "About 26.22 miles." },
    ]),
    judge: selector({ [MARATHON]: ["km_to_miles"] }).model,
  });

  expect(result.finalState).toBe("done");
  expect(result.selectedTools).toEqual(["km_to_miles"]);
  expect(result.calls).toBe('km_to_miles("42.195") → 26.22 miles');
  expect(result.answer).toBe("About 26.22 miles.");
  expect(result.progress).toEqual([
    "selectingTools",
    "deciding",
    "runningTool",
    "deciding",
    "done",
  ]);
});

test("a registry tool outside the selected set is rejected, and the decision retries", async () => {
  const seen: string[][] = [];
  const result = await runToolRetrievalExample({
    question: MARATHON,
    judge: selector({ [MARATHON]: ["km_to_miles"] }).model,
    decide: scripted((request) => {
      seen.push(request.attempts.map((attempt) => attempt.failure));
      return request.attempts.length === 0
        ? { type: "CALL_TOOL", tool: "lookup_capital", arg: "Japan" }
        : { type: "ANSWER", answer: "Unsure." };
    }),
  });

  expect(result.finalState).toBe("done");
  expect(seen).toEqual([[], ["rejected-by-guard"]]);
  expect(result.progress).not.toContain("runningTool");
  expect(result.calls).toBe("(no tool calls)");
});

test("RESELECT searches again and ADDS the new tools to the selected set", async () => {
  const result = await runToolRetrievalExample({
    question: MARATHON,
    judge: selector({
      [MARATHON]: ["km_to_miles"],
      "capital city of a country": ["lookup_capital"],
    }).model,
    decide: scripted([
      { type: "RESELECT", query: "capital city of a country" },
      { type: "CALL_TOOL", tool: "lookup_capital", arg: "Kenya" },
      { type: "ANSWER", answer: "Nairobi." },
    ]),
  });

  expect(result.finalState).toBe("done");
  expect(result.reselections).toBe(1);
  expect(result.selectedTools).toEqual(["km_to_miles", "lookup_capital"]);
  expect(result.calls).toBe('lookup_capital("Kenya") → Nairobi');
  expect(result.progress.slice(0, 4)).toEqual([
    "selectingTools",
    "deciding",
    "selectingTools",
    "deciding",
  ]);
});

test("reselection budget: RESELECT is no longer offered after MAX_RESELECTIONS, so the model answers", async () => {
  const moves: string[][] = [];
  const result = await runToolRetrievalExample({
    question: "What is the capital of Australia?",
    judge: selector({ "What is the capital of Australia?": ["lookup_capital"] }).model,
    decide: scripted((request) => {
      moves.push(offered(request));
      return offered(request).includes("RESELECT")
        ? { type: "RESELECT", query: "capital" }
        : { type: "ANSWER", answer: "Canberra, from memory." };
    }),
  });

  expect(result.finalState).toBe("done");
  expect(moves.at(-1)).toEqual(["CALL_TOOL", "ANSWER"]);
  expect(result.reselections).toBe(MAX_RESELECTIONS);
  expect(result.progress.filter((state) => state === "selectingTools")).toHaveLength(
    MAX_RESELECTIONS + 1,
  );
});

test("tool-call budget exhausted and the model never answers → failed", async () => {
  let arg = 0;
  const result = await runToolRetrievalExample({
    question: MARATHON,
    judge: selector({ [MARATHON]: ["km_to_miles"] }).model,
    // A new argument each time, so only the budget (not the repeat guard) stops it.
    decide: scripted(() => ({ type: "CALL_TOOL", tool: "km_to_miles", arg: String(++arg) })),
  });

  expect(result.finalState).toBe("failed");
  expect(result.calls.split("\n")).toHaveLength(MAX_TOOL_CALLS);
  expect(result.answer).toContain(`after ${MAX_TOOL_CALLS} tool call(s)`);
});

test("a repeated identical call is refused, and the next decision sees the earlier result", async () => {
  // The QA run called km_to_miles("42.195") four times. The result of the first
  // call is in every later prompt, and repeating it is rejected by the guard.
  const prompts: string[] = [];
  const failures: string[][] = [];
  const result = await runToolRetrievalExample({
    question: MARATHON,
    judge: selector({ [MARATHON]: ["km_to_miles"] }).model,
    decide: scripted((request) => {
      prompts.push(String(request.prompt));
      failures.push(request.attempts.map((attempt) => attempt.failure));
      // Repeat the call until the guard refuses it, then answer.
      return request.attempts.length === 0
        ? { type: "CALL_TOOL", tool: "km_to_miles", arg: "42.195" }
        : { type: "ANSWER", answer: "About 26.22 miles." };
    }),
  });

  expect(result.finalState).toBe("done");
  expect(result.calls).toBe('km_to_miles("42.195") → 26.22 miles');
  // Second decision: the prompt already carries the result…
  expect(prompts[1]).toContain('km_to_miles("42.195") → 26.22 miles');
  expect(prompts[1]).toMatch(/never repeat these calls/);
  expect(prompts[1]!.split("\n").at(-1)).toMatch(/your move is ANSWER/);
  expect(prompts[0]).not.toMatch(/your move is ANSWER/);
  // …and the repeat was refused rather than run again.
  expect(failures[2]).toEqual(["rejected-by-guard"]);
  expect(result.progress.filter((state) => state === "runningTool")).toHaveLength(1);
});

test("an empty selection offers RESELECT or ANSWER, never an unusable CALL_TOOL", async () => {
  // Nothing clears the threshold on the first search; the model reselects,
  // finds the date tool, uses it and answers. No decision is exhausted.
  const DATES = "How many days are there between 2026-01-15 and 2026-03-01?";
  const moves: string[][] = [];
  const result = await runToolRetrievalExample({
    question: DATES,
    judge: selector({ "days between two dates": ["days_between"] }).model,
    decide: scripted((request) => {
      moves.push(offered(request));
      if (!offered(request).includes("CALL_TOOL")) {
        return { type: "RESELECT", query: "days between two dates" };
      }
      return request.prompt?.includes("→ 45 days")
        ? { type: "ANSWER", answer: "45 days." }
        : { type: "CALL_TOOL", tool: "days_between", arg: "2026-01-15 2026-03-01" };
    }),
  });

  expect(moves[0]).toEqual(["RESELECT", "ANSWER"]);
  expect(result.finalState).toBe("done");
  expect(result.selectedTools).toEqual(["days_between"]);
  expect(result.calls).toBe('days_between("2026-01-15 2026-03-01") → 45 days');
  expect(result.answer).toBe("45 days.");
});

test("with no tools and no reselections left, ANSWER is the only move", async () => {
  const moves: string[][] = [];
  const result = await runToolRetrievalExample({
    question: "What is the airspeed of an unladen swallow?",
    judge: selector({}).model,
    decide: scripted((request) => {
      moves.push(offered(request));
      return offered(request).includes("RESELECT")
        ? { type: "RESELECT", query: "bird speed" }
        : { type: "ANSWER", answer: "About 11 m/s, from memory." };
    }),
  });

  expect(result.finalState).toBe("done");
  expect(moves).toEqual([["RESELECT", "ANSWER"], ["RESELECT", "ANSWER"], ["ANSWER"]]);
});

test("selection names each tool in its own Jev question, not by a bare index", async () => {
  // `tools[i]` alone let Jev misalign rows (the date starter picked percent_of).
  const jev = selector({ [MARATHON]: ["km_to_miles"] });
  await runToolRetrievalExample({
    question: MARATHON,
    judge: jev.model,
    decide: scripted({ type: "ANSWER", answer: "done" }),
  });
  for (const tool of TOOL_REGISTRY) {
    const question = jev.calls[0]!.questions[tool.name]!;
    expect(question.instructions).toContain(tool.name);
    expect(question.instructions).toContain(tool.description);
  }
});

test("registry tools are pure and report bad arguments instead of throwing", () => {
  const run = (name: string, arg: string) =>
    TOOL_REGISTRY.find((tool) => tool.name === name)!.run(arg);
  expect(TOOL_REGISTRY).toHaveLength(12);
  expect(run("days_between", "2026-01-15 2026-03-01")).toBe("45 days");
  expect(run("add_days", "2026-01-15 30")).toBe("2026-02-14");
  expect(run("percent_of", "15 of 80")).toBe("12");
  expect(run("sum_numbers", "3, 4.5, 10")).toBe("17.5");
  expect(run("celsius_to_fahrenheit", "100")).toBe("212 °F");
  expect(run("km_to_miles", "far")).toMatch(/^error:/);
  expect(run("days_between", "soon")).toMatch(/^error:/);
});

test("machine lints clean", () => {
  expect(() => lintAgentMachine(toolRetrievalMachine, { throw: true })).not.toThrow();
});

const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
  .starters as string[];

test("starters behave as their labels advertise", async () => {
  // Each starter question is answerable by one registry tool, and the selector
  // must surface that tool on the FIRST selection. Jev is scripted to find it.
  const expected = [
    { tool: "km_to_miles", arg: "42.195", result: "26.22 miles" },
    { tool: "days_between", arg: "2026-01-15 2026-03-01", result: "45 days" },
    { tool: "lookup_capital", arg: "Australia", result: "Canberra" },
  ];
  for (const [index, question] of starters.entries()) {
    const { tool, arg, result: toolResult } = expected[index]!;
    const result = await runToolRetrievalExample({
      question,
      judge: selector({ [question]: [tool] }).model,
      decide: scripted([
        { type: "CALL_TOOL", tool, arg },
        { type: "ANSWER", answer: "done" },
      ]),
    });
    expect(result.finalState, question).toBe("done");
    expect(result.reselections, question).toBe(0);
    expect(result.selectedTools, question).toContain(tool);
    expect(result.calls, question).toBe(`${tool}(${JSON.stringify(arg)}) → ${toolResult}`);
    // Every starter's output has the same layout: one response field with
    // the answer first, then the calls as a list — never a separate `calls`
    // field competing with `answer` to lead.
    expect(result.response, question).toBe(
      `done\n\nTool calls:\n\n- ${tool}(${JSON.stringify(arg)}) → ${toolResult}`,
    );
    expect(
      Object.keys(result)
        .filter((key) => typeof result[key as keyof typeof result] === "string")
        .sort(),
      question,
    ).toEqual(["answer", "calls", "finalState", "response"]);
  }
});

test("the response layout does not depend on whether the answer or the calls are longer", async () => {
  const run = (answer: string) =>
    runToolRetrievalExample({
      question: MARATHON,
      judge: selector({ [MARATHON]: ["km_to_miles"] }).model,
      decide: scripted([
        { type: "CALL_TOOL", tool: "km_to_miles", arg: "42.195" },
        { type: "ANSWER", answer },
      ]),
    });
  const short = await run("26.22 miles.");
  const long = await run(
    "A marathon of 42.195 kilometres is about 26.22 miles, the distance every road marathon uses.",
  );
  for (const result of [short, long]) {
    const [answer, blank, heading, blank2, call] = result.response.split("\n");
    expect(answer).toBe(result.answer);
    expect([blank, heading, blank2]).toEqual(["", "Tool calls:", ""]);
    expect(call).toBe('- km_to_miles("42.195") → 26.22 miles');
  }

  // No calls: the same shape, with the list replaced by one line.
  const direct = await runToolRetrievalExample({
    question: MARATHON,
    judge: selector({ [MARATHON]: ["km_to_miles"] }).model,
    decide: scripted([{ type: "ANSWER", answer: "About 26.2 miles." }]),
  });
  expect(direct.response).toBe("About 26.2 miles.\n\nTool calls: none.");
});

test("selection asks Jev one boolean question per registry tool and keeps the top few above the threshold", async () => {
  // Four tools clear the threshold (only three fit), one sits just under it.
  const jev = createMockJudge({
    kg_to_pounds: [0.6, 0.05],
    km_to_miles: [0.9, 0.05],
    celsius_to_fahrenheit: [0.8, 0.05],
    fahrenheit_to_celsius: [0.7, 0.05],
    word_count: [TOOL_RELEVANCE_THRESHOLD - 0.01, 0.05],
    lookup_capital: [0.05, 0.9],
    "*": 0.05,
  });
  const result = await runToolRetrievalExample({
    question: MARATHON,
    judge: jev.model,
    decide: scripted([
      { type: "RESELECT", query: "capital city of a country" },
      { type: "ANSWER", answer: "done" },
    ]),
  });

  // One call per selection; RESELECT re-asks with the new query.
  expect(jev.calls).toHaveLength(2);
  const [first, second] = jev.calls;
  type SelectionState = { question: string; tools: Array<{ name: string; description: string }> };
  expect((first!.state as SelectionState).question).toBe(MARATHON);
  expect((second!.state as SelectionState).question).toBe("capital city of a country");
  expect((first!.state as SelectionState).tools).toEqual(
    TOOL_REGISTRY.map(({ name, description }) => ({ name, description })),
  );
  expect(Object.keys(first!.questions)).toEqual(TOOL_REGISTRY.map((tool) => tool.name));
  expect(Object.values(first!.questions).every((question) => question.type === "boolean")).toBe(
    true,
  );

  // Best first, cut at TOOLS_PER_SELECTION; the just-under tool never shows up;
  // the reselection adds to the set.
  expect(result.selectedTools).toHaveLength(TOOLS_PER_SELECTION + 1);
  expect(result.selectedTools).toEqual([
    "km_to_miles",
    "celsius_to_fahrenheit",
    "fahrenheit_to_celsius",
    "lookup_capital",
  ]);
});
