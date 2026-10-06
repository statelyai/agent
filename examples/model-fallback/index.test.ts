import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentTextRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors, type MockTextEntry } from "../mock-model.js";
import {
  KNOWN_CITIES,
  MAX_FALLBACKS,
  modelFallbackMachine,
  runModelFallbackExample,
} from "./index.js";

const call = (...cities: string[]) => ({ tool: "get_weather", cities });

/** Mock ONLY the model, keyed by request name; validator and tool run for real. */
function scripted(text: Record<string, MockTextEntry[]>) {
  return createMockModelExecutors({
    text: { answerFromWeather: [{ lines: ["Mild everywhere."] }], ...text },
  });
}

test("quick model's call validates: no fallback", async () => {
  const executors = scripted({ draftToolCall: [call("San Francisco", "Boston", "Tokyo")] });
  const result = await runModelFallbackExample({ generateText: executors.generateText });

  expect(result).toMatchObject({ outcome: "done", modelUsed: "quick", fallbacks: 0 });
  expect(result.toolCalls).toBe("quick: get_weather(San Francisco, Boston, Tokyo) accepted");
  expect(result.progress).toEqual([
    "draftingQuick",
    "validating",
    "runningTool",
    "answering",
    "done",
  ]);
  expect(executors.calls.map((c) => c.name)).not.toContain("draftToolCallStrong");
  // The tool saw the validated cities and returned labeled sample data.
  const answerInput = executors.calls.find((c) => c.name === "answerFromWeather")!.input as {
    results: string[];
  };
  expect(answerInput.results[0]).toBe("[sample weather] San Francisco: 60F, foggy");
});

test("quick call rejected → strong model's call validates", async () => {
  const executors = scripted({
    draftToolCall: [call("SF", "Boston")],
    draftToolCallStrong: [call("San Francisco", "Boston")],
  });
  const result = await runModelFallbackExample({
    request: "Weather in SF and Boston?",
    generateText: executors.generateText,
  });

  expect(result).toMatchObject({ outcome: "done", modelUsed: "strong", fallbacks: 1 });
  expect(result.toolCalls.split("\n\n")).toEqual([
    "quick: get_weather(SF, Boston) rejected (get_weather rejects cities: SF)",
    "strong: get_weather(San Francisco, Boston) accepted",
  ]);
  expect(result.progress).toEqual([
    "draftingQuick",
    "validating",
    "draftingStrong",
    "validating",
    "runningTool",
    "answering",
    "done",
  ]);
  // The strong rung sees only the original request, not the rejected call.
  const strongInput = executors.calls.find((c) => c.name === "draftToolCallStrong")!.input;
  expect(strongInput).toEqual({ request: "Weather in SF and Boston?" });
});

test("both rungs rejected → failed after MAX_FALLBACKS", async () => {
  const executors = scripted({
    draftToolCall: [call("Gotham")],
    draftToolCallStrong: [call("Atlantis")],
  });
  const result = await runModelFallbackExample({ generateText: executors.generateText });

  expect(result).toMatchObject({
    outcome: "failed",
    modelUsed: "strong",
    fallbacks: MAX_FALLBACKS,
  });
  expect(result.answer).toContain("Both models' calls were rejected.");
  expect(result.toolCalls).toContain(
    "quick: get_weather(Gotham) rejected (get_weather rejects cities: Gotham)",
  );
  expect(result.toolCalls).toContain("strong: get_weather(Atlantis) rejected");
  expect(result.progress).not.toContain("runningTool");
  expect(executors.calls.filter((c) => c.name === "draftToolCallStrong")).toHaveLength(
    MAX_FALLBACKS,
  );
});

test("a quick-model error falls back; a strong-model error is failed", async () => {
  const boom = () => {
    throw new Error("provider down");
  };
  const recovered = await runModelFallbackExample({
    generateText: scripted({ draftToolCall: [boom], draftToolCallStrong: [call("Tokyo")] })
      .generateText,
  });
  expect(recovered).toMatchObject({ outcome: "done", modelUsed: "strong", fallbacks: 1 });
  expect(recovered.toolCalls).toContain("quick: (no call) rejected (draftToolCall failed");

  const failed = await runModelFallbackExample({
    generateText: scripted({ draftToolCall: [call("Gotham")], draftToolCallStrong: [boom] })
      .generateText,
  });
  expect(failed.outcome).toBe("failed");
  expect(failed.answer).toContain("draftToolCallStrong failed");
});

test("an empty city list is a malformed call: the schema requires at least one city", async () => {
  let sentSchema: unknown;
  const executors = scripted({
    // Records the JSON schema the provider was sent, then answers with no cities.
    draftToolCall: [
      (_request, options) => {
        sentSchema = options.responseFormat?.type === "json" && options.responseFormat.schema;
        return call();
      },
    ],
    draftToolCallStrong: [call("Tokyo")],
  });
  const result = await runModelFallbackExample({ generateText: executors.generateText });

  // The model is told up front: the schema it sees says at least one city.
  expect(JSON.stringify(sentSchema)).toContain('"minItems":1');
  // An empty call never reaches the tool; it fails parsing and falls back.
  expect(result).toMatchObject({ outcome: "done", modelUsed: "strong", fallbacks: 1 });
  expect(result.toolCalls).toContain("quick: (no call) rejected (draftToolCall failed");
  expect(result.toolCalls).not.toContain("get_weather()");
});

test("the answer puts each line in its own paragraph", async () => {
  const executors = scripted({
    draftToolCall: [call("San Francisco", "Boston")],
    answerFromWeather: [{ lines: ["San Francisco: 60F, foggy.", "Boston: 48F, clear and windy."] }],
  });
  const result = await runModelFallbackExample({ generateText: executors.generateText });

  // A blank line between lines: Markdown collapses a single newline into a space.
  expect(result.answer).toBe("San Francisco: 60F, foggy.\n\nBoston: 48F, clear and windy.");
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as string[];
  // A faithful model: names exactly the places the request mentions.
  const faithful = (request: AgentTextRequest) =>
    call(...[...KNOWN_CITIES, "Atlantis"].filter((city) => request.prompt?.includes(city)));

  const outcomes = [];
  for (const request of starters) {
    const result = await runModelFallbackExample({
      request,
      generateText: scripted({ draftToolCall: [faithful], draftToolCallStrong: [faithful] })
        .generateText,
    });
    outcomes.push([result.outcome, result.modelUsed]);
  }
  // Known cities validate on the quick rung; a city the tool does not know is
  // rejected on both rungs.
  expect(outcomes).toEqual([
    ["done", "quick"],
    ["done", "quick"],
    ["failed", "strong"],
  ]);
});

test("lintAgentMachine is clean", () => {
  expect(() => lintAgentMachine(modelFallbackMachine, { throw: true })).not.toThrow();
});
