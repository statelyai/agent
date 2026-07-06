import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor } from "xstate";
import { getStateMeta, setupAgent } from "./index.js";

const metaSchema = z.object({
  interaction: z
    .object({
      label: z.string(),
      eventType: z.string(),
    })
    .optional(),
  banner: z.string().optional(),
});

const agent = setupAgent({
  context: z.object({}),
  meta: metaSchema,
  events: { GO: z.object({}), DONE: z.object({}) },
});

describe("getStateMeta", () => {
  test("returns the active leaf state meta (happy path)", () => {
    const machine = agent.createMachine({
      context: {},
      initial: "waiting",
      states: {
        waiting: {
          meta: { interaction: { label: "Approve?", eventType: "GO" } },
          on: { GO: { target: "done" } },
        },
        done: {},
      },
    });
    const snapshot = createActor(machine).start().getSnapshot();

    const meta = getStateMeta(snapshot);
    expect(meta.interaction).toEqual({ label: "Approve?", eventType: "GO" });
  });

  test("returns {} when no active state declares meta", () => {
    const machine = agent.createMachine({
      context: {},
      initial: "plain",
      states: { plain: {} },
    });
    const snapshot = createActor(machine).start().getSnapshot();

    expect(getStateMeta(snapshot)).toEqual({});
  });

  test("shallow-merges meta across a nested active path (deeper wins)", () => {
    const machine = agent.createMachine({
      context: {},
      initial: "parent",
      states: {
        parent: {
          meta: { banner: "parent", interaction: { label: "p", eventType: "GO" } },
          initial: "child",
          states: {
            child: {
              meta: { interaction: { label: "child", eventType: "DONE" } },
            },
          },
        },
      },
    });
    const snapshot = createActor(machine).start().getSnapshot();

    const meta = getStateMeta(snapshot);
    // parent-only field survives
    expect(meta.banner).toBe("parent");
    // deeper (child) state wins on the shared field
    expect(meta.interaction).toEqual({ label: "child", eventType: "DONE" });
  });

  test("recovers the meta type from the snapshot generic", () => {
    const machine = agent.createMachine({
      context: {},
      initial: "waiting",
      states: { waiting: { meta: { banner: "hi" } } },
    });
    const snapshot = createActor(machine).start().getSnapshot();

    const meta = getStateMeta(snapshot);
    // Type-level: `banner` is a `string | undefined`, not `unknown`.
    const banner: string | undefined = meta.banner;
    expect(banner).toBe("hi");
  });
});
