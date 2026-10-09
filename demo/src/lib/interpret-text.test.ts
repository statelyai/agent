/**
 * Free chat text where more than one reading is on offer: Jev reads it as one
 * of the offered events (the state's text event among them), and the run
 * resumes with that typed event — or, when Jev is unsure, nothing is
 * delivered and the reply names what is available. Driven through the demo's
 * real resume paths with the provider layer mocked; the judge picks whichever
 * offered reading mentions `control.pick`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Snapshot } from "xstate";
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";
import { resumeMachineChat, startMachineChat, type MachineChatResult } from "./machine-chat.server";
import { interpretIdleText, TEXT_EVENT_CONFIDENCE } from "./interpret-text.server";
import { resumeScenario, startScenarioRun } from "./agent-runner";
import { textCandidates, textRouting, type AcceptedEvent, type ChatIdle } from "./machine-ui";

const control = vi.hoisted(() => ({
  /** Substring of the criterion the judge picks ("unclear" when none matches). */
  pick: "",
  confidence: 0.9,
  criteria: [] as Record<string, string>[],
  states: [] as Record<string, unknown>[],
  /** Set to make the judge throw, like an outage or a bad key. */
  fail: null as Error | null,
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
    doDecide: async ({
      questions,
      state,
    }: {
      questions: Record<string, { criteria: object }>;
      // The SDK wraps the machine's plain state in one `{ type: "json" }` part.
      state: [{ type: "json"; value: Record<string, unknown> }];
    }) => {
      if (control.fail) throw control.fail;
      control.states.push(state[0].value);
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
  const provider = { decisionModel: () => model };
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
  control.states = [];
  control.fail = null;
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
    expect(readings.some((text) => text.includes('"Roll again"'))).toBe(true);
    expect(readings.filter((text) => text.includes('"Accuse"'))).toHaveLength(2);
    expect(readings.some((text) => text.includes("Trade"))).toBe(false);
    expect(criteria.unclear).toBeDefined();
  });

  test("an enum field expands: the chosen value rides on the event", async () => {
    control.pick = "player Bruno";
    const { result } = await interpret("It was Bruno");
    expect(deliveredEvent(result)).toEqual({ type: "ACCUSE", player: "Bruno" });
  });

  test("a single string field takes the whole message", async () => {
    control.pick = '"Rename"';
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

  test("a failed judgment reads as unclear to the person and is logged", async () => {
    control.fail = new Error("401 bad key");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { result } = await interpret("bank");
      expect(result.status).toBe("idle");
      expect(result.trace).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Jev judgment failed"),
        expect.objectContaining({ message: expect.stringContaining("401 bad key") }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

const event = (
  type: string,
  label: string,
  jsonSchema: AcceptedEvent["jsonSchema"] = null,
): AcceptedEvent => ({
  type,
  label,
  style: "default",
  jsonSchema,
  needsPayload: jsonSchema !== null,
});
const oneField = (name: string, schema: Record<string, unknown>) =>
  ({
    type: "object",
    properties: { [name]: schema },
    required: [name],
  }) as AcceptedEvent["jsonSchema"];

describe("a reply that is exactly a choice's name", () => {
  test("picks it without asking the judge, even when the judge would be unsure", async () => {
    const idle: ChatIdle = {
      prompt: "Who is the chameleon?",
      events: [
        event(
          "ACCUSE",
          "Accuse this seat",
          oneField("seat", {
            type: "integer",
            minimum: 0,
            maximum: 3,
            description: "Seat to accuse: 0=Ada, 1=Bruno, 2=Cleo, 3=Dev",
          }),
        ),
      ],
      textEvent: null,
      component: null,
    };
    control.pick = "";
    control.confidence = 0.1;
    expect(await interpretIdleText("Cleo", idle)).toEqual({ type: "ACCUSE", seat: 2 });
    expect(await interpretIdleText(" cleo. ", idle)).toEqual({ type: "ACCUSE", seat: 2 });
    expect(await interpretIdleText("2", idle)).toEqual({ type: "ACCUSE", seat: 2 });
    const rps: ChatIdle = {
      prompt: "Your throw?",
      events: [event("HUMAN_ROCK", "Rock"), event("HUMAN_PAPER", "Paper")],
      textEvent: null,
      component: null,
    };
    expect(await interpretIdleText("rock", rps)).toEqual({ type: "HUMAN_ROCK" });
    expect(control.states).toEqual([]);
  });
});

describe("numeric choices", () => {
  test("a small bounded integer field, or an enum of numbers, is one candidate per value", () => {
    const seats = textCandidates([
      event(
        "ACCUSE",
        "Accuse this seat",
        oneField("seat", { type: "integer", minimum: 0, maximum: 3 }),
      ),
    ]);
    expect(seats.map((candidate) => candidate.event)).toEqual(
      [0, 1, 2, 3].map((seat) => ({ type: "ACCUSE", seat })),
    );
    expect(seats[2]!.description).toContain("seat 2");
    const rated = textCandidates([
      event("RATE", "Rate", oneField("stars", { type: "number", enum: [1, 3, 5] })),
    ]);
    expect(rated.map((candidate) => candidate.event)).toEqual(
      [1, 3, 5].map((stars) => ({ type: "RATE", stars })),
    );
  });

  test("a field that documents its values names them in each candidate", () => {
    const seats = textCandidates([
      event(
        "ACCUSE",
        "Accuse this seat",
        oneField("seat", {
          type: "integer",
          minimum: 0,
          maximum: 3,
          description: "Seat to accuse: 0=Ada, 1=Bruno, 2=Cleo, 3=Dev",
        }),
      ),
    ]);
    expect(seats[2]!.description).toContain("seat 2 (Cleo)");
    expect(seats[0]!.description).toContain("seat 0 (Ada)");
  });

  test("an open-ended or wide number field offers no candidates", () => {
    const open = (schema: Record<string, unknown>) =>
      textCandidates([event("SET", "Set", oneField("value", schema))]);
    expect(open({ type: "integer" })).toEqual([]);
    expect(open({ type: "integer", minimum: 0 })).toEqual([]);
    expect(open({ type: "integer", minimum: 0, maximum: 12 })).toEqual([]);
    // Zod's `int()` alone bounds to the safe-integer range.
    expect(
      open({ type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 }),
    ).toEqual([]);
    expect(open({ type: "integer", minimum: 1, maximum: 12 })).toHaveLength(12);
  });

  test("a name maps to its seat: the judge reads the prompt that says which number is whom", async () => {
    const idle: ChatIdle = {
      prompt: "Who is the chameleon? (0=Ada, 1=Bruno, 2=Cleo, 3=Dev)",
      events: [
        event(
          "ACCUSE",
          "Accuse this seat",
          oneField("seat", { type: "integer", minimum: 0, maximum: 3 }),
        ),
      ],
      textEvent: null,
      component: null,
    };
    expect(textRouting(idle)).toBe("interpret");
    control.pick = "seat 2";
    expect(await interpretIdleText("I accuse Cleo", idle)).toEqual({ type: "ACCUSE", seat: 2 });
    expect(control.states[0]).toMatchObject({
      reply: "I accuse Cleo",
      appSaid: expect.stringContaining("2=Cleo"),
    });
  });
});

describe("a text event among other actions", () => {
  const review: ChatIdle = {
    prompt: "Approve the draft to publish it, or type what you want changed.",
    events: [
      event("APPROVE", "Approve draft"),
      event("REJECT", "Request changes", oneField("text", { type: "string" })),
    ],
    textEvent: { type: "REJECT", field: "text" },
    component: null,
  };

  test("routing: direct only when the text event is the one reading", () => {
    expect(textRouting(review)).toBe("interpret");
    expect(textRouting({ ...review, textEvent: null })).toBe("interpret");
    const chat: ChatIdle = {
      ...review,
      events: [
        event("REJECT", "Request changes", oneField("text", { type: "string" })),
        event("TRADE", "Trade", {
          type: "object",
          properties: { give: { type: "string" }, take: { type: "string" } },
        }),
      ],
    };
    expect(textRouting(chat)).toBe("direct");
    expect(textRouting({ ...chat, textEvent: null, events: [chat.events[1]!] })).toBe("none");
  });

  test('"approve it" chooses APPROVE, not the text event', async () => {
    control.pick = '"Approve draft"';
    expect(await interpretIdleText("approve it", review)).toEqual({ type: "APPROVE" });
    // The text event is a catch-all reading, and it replaces "unclear".
    const [criteria] = control.criteria;
    expect(criteria.unclear).toBeUndefined();
    expect(Object.values(criteria).some((text) => text.includes("message of its own"))).toBe(true);
  });

  test("the text event carries the whole text, even when Jev is unsure", async () => {
    control.pick = "message of its own";
    control.confidence = TEXT_EVENT_CONFIDENCE - 0.2;
    expect(await interpretIdleText("make it shorter", review)).toEqual({
      type: "REJECT",
      text: "make it shorter",
    });
  });

  test("an unsure pick of another action delivers nothing rather than the text event", async () => {
    control.pick = '"Approve draft"';
    control.confidence = TEXT_EVENT_CONFIDENCE - 0.1;
    expect(await interpretIdleText("looks good?", review)).toBeNull();
  });
});

describe("scenario runs interpret free text too", () => {
  // A drafter that always produces a complete draft, so the run waits in
  // `reviewing` on SEND / ADD_SUBJECT / REQUEST_CHANGES (the text event).
  const reviewing = async () => {
    const started = await startScenarioRun(
      "email-drafter-v2",
      "Email alex@example.com",
      undefined,
      {
        generateText: async () => ({
          result: {
            to: "alex@example.com",
            subject: "Coffee",
            body: "Coffee on Thursday?",
            openQuestions: [],
          },
        }),
      },
    );
    expect(started.status).toBe("idle");
    expect(textRouting(started.idle!)).toBe("interpret");
    return started.idle!.snapshot as unknown as Snapshot<unknown>;
  };
  const delivered = (result: { trace: MachineChatResult["trace"] }) =>
    result.trace.find(
      (entry) =>
        entry.kind === "transition" &&
        entry.event.type !== "@xstate.init" &&
        entry.event.type !== "xstate.init",
    )?.event;

  test('"send it" sends', async () => {
    control.pick = '"Send email"';
    const result = await resumeScenario("email-drafter-v2", await reviewing(), {
      kind: "interpret",
      text: "send it",
    });
    expect(delivered(result)).toEqual({ type: "SEND" });
  });

  test('"make it shorter" requests changes with the whole text', async () => {
    control.pick = "message of its own";
    const result = await resumeScenario("email-drafter-v2", await reviewing(), {
      kind: "interpret",
      text: "make it shorter",
    });
    expect(delivered(result)).toEqual({ type: "REQUEST_CHANGES", text: "make it shorter" });
  });

  test("an unclear reading re-settles idle with the available actions", async () => {
    control.pick = '"Send email"';
    control.confidence = TEXT_EVENT_CONFIDENCE - 0.1;
    const snapshot = await reviewing();
    const result = await resumeScenario("email-drafter-v2", snapshot, {
      kind: "interpret",
      text: "hmm",
    });
    expect(result.status).toBe("idle");
    expect(result.trace).toEqual([]);
    expect(result.idle?.snapshot).toEqual(snapshot);
    expect(result.response).toContain("“Send email”");
  });
});
