import { describe, expect, test } from "vitest";
import { createActor } from "xstate";
import { z } from "zod";
import {
  AgentIllegalResumeEventError,
  eventFromInteraction,
  getInteraction,
  setupAgent,
} from "./index.js";

describe("interactions", () => {
  const agent = setupAgent({
    context: z.object({ draft: z.object({ subject: z.string() }) }),
    events: {
      APPROVE: z.object({ id: z.number() }),
      REJECT: z.object({ text: z.string() }),
      HIDDEN: z.object({}),
    },
    meta: z.object({ interaction: z.unknown().optional() }),
  });
  const machine = agent.createMachine({
    context: { draft: { subject: "  Hello   world " } },
    initial: "review",
    states: {
      review: {
        meta: {
          interaction: {
            label: "Approve {draft.subject}?",
            events: {
              APPROVE: { label: "Approve", event: { id: 42 } },
              REJECT: { label: "Reject", style: "danger" },
              HIDDEN: { label: "Not accepted here" },
            },
            textEvent: "REJECT",
          },
        },
        on: { APPROVE: {}, REJECT: {} },
      },
    },
  });
  const snapshot = createActor(machine).getSnapshot();

  test("renders labels and only currently accepted events", () => {
    expect(getInteraction(snapshot)).toEqual({
      label: "Approve Hello world ?",
      events: [
        { type: "APPROVE", label: "Approve", event: { id: 42 } },
        { type: "REJECT", label: "Reject", style: "danger" },
      ],
      textEvent: "REJECT",
    });
  });

  test("builds and validates button and text events", () => {
    expect(eventFromInteraction(snapshot, { type: "APPROVE" })).toEqual({
      type: "APPROVE",
      id: 42,
    });
    expect(eventFromInteraction(snapshot, { text: "needs work" })).toEqual({
      type: "REJECT",
      text: "needs work",
    });
  });

  test("keeps metadata fields fixed when building an event", () => {
    expect(eventFromInteraction(snapshot, { type: "APPROVE", id: 7 })).toEqual({
      type: "APPROVE",
      id: 42,
    });
  });

  test("does not advertise a text event the state cannot accept", () => {
    const hiddenTextMachine = agent.createMachine({
      context: { draft: { subject: "Hello" } },
      initial: "review",
      states: {
        review: {
          meta: {
            interaction: {
              label: "Review",
              textEvent: "HIDDEN",
            },
          },
          on: { APPROVE: {} },
        },
      },
    });
    const hiddenTextSnapshot = createActor(hiddenTextMachine).getSnapshot();

    expect(getInteraction(hiddenTextSnapshot)).toEqual({ label: "Review", events: [] });
    expect(() => eventFromInteraction(hiddenTextSnapshot, { text: "not accepted" })).toThrow(
      AgentIllegalResumeEventError,
    );
  });
});
