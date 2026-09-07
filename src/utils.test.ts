import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createActor } from "xstate";
import { getStateMeta, getStatePath, setupAgent } from "./index.js";
import type { DoneActorEventOf } from "./index.js";
import { getJsonSchema, getJsonSchemaSync, getMachineStructuralHash } from "./index.js";
import { findNonSerializableContextPaths } from "./utils.js";
import type { StandardSchemaV1 } from "./types.js";

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

  test("equal-depth parallel siblings merge by state id (later id wins)", () => {
    const machine = agent.createMachine({
      context: {},
      type: "parallel",
      states: {
        // Declared in reverse alphabetical order on purpose: the merge order is
        // by state id, not by declaration order.
        zeta: { meta: { banner: "zeta" } },
        alpha: { meta: { banner: "alpha" } },
      },
    });
    const snapshot = createActor(machine).start().getSnapshot();

    // Both regions are at the same depth, so the later id alphabetically wins.
    expect(getStateMeta(snapshot).banner).toBe("zeta");
  });

  test("a deeper state with a custom id still wins over its ancestor", () => {
    const machine = agent.createMachine({
      context: {},
      initial: "parent",
      states: {
        parent: {
          meta: { interaction: { label: "parent", eventType: "GO" } },
          initial: "child",
          states: {
            child: {
              // A custom id has no dots, so id-string depth would misrank it.
              id: "review",
              meta: { interaction: { label: "child", eventType: "DONE" } },
            },
          },
        },
      },
    });
    const snapshot = createActor(machine).start().getSnapshot();

    expect(getStateMeta(snapshot).interaction).toEqual({
      label: "child",
      eventType: "DONE",
    });
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

describe("getMachineStructuralHash", () => {
  const build = (opts: { extraState?: boolean; prompt?: string; target?: string }) => {
    const agent = setupAgent({
      context: z.object({ n: z.number() }),
      events: { GO: z.object({}) },
    });
    // A function value (prompt-like) that must not affect the hash.
    const entry = () => console.log(opts.prompt ?? "default");
    const target = opts.target ?? "b";
    if (opts.extraState) {
      return agent.createMachine({
        id: "h",
        context: () => ({ n: 0 }),
        entry,
        initial: "a",
        states: {
          a: { on: { GO: { target } } },
          b: { type: "final" },
          alt: { type: "final" },
          c: {},
        },
      });
    }
    return agent.createMachine({
      id: "h",
      context: () => ({ n: 0 }),
      entry,
      initial: "a",
      states: {
        a: { on: { GO: { target } } },
        b: { type: "final" },
        alt: { type: "final" },
      },
    });
  };

  test("is stable and hex", () => {
    const hash = getMachineStructuralHash(build({}));
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(getMachineStructuralHash(build({}))).toBe(hash);
  });

  test("ignores function-valued config (prompts/actions)", () => {
    expect(getMachineStructuralHash(build({ prompt: "one" }))).toBe(
      getMachineStructuralHash(build({ prompt: "two" })),
    );
  });

  test("changes when a state is added or a transition retargeted", () => {
    const base = getMachineStructuralHash(build({}));
    expect(getMachineStructuralHash(build({ extraState: true }))).not.toBe(base);
    expect(getMachineStructuralHash(build({ target: "alt" }))).not.toBe(base);
  });
});

describe("getJsonSchema / getJsonSchemaSync", () => {
  test("reads the ~standard.jsonSchema extension (sync producer)", async () => {
    const schema = z.object({ a: z.number() });
    expect(getJsonSchemaSync(schema)).toMatchObject({ type: "object" });
    await expect(getJsonSchema(schema)).resolves.toMatchObject({ type: "object" });
  });

  test("returns undefined when the schema exposes no jsonSchema extension", async () => {
    const bare: StandardSchemaV1<number> = {
      "~standard": { version: 1, vendor: "x", validate: (value) => ({ value: value as number }) },
    };
    expect(getJsonSchemaSync(bare)).toBeUndefined();
    await expect(getJsonSchema(bare)).resolves.toBeUndefined();
    expect(getJsonSchemaSync(undefined)).toBeUndefined();
  });

  test("getJsonSchemaSync treats an async producer as absent; getJsonSchema awaits it", async () => {
    const asyncSchema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "x",
        validate: (value) => ({ value }),
        jsonSchema: { input: () => Promise.resolve({ type: "object", async: true }) },
      },
    };
    expect(getJsonSchemaSync(asyncSchema)).toBeUndefined();
    await expect(getJsonSchema(asyncSchema)).resolves.toMatchObject({ async: true });
  });
});

describe("getStatePath", () => {
  test("renders atomic, nested, and parallel state values", () => {
    expect(getStatePath("writing")).toBe("writing");
    expect(getStatePath({ review: { editing: "draft" } })).toBe("review.editing.draft");
    expect(getStatePath({ p: { left: "x", right: { a: "b" } } })).toBe("p:{left.x,right.a.b}");
  });

  test("is deterministic regardless of region key order", () => {
    expect(getStatePath({ p: { b: "two", a: "one" } })).toBe(
      getStatePath({ p: { a: "one", b: "two" } }),
    );
    expect(getStatePath({ p: { b: "two", a: "one" } })).toBe("p:{a.one,b.two}");
  });

  test("does not mistake a state named `value` for a snapshot", () => {
    expect(getStatePath({ value: "ready" })).toBe("value.ready");
    expect(getStatePath({ value: "ready", status: "active" })).toBe("ready");
  });

  test("accepts a snapshot as well as a raw state value", () => {
    const pathMachine = agent.createMachine({
      context: {},
      initial: "review",
      states: { review: { initial: "editing", states: { editing: {} } } },
    });
    const snapshot = createActor(pathMachine).getSnapshot();
    expect(getStatePath(snapshot)).toBe("review.editing");
    expect(getStatePath(snapshot)).toBe(getStatePath(snapshot.value));
  });
});

describe("DoneActorEventOf", () => {
  const researchLogic = setupAgent({
    context: z.object({}),
    output: z.object({ finding: z.string() }),
  }).createMachine({
    context: {},
    initial: "done",
    states: { done: { type: "final", output: () => ({ finding: "otters hold hands" }) } },
  });

  test("types a wildcard xstate.done.actor handler without a cast", () => {
    const event = {
      type: "xstate.done.actor",
      actorId: "research-0",
      sessionId: "x:0",
      output: { finding: "otters hold hands" },
    } as DoneActorEventOf<typeof researchLogic>;

    expectTypeOf(event.output).toEqualTypeOf<{ finding: string }>();
    expectTypeOf(event.actorId).toEqualTypeOf<string>();
    expectTypeOf<
      DoneActorEventOf<typeof researchLogic, "research-0">["actorId"]
    >().toEqualTypeOf<"research-0">();
    expect(event.output.finding).toBe("otters hold hands");
  });
});
