import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor } from "xstate";
import { AgentInvalidEventPayloadError, parseAgentEvent, setupAgent } from "./index.js";

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
