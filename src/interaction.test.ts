import { describe, expect, expectTypeOf, test } from "vitest";
import { createActor } from "xstate";
import { z } from "zod";
import {
  AgentIllegalResumeEventError,
  eventFromInteraction,
  getInteraction,
  interactionMetaSchema,
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
        on: { APPROVE: { target: "review" }, REJECT: { target: "review" } },
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
          on: { APPROVE: { target: "review" } },
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

describe("interactionMetaSchema", () => {
  const validate = (value: unknown) => interactionMetaSchema["~standard"].validate(value);

  test("accepts the meta shape getInteraction reads", () => {
    const meta = {
      interaction: {
        label: "Approve {draft.subject}?",
        events: {
          APPROVE: { label: "Approve", style: "primary", event: { id: 42 } },
          REJECT: "Reject",
        },
        textEvent: "REJECT",
      },
    };
    expect(validate(meta)).toEqual({ value: meta });
  });

  test("accepts meta with no interaction, and a function label", () => {
    expect(validate({})).toEqual({ value: {} });
    expect(validate({ interaction: { label: () => "computed" } })).toHaveProperty("value");
  });

  test("reports the offending path", () => {
    expect(validate({ interaction: { textEvent: 7 } })).toMatchObject({
      issues: [{ path: ["interaction", "textEvent"] }],
    });
    expect(validate({ interaction: { events: { APPROVE: { style: 1 } } } })).toMatchObject({
      issues: [{ path: ["interaction", "events", "APPROVE", "style"] }],
    });
    expect(validate({ interaction: [] })).toMatchObject({
      issues: [{ path: ["interaction"] }],
    });
    expect(validate({ interaction: { events: { APPROVE: ["Approve"] } } })).toMatchObject({
      issues: [{ path: ["interaction", "events", "APPROVE"] }],
    });
    expect(validate(null)).toMatchObject({ issues: [{ message: expect.any(String) }] });
  });

  test("types a machine's meta without restating the shape", () => {
    const typed = setupAgent({
      context: z.object({ subject: z.string() }),
      events: { APPROVE: z.object({}) },
      meta: interactionMetaSchema,
    });
    const typedMachine = typed.createMachine({
      context: { subject: "Hello" },
      initial: "review",
      states: {
        review: {
          meta: { interaction: { label: "Approve {subject}?", events: { APPROVE: "Approve" } } },
          on: { APPROVE: { target: "review" } },
        },
      },
    });
    expect(getInteraction(createActor(typedMachine).getSnapshot())).toEqual({
      label: "Approve Hello?",
      events: [{ type: "APPROVE", label: "Approve" }],
    });
  });
});

describe("getInteraction whitespace", () => {
  const agent = setupAgent({
    context: z.object({ diff: z.string() }),
    events: { APPROVE: z.object({}) },
    meta: interactionMetaSchema,
  });
  const machine = agent.createMachine({
    context: { diff: "- one\n+ two" },
    initial: "review",
    states: {
      review: {
        meta: { interaction: { label: "Apply?\n{diff}", events: { APPROVE: "Approve  now" } } },
        on: { APPROVE: { target: "review" } },
      },
    },
  });
  const snapshot = createActor(machine).getSnapshot();

  test("collapses whitespace by default", () => {
    expect(getInteraction(snapshot)).toEqual({
      label: "Apply? - one + two",
      events: [{ type: "APPROVE", label: "Approve now" }],
    });
  });

  test("preserveWhitespace keeps multi-line labels intact", () => {
    expect(getInteraction(snapshot, { preserveWhitespace: true })).toEqual({
      label: "Apply?\n- one\n+ two",
      events: [{ type: "APPROVE", label: "Approve  now" }],
    });
  });
});

describe("interaction event typing", () => {
  const agent = setupAgent({
    context: z.object({}),
    events: { APPROVE: z.object({}), REJECT: z.object({ reason: z.string() }) },
    meta: interactionMetaSchema,
  });
  const machine = agent.createMachine({
    context: {},
    initial: "review",
    states: {
      review: {
        meta: {
          interaction: {
            label: "Approve?",
            events: { APPROVE: "Approve", REJECT: "Reject" },
            textEvent: "REJECT",
          },
        },
        on: { APPROVE: { target: "done" }, REJECT: { target: "done" } },
      },
      done: { type: "final" },
    },
  });
  const snapshot = createActor(machine).getSnapshot();

  test("eventFromInteraction returns the machine's event union", () => {
    const event = eventFromInteraction(snapshot, { type: "APPROVE" });
    expectTypeOf(event.type).toEqualTypeOf<
      "APPROVE" | "REJECT" | "agent.messages" | "@agent.usage"
    >();
    // No cast needed to send it back into the machine.
    expect(snapshot.can(event)).toBe(true);
    expect(event).toEqual({ type: "APPROVE" });
  });

  test("getInteraction narrows choice and text event types", () => {
    const interaction = getInteraction(snapshot)!;
    expectTypeOf(interaction.textEvent).toExtend<string | undefined>();
    expectTypeOf(interaction.events[0]!.type).toEqualTypeOf<
      "APPROVE" | "REJECT" | "agent.messages" | "@agent.usage"
    >();
  });
});

describe("getInteraction respects guards on choice events", () => {
  test("a choice the machine would refuse right now is not rendered", () => {
    const agent = setupAgent({
      context: z.object({ turns: z.number() }),
      events: { AGAIN: z.object({}), END: z.object({}) },
      meta: interactionMetaSchema,
    });
    const machine = agent.createMachine({
      context: { turns: 0 },
      initial: "waiting",
      states: {
        waiting: {
          meta: { interaction: { label: "Go on?", events: { AGAIN: "Again", END: "End" } } },
          on: {
            AGAIN: ({ context }) => (context.turns >= 1 ? undefined : { target: "waiting" }),
            END: { target: "done" },
          },
        },
        done: { type: "final" },
      },
    });
    const fresh = machine.resolveState({ value: "waiting", context: { turns: 0 } });
    const spent = machine.resolveState({ value: "waiting", context: { turns: 1 } });
    expect(getInteraction(fresh)?.events.map((event) => event.type)).toEqual(["AGAIN", "END"]);
    expect(getInteraction(spent)?.events.map((event) => event.type)).toEqual(["END"]);
  });
});
