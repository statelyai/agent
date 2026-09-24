import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { getInteraction, runAgent } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors, type MockModelExecutors } from "../mock-model.js";
import {
  MAX_MEMORIES,
  MAX_TURNS,
  RECALL_LIMIT,
  longTermMemoryMachine,
  runLongTermMemoryExample,
  type LongTermMemoryHumanEvent,
} from "./index.js";

const say = (text: string): LongTermMemoryHumanEvent => ({ type: "MESSAGE", text });
const end: LongTermMemoryHumanEvent = { type: "END_SESSION" };

type AnswerInput = { message: string; memories: string[]; transcript: string[] };

/** The `answer` request inputs, in call order: what the model was shown each turn. */
function answerInputs(executors: MockModelExecutors): AnswerInput[] {
  return executors.calls
    .filter((call) => call.name === "answer")
    .map((call) => call.input as AnswerInput);
}

const DOG_FACT = "The user's dog is named Biscuit.";

test("a fact told in turn 1 is recalled into the answer request in turn 3", async () => {
  const executors = createMockModelExecutors({
    text: {
      answer: [
        { reply: "Biscuit is a great name!", newMemories: [DOG_FACT] },
        { reply: "The Alps are lovely.", newMemories: ["The user enjoys hiking in the Alps."] },
        { reply: "Your dog is Biscuit.", newMemories: [] },
      ],
    },
  });
  const replies: string[] = [];
  const result = await runLongTermMemoryExample({
    generateText: executors.generateText,
    humanEvents: [
      say("My dog is named Biscuit."),
      say("I like hiking in the Alps."),
      say("What is my dog called?"),
      end,
    ],
    onReply: (reply) => replies.push(reply),
  });

  const inputs = answerInputs(executors);
  expect(inputs).toHaveLength(3);
  // Turn 1: nothing stored yet. Turn 2: the dog fact does not match hiking.
  expect(inputs[0]!.memories).toEqual([]);
  expect(inputs[1]!.memories).toEqual([]);
  // Turn 3: recall put the turn-1 fact in front of the model.
  expect(inputs[2]!.memories).toContain(DOG_FACT);

  expect(result.outcome).toBe("done");
  expect(result.turns).toBe(3);
  expect(result.memories).toEqual([DOG_FACT, "The user enjoys hiking in the Alps."]);
  expect(result.summary).toContain("Session ended by the user.");
  expect(result.summary).toContain("2 new memories saved");
  // The idle label is the assistant's last reply.
  expect(replies.slice(1)).toEqual([
    "Biscuit is a great name!",
    "The Alps are lovely.",
    "Your dog is Biscuit.",
  ]);
  expect(result.progress).toEqual([
    "awaitingMessage",
    "recalling",
    "answering",
    "awaitingMessage",
    "recalling",
    "answering",
    "awaitingMessage",
    "recalling",
    "answering",
    "awaitingMessage",
    "done",
  ]);
});

test("a second run started from the first run's output recalls the fact (cross-thread)", async () => {
  const first = await runLongTermMemoryExample({
    generateText: createMockModelExecutors({
      text: { answer: [{ reply: "Noted.", newMemories: [DOG_FACT] }] },
    }).generateText,
    humanEvents: [say("My dog is named Biscuit."), end],
  });
  expect(first.memories).toEqual([DOG_FACT]);

  // A new thread: fresh machine, fresh transcript, the store from the last output.
  const executors = createMockModelExecutors({
    text: { answer: [{ reply: "Biscuit.", newMemories: [] }] },
  });
  const second = await runLongTermMemoryExample({
    memories: first.memories,
    generateText: executors.generateText,
    humanEvents: [say("Remind me what my dog is called?"), end],
  });
  const [input] = answerInputs(executors);
  expect(input!.transcript).toEqual([]);
  expect(input!.memories).toEqual([DOG_FACT]);
  expect(second.memories).toEqual([DOG_FACT]);
});

test("saving dedupes, caps the store at MAX_MEMORIES, and counts evictions", async () => {
  const full = Array.from({ length: MAX_MEMORIES }, (_, index) => `Fact number ${index + 1}.`);
  const result = await runLongTermMemoryExample({
    memories: full,
    generateText: createMockModelExecutors({
      text: {
        // One duplicate (case/space-insensitive), one blank, two genuinely new.
        answer: [{ reply: "ok", newMemories: ["fact  NUMBER 3.", "", "New A.", "New B."] }],
      },
    }).generateText,
    humanEvents: [say("hello"), end],
  });
  expect(result.memories).toHaveLength(MAX_MEMORIES);
  expect(result.memories.slice(-2)).toEqual(["New A.", "New B."]);
  expect(result.memories[0]).toBe("Fact number 3.");
  expect(result.summary).toContain(`2 oldest evicted (cap ${MAX_MEMORIES})`);
});

