import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor } from "xstate";
import { getStateMeta, persistSnapshot, setupAgent } from "./index.js";
import { findNonSerializableContextPaths } from "./utils.js";

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

describe("persistSnapshot", () => {
  test("returns a plain-JSON deep clone (equal value, not same reference)", () => {
    const snapshot = { value: "reviewing", context: { draft: { body: "hi" } } };
    const persisted = persistSnapshot(snapshot);

    expect(persisted).toEqual(snapshot);
    expect(persisted).not.toBe(snapshot);
    expect(persisted.context).not.toBe(snapshot.context);
  });

  test("drops non-JSON values exactly as JSON round-trip does", () => {
    const persisted = persistSnapshot({
      keep: 1,
      fn: () => 1,
      undef: undefined,
    });

    expect(persisted).toEqual({ keep: 1 });
  });
});

describe("findNonSerializableContextPaths", () => {
  test("returns [] for a fully JSON-safe context", () => {
    expect(
      findNonSerializableContextPaths({
        topic: "cats",
        count: 3,
        ok: true,
        nested: { list: [1, "two", { deep: null }] },
        empty: null,
      }),
    ).toEqual([]);
  });

  test("flags a Date value, naming its path", () => {
    const paths = findNonSerializableContextPaths({ createdAt: new Date() });
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^context\.createdAt \(Date\)$/);
  });

  test("flags Map, Set, function, undefined, bigint, and class instances", () => {
    class Widget {
      x = 1;
    }
    const paths = findNonSerializableContextPaths(
      {
        map: new Map(),
        set: new Set(),
        fn: () => 1,
        undef: undefined,
        big: 10n,
        inst: new Widget(),
      },
      10,
    );
    expect(paths).toEqual([
      "context.map (Map)",
      "context.set (Set)",
      "context.fn (function)",
      "context.undef (undefined)",
      "context.big (bigint)",
      "context.inst (Widget)",
    ]);
  });

  test("flags a value nested inside plain objects/arrays with a dotted path", () => {
    const paths = findNonSerializableContextPaths({ a: { b: [{ when: new Date() }] } });
    expect(paths).toEqual(["context.a.b[0].when (Date)"]);
  });

  test("flags a circular reference instead of recursing forever", () => {
    const obj: Record<string, unknown> = { self: null };
    obj.self = obj;
    const paths = findNonSerializableContextPaths(obj);
    expect(paths).toEqual(["context.self (circular)"]);
  });

  test("does not flag a shared (DAG) reference as circular", () => {
    const shared = { ok: true };
    const paths = findNonSerializableContextPaths({ a: shared, b: shared });
    expect(paths).toEqual([]);
  });
});
