import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, createMachine, type AnyStateMachine } from "xstate";
import {
  AgentInvalidEventPayloadError,
  getAcceptedEvents,
  parseAgentEvent,
  setupAgent,
} from "./index.js";

const agent = setupAgent({
  context: z.object({}),
  events: {
    PROMPT_SUBMITTED: z.object({ text: z.string() }),
    CANCEL: z.object({}),
  },
});

const machine = agent.createMachine({
  context: {},
  initial: "waiting",
  states: {
    waiting: {
      on: { PROMPT_SUBMITTED: { target: "done" }, CANCEL: { target: "done" } },
    },
    done: { type: "final" },
  },
});

const options = { events: agent.schemas.events };

describe("parseAgentEvent", () => {
  test("validates the payload and returns the event, typed as the machine union", () => {
    const snapshot = createActor(machine).start().getSnapshot();
    const event = parseAgentEvent(snapshot, { type: "PROMPT_SUBMITTED", text: "hi" }, options);
    expect(event).toEqual({ type: "PROMPT_SUBMITTED", text: "hi" });
    // Type-level: the event narrows to the machine union, so `.text` is reachable
    // only on the PROMPT_SUBMITTED branch.
    if (event.type === "PROMPT_SUBMITTED") {
      const text: string = event.text;
      expect(text).toBe("hi");
    }
  });

  test("accepts a zero-payload event", () => {
    const snapshot = createActor(machine).start().getSnapshot();
    expect(parseAgentEvent(snapshot, { type: "CANCEL" }, options)).toEqual({ type: "CANCEL" });
  });

  test("parses from the machine itself, using its registered event schemas", () => {
    expect(parseAgentEvent(machine, { type: "PROMPT_SUBMITTED", text: "hi" })).toEqual({
      type: "PROMPT_SUBMITTED",
      text: "hi",
    });
  });

  test("does not check whether the state handles the event — that is the machine's job", () => {
    const snapshot = createActor(machine).start().getSnapshot();
    // A state machine ignores events it has no transition for; parsing is
    // about payload shape only, so an unhandled type passes straight through.
    expect(parseAgentEvent(snapshot, { type: "NOPE" }, options)).toEqual({ type: "NOPE" });
  });

  test("throws AgentInvalidEventPayloadError when the payload fails the registered schema", () => {
    const snapshot = createActor(machine).start().getSnapshot();
    expect(() => parseAgentEvent(snapshot, { type: "PROMPT_SUBMITTED" }, options)).toThrow(
      AgentInvalidEventPayloadError,
    );
  });

  test("throws when the payload is not an object with a string `type`", () => {
    expect(() => parseAgentEvent(machine, "PROMPT_SUBMITTED")).toThrow(
      AgentInvalidEventPayloadError,
    );
    expect(() => parseAgentEvent(machine, { text: "hi" })).toThrow(AgentInvalidEventPayloadError);
  });
});

describe("getAcceptedEvents with a wildcard handler", () => {
  const wildcard = (events: Record<string, z.ZodType>) =>
    createActor(
      createMachine({
        schemas: { events },
        initial: "open",
        states: { open: { on: { "desk.*": { target: "open" } } } },
      }),
    )
      .start()
      .getSnapshot();

  test("expands to the registered types the handler matches, by xstate's rule", () => {
    const snapshot = wildcard({
      desk: z.object({}),
      "desk.refund": z.object({ amount: z.number() }),
      "desk.case.close": z.object({}),
      desktop: z.object({}),
      other: z.object({}),
    });

    const types = getAcceptedEvents(snapshot).map((event) => event.type);

    expect(types).toEqual(["desk", "desk.refund", "desk.case.close"]);
    expect(types.every((type) => snapshot.can({ type }))).toBe(true);
    expect(snapshot.can({ type: "desktop" })).toBe(false);
  });

  test("an expanded type carries the event schema it was found in", () => {
    const refund = z.object({ amount: z.number() });
    const snapshot = wildcard({ "desk.refund": refund });

    expect(getAcceptedEvents(snapshot)).toEqual([
      expect.objectContaining({ type: "desk.refund", inputSchema: refund }),
    ]);
  });

  test("expands against the machine's own types as well as a supplied registry", () => {
    const snapshot = wildcard({ "desk.close": z.object({}) });

    expect(
      getAcceptedEvents(snapshot, { events: { other: z.object({}) } }).map((event) => event.type),
    ).toEqual(["desk.close"]);
  });

  test("a human-tagged wildcard withholds what it expands to in a supplied registry", () => {
    const snapshot = createActor(
      createMachine({
        schemas: { events: { reset: z.object({}) } },
        initial: "open",
        states: {
          open: {
            on: {
              "desk.secure.*": { target: "open", meta: { actor: "human" } },
              "desk.*": { target: "open" },
            },
          },
        },
      } as never) as AnyStateMachine,
    )
      .start()
      .getSnapshot();
    const events = { "desk.secure.approve": z.object({}), "desk.refund": z.object({}) };

    expect(
      getAcceptedEvents(snapshot, { actor: "agent", events }).map((event) => event.type),
    ).toEqual(["desk.refund"]);
  });

  test("narrows the expansion with `eventTypes`", () => {
    const snapshot = wildcard({ "desk.refund": z.object({}), "desk.close": z.object({}) });

    expect(
      getAcceptedEvents(snapshot, { eventTypes: ["desk.close"] }).map((event) => event.type),
    ).toEqual(["desk.close"]);
  });

  test("keeps the pattern when no registered type matches it", () => {
    const snapshot = wildcard({ other: z.object({}) });

    expect(getAcceptedEvents(snapshot).map((event) => event.type)).toEqual(["desk.*"]);
  });
});