test("recall returns at most RECALL_LIMIT memories", async () => {
  const executors = createMockModelExecutors({
    text: { answer: [{ reply: "ok", newMemories: [] }] },
  });
  await runLongTermMemoryExample({
    memories: ["coffee one", "coffee two", "coffee three", "coffee four", "tea five"],
    generateText: executors.generateText,
    humanEvents: [say("coffee?"), end],
  });
  expect(answerInputs(executors)[0]!.memories).toHaveLength(RECALL_LIMIT);
});

test("MAX_TURNS messages close the session in `done` (not a failure)", async () => {
  const result = await runLongTermMemoryExample({
    generateText: createMockModelExecutors({
      text: { answer: [{ reply: "ok", newMemories: [] }] },
    }).generateText,
    humanEvents: Array.from({ length: MAX_TURNS + 3 }, (_, index) => say(`message ${index}`)),
  });
  expect(result.outcome).toBe("done");
  expect(result.turns).toBe(MAX_TURNS);
  expect(result.summary).toContain(`${MAX_TURNS}-message limit (not a failure`);
});

test("idle → persist → JSON round-trip → resume keeps the store and transcript", async () => {
  const executors = createMockModelExecutors({
    text: { answer: [{ reply: "Hi Ana.", newMemories: ["The user's name is Ana."] }] },
  });
  const first = await runAgent(longTermMemoryMachine, {
    input: { userId: "u1", memories: [] },
    executors,
  });
  expect(first.status).toBe("idle");
  if (first.status !== "idle") return;
  const interaction = getInteraction(first.snapshot);
  expect(interaction?.textEvent).toBe("MESSAGE");
  expect(interaction?.events.map(({ type }) => type)).toEqual(["MESSAGE", "END_SESSION"]);

  const second = await runAgent(longTermMemoryMachine, {
    snapshot: JSON.parse(JSON.stringify(first.persist())),
    event: say("I'm Ana."),
    executors,
  });
  expect(second.status).toBe("idle");
  if (second.status !== "idle") return;
  expect(getInteraction(second.snapshot)?.label).toBe("Hi Ana.");
  expect(second.snapshot.context.memories).toEqual(["The user's name is Ana."]);

  const third = await runAgent(longTermMemoryMachine, {
    snapshot: JSON.parse(JSON.stringify(second.persist())),
    event: end,
    executors,
  });
  expect(third.status).toBe("done");
  if (third.status !== "done") return;
  expect(third.output.memories).toEqual(["The user's name is Ana."]);
});

test("a model error lands in `failed` and still returns the store", async () => {
  const result = await runLongTermMemoryExample({
    memories: ["kept"],
    generateText: async () => {
      throw new Error("provider down");
    },
    humanEvents: [say("hello")],
  });
  expect(result.outcome).toBe("failed");
  expect(result.memories).toEqual(["kept"]);
  expect(result.summary).toContain("answer failed");
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as Array<{ label: string; input: { userId: string; memories: string[] } }>;
  expect(starters).toHaveLength(3);

  const run = (memories: string[], message: string) => {
    const executors = createMockModelExecutors({
      text: { answer: [{ reply: "ok", newMemories: ["The user's favourite colour is green."] }] },
    });
    return runLongTermMemoryExample({
      memories,
      generateText: executors.generateText,
      humanEvents: [say(message), end],
    }).then((result) => ({ result, input: answerInputs(executors)[0]! }));
  };

  const empty = starters.find((starter) => starter.label.startsWith("Empty store"))!;
  expect(empty.input.memories).toEqual([]);
  const fresh = await run(empty.input.memories, "My favourite colour is green.");
  expect(fresh.result.memories).toEqual(["The user's favourite colour is green."]);

  const returning = starters.find((starter) => starter.label.startsWith("Returning user"))!;
  const known = await run(returning.input.memories, "What's my name, and how do I like answers?");
  expect(known.input.memories.some((fact) => fact.includes("Priya"))).toBe(true);

  const capped = starters.find((starter) => starter.label.includes("cap"))!;
  expect(capped.input.memories).toHaveLength(MAX_MEMORIES);
  const evicting = await run(capped.input.memories, "My favourite colour is green.");
  expect(evicting.result.memories).toHaveLength(MAX_MEMORIES);
  expect(evicting.result.memories[0]).toBe(capped.input.memories[1]);
  expect(evicting.result.summary).toContain("1 oldest evicted");
});

test("lintAgentMachine is clean", () => {
  expect(() => lintAgentMachine(longTermMemoryMachine, { throw: true })).not.toThrow();
});
