import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { getInteraction, getStatePath, runAgent } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import {
  MAX_TURNS,
  infoGatheringMachine,
  runInfoGatheringExample,
  type InfoGatheringHumanEvent,
} from "./index.js";

/** One extraction answer: every slot null unless given. */
function extraction(
  nextQuestion: string,
  slots: Partial<Record<"objective" | "variables" | "constraints" | "requirements", string>> = {},
) {
  return {
    objective: slots.objective ?? null,
    variables: slots.variables ?? null,
    constraints: slots.constraints ?? null,
    requirements: slots.requirements ?? null,
    nextQuestion,
  };
}

const allSlots = {
  objective: "extract invoice fields from emails",
  variables: "email_body",
  constraints: "no guessing missing values",
  requirements: "return JSON with vendor, total, due_date",
};

const answer = (text: string): InfoGatheringHumanEvent => ({ type: "ANSWER", text });

test("asks for missing slots one turn at a time, then writes the prompt", async () => {
  const executors = createMockModelExecutors({
    text: {
      gatherRequirements: [
        extraction("What variables does the template take?", { objective: allSlots.objective }),
        extraction("Any constraints on the output?", { variables: allSlots.variables }),
        // A later turn returning null for a slot keeps the earlier value.
        extraction("Confirm?", {
          constraints: allSlots.constraints,
          requirements: allSlots.requirements,
        }),
      ],
      writePrompt: [{ prompt: "Extract {email_body} invoice fields as JSON." }],
    },
  });
  const questions: string[] = [];
  const result = await runInfoGatheringExample({
    opener: "I need a prompt that extracts invoice fields from emails",
    generateText: executors.generateText,
    humanEvents: [answer("the email body"), answer("no guessing; JSON with vendor, total, due")],
    onQuestion: (question) => questions.push(question),
  });

  expect(result.outcome).toBe("done");
  expect(result.prompt).toBe("Extract {email_body} invoice fields as JSON.");
  expect(result).toMatchObject({ ...allSlots, turns: 2 });
  expect(questions).toEqual([
    "What variables does the template take?",
    "Any constraints on the output?",
  ]);
  expect(result.progress).toEqual([
    "gathering",
    "awaitingAnswer",
    "gathering",
    "awaitingAnswer",
    "gathering",
    "generatingPrompt",
    "done",
  ]);
  // Each pass sees the whole transcript, including the question it answered.
  const gatherInputs = executors.calls
    .filter((call) => call.name === "gatherRequirements")
    .map((call) => call.input as { transcript: string[]; missing: string[] });
  expect(gatherInputs[0]!.missing).toEqual([
    "objective",
    "variables",
    "constraints",
    "requirements",
  ]);
  expect(gatherInputs[2]!.transcript).toContain("Assistant: Any constraints on the output?");
  expect(gatherInputs[2]!.missing).toEqual(["constraints", "requirements"]);
});

test("one confirmation turn minimum: a complete opener still asks once", async () => {
  const executors = createMockModelExecutors({
    text: {
      gatherRequirements: [extraction("Here is what I have. Anything to change?", allSlots)],
      writePrompt: [{ prompt: "final" }],
    },
  });

  const first = await runAgent(infoGatheringMachine, {
    input: { opener: "everything at once" },
    executors,
  });
  expect(first.status).toBe("idle");
  if (first.status !== "idle") return;
  expect(getStatePath(first.snapshot)).toBe("awaitingAnswer");
  const interaction = getInteraction(first.snapshot);
  expect(interaction?.label).toBe("Here is what I have. Anything to change?");
  expect(interaction?.textEvent).toBe("ANSWER");

  // Resume through a real JSON round-trip, as a stored row would.
  const second = await runAgent(infoGatheringMachine, {
    snapshot: JSON.parse(JSON.stringify(first.persist())),
    event: answer("looks right"),
    executors,
  });
  expect(second.status).toBe("done");
  if (second.status !== "done") return;
  expect(getStatePath(second.snapshot)).toBe("done");
  expect(second.output).toMatchObject({ prompt: "final", turns: 1 });
});

test("MAX_TURNS answers with a slot still empty ends in `failed` with the partial requirements", async () => {
  const executors = createMockModelExecutors({
    text: {
      // The model never learns the requirements slot.
      gatherRequirements: [
        extraction("What are the requirements?", {
          objective: allSlots.objective,
          variables: allSlots.variables,
          constraints: allSlots.constraints,
        }),
      ],
      writePrompt: [{ prompt: "should never be written" }],
    },
  });
  const result = await runInfoGatheringExample({
    generateText: executors.generateText,
    humanEvents: Array.from({ length: MAX_TURNS + 2 }, () => answer("not sure")),
  });

  expect(result.outcome).toBe("failed");
  expect(result.turns).toBe(MAX_TURNS);
  expect(result.prompt).toContain(`MAX_TURNS=${MAX_TURNS}`);
  expect(result.prompt).toContain(`- objective: ${allSlots.objective}`);
  expect(result.prompt).toContain("Still missing: requirements");
  expect(result.requirements).toBeNull();
  expect(executors.calls.some((call) => call.name === "writePrompt")).toBe(false);
  expect(result.progress.filter((state) => state === "awaitingAnswer")).toHaveLength(MAX_TURNS);
});

test("a model error lands in `failed`, not an unhandled rejection", async () => {
  const result = await runInfoGatheringExample({
    generateText: async () => {
      throw new Error("provider down");
    },
  });
  expect(result.outcome).toBe("failed");
  expect(result.prompt).toContain("gatherRequirements failed");
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as string[];
  expect(starters.length).toBeGreaterThanOrEqual(2);

  for (const opener of starters) {
    const executors = createMockModelExecutors({
      text: {
        gatherRequirements: [
          extraction("What variables?", { objective: opener }),
          extraction("Ok?", allSlots),
        ],
        writePrompt: [{ prompt: "final" }],
      },
    });
    const result = await runInfoGatheringExample({
      opener,
      generateText: executors.generateText,
      humanEvents: [answer("the email body")],
    });
    // Each starter is the user's first message: it seeds the transcript the
    // first extraction sees, and the run asks before writing anything.
    const firstInput = executors.calls[0]!.input as { transcript: string[] };
    expect(firstInput.transcript).toEqual([`User: ${opener}`]);
    expect(result.progress[1]).toBe("awaitingAnswer");
    expect(result.outcome).toBe("done");
  }
});

test("lintAgentMachine is clean", () => {
  expect(() => lintAgentMachine(infoGatheringMachine, { throw: true })).not.toThrow();
});
