/**
 * Free chat text in a state that declares no `textEvent`: Jev reads it as one
 * of the offered events, and the run resumes with that typed event — or, when
 * Jev is unsure, nothing is delivered and the reply names what is available.
 * Driven through the demo's real resume path with the provider layer mocked;
 * the judge picks whichever offered reading mentions `control.pick`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Snapshot } from "xstate";
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";
import { resumeMachineChat, startMachineChat, type MachineChatResult } from "./machine-chat.server";
import { TEXT_EVENT_CONFIDENCE } from "./interpret-text.server";
import { textCandidates, type AcceptedEvent } from "./machine-ui";

const control = vi.hoisted(() => ({
  /** Substring of the criterion the judge picks ("unclear" when none matches). */
  pick: "",
  confidence: 0.9,
  criteria: [] as Record<string, string>[],
}));

vi.mock("@ai-sdk/openai", async () => {
  const { genericLanguageModel } = await import("./test-generic-models");
  const openai = Object.assign((modelId: string) => genericLanguageModel(modelId), {
    chat: (modelId: string) => genericLanguageModel(modelId),
    responses: (modelId: string) => genericLanguageModel(modelId),
  });
  return { openai, createOpenAI: () => openai };
});

vi.mock("@ai-sdk/typesafe-ai", () => {
  const model = {
    specificationVersion: "v4",
    provider: "test-judge",
    modelId: "test-judge",
    supportedQuestionTypes: ["choice"],
    doEvaluate: async ({ questions }: { questions: Record<string, { criteria: object }> }) => {
      const answers: Record<string, unknown> = {};
      const confidence: Record<string, number> = {};
      for (const [id, question] of Object.entries(questions)) {
        const criteria = question.criteria as Record<string, string>;
        control.criteria.push(criteria);
        const labels = Object.keys(criteria);
        const choice =
          labels.find((label) => control.pick && criteria[label].includes(control.pick)) ??
          "unclear";
        const rest = (1 - 0.9) / Math.max(labels.length - 1, 1);
        answers[id] = {
          type: "choice",
          choice,
          probabilities: Object.fromEntries(
            labels.map((label) => [label, label === choice ? 0.9 : rest]),
          ),
        };
        confidence[id] = control.confidence;
      }
      return {
        answers,
        usage: { inputTokens: 0, outputTokens: 0 },
        warnings: [],
        providerMetadata: { typesafe: { confidence } },
        response: { modelId: "test-judge", timestamp: new Date(0) },
      };
    },
  };
  const provider = { evaluationModel: () => model };
  return { typeSafeAi: provider, createTypeSafeAi: () => provider };
});

beforeAll(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
  vi.stubEnv("TYPESAFE_AI_API_KEY", "test-typesafe-key");
  vi.stubEnv("OPENAI_MODEL", "");
});
afterAll(() => {
  vi.unstubAllEnvs();
});
beforeEach(() => {
  control.pick = "";
  control.confidence = 0.9;
  control.criteria = [];
});

/** A turn that waits on buttons only: no `textEvent`, none inferable. */
const gameMachine = setupAgent({
  context: z.object({}),
  events: {
    BANK: z.object({}),
    ROLL: z.object({}),
    ACCUSE: z.object({ player: z.enum(["Ada", "Bruno"]) }),
    RENAME: z.object({ name: z.string() }),
    NOTE: z.object({ note: z.string() }),
    // Two fields: no single reading of free text, so no candidate.
    TRADE: z.object({ give: z.string(), take: z.string() }),
  },
}).createMachine({
  id: "game",
  context: {},
  initial: "turn",
  states: {
    turn: {
      meta: {
        interaction: {
          label: "Your turn.",
          events: { BANK: { label: "Bank points" }, ROLL: { label: "Roll again" } },
        },
      },
      on: {
        BANK: { target: "done" },
        ROLL: { target: "done" },
        ACCUSE: { target: "done" },
        RENAME: { target: "done" },
        NOTE: { target: "done" },
        TRADE: { target: "done" },
      },
    },
    done: { type: "final" },
  },
});

