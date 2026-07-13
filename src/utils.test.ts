import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor } from "xstate";
import {
  getJsonSchema,
  getJsonSchemaSync,
  getMachineStructuralHash,
  getStateMeta,
  persistSnapshot,
  setupAgent,
} from "./index.js";
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
