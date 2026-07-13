import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor } from "xstate";
import { parseAgentEvent, setupAgent } from "./index.js";

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

  test("throws, listing accepted types, when the event type is not currently accepted", () => {
    const snapshot = createActor(machine).start().getSnapshot();
    expect(() => parseAgentEvent(snapshot, { type: "NOPE" }, options)).toThrow(
      /not an accepted event.*PROMPT_SUBMITTED/s,
    );
  });

  test("throws when the payload fails the registered schema", () => {
    const snapshot = createActor(machine).start().getSnapshot();
    expect(() => parseAgentEvent(snapshot, { type: "PROMPT_SUBMITTED" }, options)).toThrow(
      /payload failed validation/,
    );
  });
});