async function interpret(
  text: string,
): Promise<{ started: MachineChatResult; result: MachineChatResult }> {
  const started = await startMachineChat(gameMachine, {});
  expect(started.status).toBe("idle");
  expect(started.idle?.textEvent).toBeNull();
  const result = await resumeMachineChat(
    gameMachine,
    started.idle!.snapshot as unknown as Snapshot<unknown>,
    { kind: "interpret", text },
  );
  return { started, result };
}

function deliveredEvent(result: MachineChatResult) {
  return result.trace.find(
    (entry) =>
      entry.kind === "transition" &&
      entry.event.type !== "@xstate.init" &&
      entry.event.type !== "xstate.init",
  )?.event;
}

describe("free text → an offered event (Jev)", () => {
  test("candidates: one per payload-free event, one per enum value, one per string field", () => {
    const event = (type: string, jsonSchema: AcceptedEvent["jsonSchema"]): AcceptedEvent => ({
      type,
      label: type,
      style: "default",
      jsonSchema,
      needsPayload: jsonSchema !== null,
    });
    const candidates = textCandidates([
      event("BANK", null),
      event("ACCUSE", {
        type: "object",
        properties: { player: { type: "string", enum: ["Ada", "Bruno"] } },
      }),
      event("RENAME", { type: "object", properties: { name: { type: "string" } } }),
      event("TRADE", {
        type: "object",
        properties: { give: { type: "string" }, take: { type: "string" } },
      }),
    ]);
    expect(candidates.map((candidate) => [candidate.event, candidate.fill])).toEqual([
      [{ type: "BANK" }, null],
      [{ type: "ACCUSE", player: "Ada" }, null],
      [{ type: "ACCUSE", player: "Bruno" }, null],
      [{ type: "RENAME" }, "name"],
    ]);
  });

  test("a payload-free choice resumes with that typed event", async () => {
    control.pick = "Bank points";
    const { result } = await interpret("bank");
    expect(result.status).toBe("done");
    expect(deliveredEvent(result)).toEqual({ type: "BANK" });
    // The judge saw the human labels, one reading per enum value, and "unclear".
    const [criteria] = control.criteria;
    const readings = Object.values(criteria);
    expect(readings.some((text) => text.includes('"Roll again" (event ROLL)'))).toBe(true);
    expect(readings.filter((text) => text.includes("(event ACCUSE)"))).toHaveLength(2);
    expect(readings.some((text) => text.includes("TRADE"))).toBe(false);
    expect(criteria.unclear).toBeDefined();
  });

  test("an enum field expands: the chosen value rides on the event", async () => {
    control.pick = "player Bruno";
    const { result } = await interpret("It was Bruno");
    expect(deliveredEvent(result)).toEqual({ type: "ACCUSE", player: "Bruno" });
  });

  test("a single string field takes the whole message", async () => {
    control.pick = "(event RENAME)";
    const { result } = await interpret("Call me Captain");
    expect(deliveredEvent(result)).toEqual({ type: "RENAME", name: "Call me Captain" });
  });

  test("low confidence delivers nothing and names the available actions", async () => {
    control.pick = "Bank points";
    control.confidence = TEXT_EVENT_CONFIDENCE - 0.1;
    const { started, result } = await interpret("hmm");
    expect(result.status).toBe("idle");
    expect(result.trace).toEqual([]);
    // Still waiting in the same state, on the snapshot the client sent.
    expect(result.idle?.snapshot).toEqual(started.idle!.snapshot);
    expect(result.idle?.events.map((event) => event.type)).toEqual(
      started.idle!.events.map((event) => event.type),
    );
    expect(result.response).toContain("“Bank points”");
    expect(result.response).toContain("“Roll again”");
  });

  test('a confident "unclear" also delivers nothing', async () => {
    const { result } = await interpret("what's for lunch?");
    expect(result.status).toBe("idle");
    expect(result.trace).toEqual([]);
  });
});
