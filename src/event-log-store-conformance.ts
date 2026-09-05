/**
 * The runner-agnostic conformance suite for {@link AgentEventLogStore}
 * implementations. Split out of `event-log-store.ts` so the store contract and
 * the reference implementation stay readable.
 *
 * Every case throws a descriptive `Error` on the first violation, so any test
 * runner (or a plain script) can drive it against its own store. Pass a
 * `{ describe, it }` harness to register one test per case instead.
 * @module
 */
import { AgentEventLogConflictError, type AgentEventLogStore } from "./event-log-store.js";
import { AGENT_EVENT_SCHEMA_VERSION, type AgentLogEntry, type JsonValue } from "./event-log.js";

/** Produces a fresh, empty store for one case. */
type CreateStore = () => Promise<AgentEventLogStore> | AgentEventLogStore;

/**
 * A test runner's registration functions. `expect` is accepted and unused —
 * every case asserts by throwing, so the suite stays runner-agnostic.
 */
export interface EventLogStoreConformanceHarness {
  describe: (name: string, register: () => void) => void;
  it: (name: string, run: () => Promise<void>) => void;
  expect?: unknown;
}

function fail(message: string): never {
  throw new Error(`event-log-store conformance: ${message}`);
}

function entry(index: number, type: string, metadata?: Record<string, JsonValue>): AgentLogEntry {
  return {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    id: `evt_${index}`,
    index,
    recordedAt: "2026-01-01T00:00:00.000Z",
    machineId: "conformance",
    machineVersion: "v1",
    event: { type, seq: index },
    ...(metadata !== undefined ? { metadata } : {}),
  } as AgentLogEntry;
}

function entriesFrom(start: number, count: number): AgentLogEntry[] {
  return Array.from({ length: count }, (_unused, i) => entry(start + i, `e${start + i}`));
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    fail(`${message} (expected ${b}, got ${a})`);
  }
}

const cases: Array<{ name: string; run: (create: CreateStore) => Promise<void> }> = [
  {
    name: "an unknown thread reads empty and has length 0",
    async run(create) {
      const store = await create();
      assertJsonEqual(await store.read("missing"), [], "read of an unknown thread must be empty");
      if ((await store.length("missing")) !== 0) {
        fail("length of an unknown thread must be 0");
      }
    },
  },
  {
    name: "a single append reads back verbatim",
    async run(create) {
      const store = await create();
      const e = entry(0, "start", { label: "first" });
      await store.append({ threadId: "t", expectedIndex: 0, entries: [e] });
      assertJsonEqual(await store.read("t"), [e], "read must return the appended entry");
      if ((await store.length("t")) !== 1) {
        fail("length after a single append must be 1");
      }
    },
  },
  {
    name: "a second append extends the log in order",
    async run(create) {
      const store = await create();
      await store.append({ threadId: "t", expectedIndex: 0, entries: entriesFrom(0, 3) });
      await store.append({ threadId: "t", expectedIndex: 3, entries: entriesFrom(3, 2) });
      if ((await store.length("t")) !== 5) {
        fail("length after appending 3 then 2 entries must be 5");
      }
      assertJsonEqual(
        (await store.read("t")).map((e) => e.index),
        [0, 1, 2, 3, 4],
        "reads must return entries in contiguous log order",
      );
    },
  },
  {
    name: "a non-contiguous entry.index is misuse, not a race",
    async run(create) {
      const store = await create();
      let caught: unknown;
      try {
        // expectedIndex 0 but entry.index 1: a hole.
        await store.append({ threadId: "t", expectedIndex: 0, entries: [entry(1, "gap")] });
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof Error) || caught instanceof AgentEventLogConflictError) {
        fail("a non-contiguous entry.index must throw a plain Error, not a conflict");
      }
    },
  },
  {
    name: "a stale expectedIndex conflicts with correct fields",
    async run(create) {
      const store = await create();
      await store.append({ threadId: "t", expectedIndex: 0, entries: [entry(0, "a")] });
      let caught: unknown;
      try {
        // expectedIndex 0 is stale (length is 1); entry.index 0 clears the contiguity guard.
        await store.append({ threadId: "t", expectedIndex: 0, entries: [entry(0, "b")] });
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof AgentEventLogConflictError)) {
        fail("a stale expectedIndex must throw AgentEventLogConflictError");
      }
      if (caught.threadId !== "t" || caught.expectedIndex !== 0 || caught.actualIndex !== 1) {
        fail("conflict error must carry threadId, expectedIndex, and the actual index");
      }
    },
  },
  {
    name: "entry ids are unique within a thread",
    async run(create) {
      const store = await create();
      await store.append({ threadId: "t", expectedIndex: 0, entries: [entry(0, "a")] });
      let caught: unknown;
      try {
        await store.append({
          threadId: "t",
          expectedIndex: 1,
          entries: [{ ...entry(1, "b"), id: "evt_0" }],
        });
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof Error) || caught instanceof AgentEventLogConflictError) {
        fail("a duplicate event id within a thread must throw a plain Error");
      }
    },
  },
  {
    name: "concurrent appends at the same index have exactly one winner",
    async run(create) {
      const store = await create();
      await store.append({ threadId: "t", expectedIndex: 0, entries: [entry(0, "a")] });
      const results = await Promise.allSettled([
        store.append({ threadId: "t", expectedIndex: 1, entries: [entry(1, "w-a")] }),
        store.append({ threadId: "t", expectedIndex: 1, entries: [entry(1, "w-b")] }),
      ]);
      const winners = results.filter((r) => r.status === "fulfilled");
      const conflicts = results.filter(
        (r) => r.status === "rejected" && r.reason instanceof AgentEventLogConflictError,
      );
      if (winners.length !== 1) {
        fail(`exactly one racing append must win, got ${winners.length}`);
      }
      if (conflicts.length !== 1) {
        fail(`exactly one racing append must reject with a conflict, got ${conflicts.length}`);
      }
      if ((await store.length("t")) !== 2) {
        fail("after the race the log length must be 2");
      }
    },
  },
  {
    name: "read({ from }) is incrementally correct",
    async run(create) {
      const store = await create();
      await store.append({ threadId: "t", expectedIndex: 0, entries: entriesFrom(0, 5) });
      assertJsonEqual(
        (await store.read("t", { from: 2 })).map((e) => e.index),
        [2, 3, 4],
        "read({ from }) must skip entries below `from`",
      );
      assertJsonEqual(
        await store.read("t", { from: 5 }),
        [],
        "read({ from }) at the log length must be empty",
      );
    },
  },
  {
    name: "threads are isolated and grow independently",
    async run(create) {
      const store = await create();
      await store.append({ threadId: "a", expectedIndex: 0, entries: [entry(0, "x")] });
      if ((await store.length("b")) !== 0) {
        fail("an append to one thread must not create another");
      }
      await store.append({ threadId: "b", expectedIndex: 0, entries: entriesFrom(0, 2) });
      if ((await store.length("a")) !== 1 || (await store.length("b")) !== 2) {
        fail("threads must grow independently");
      }
    },
  },
  {
    name: "metadata round-trips verbatim",
    async run(create) {
      const store = await create();
      const metadata = { source: "user", nested: { attempt: 2 }, tags: ["x", "y"] };
      await store.append({ threadId: "t", expectedIndex: 0, entries: [entry(0, "e", metadata)] });
      assertJsonEqual(
        (await store.read("t"))[0]!.metadata,
        metadata,
        "metadata must round-trip verbatim",
      );
    },
  },
  {
    name: "stored entries are isolated from caller mutation",
    async run(create) {
      const store = await create();
      const e = entry(0, "e", { tags: ["a"] });
      await store.append({ threadId: "t", expectedIndex: 0, entries: [e] });
      (e.metadata!.tags as string[]).push("mutated-after-append");
      (e.event as { type: string; seq: number }).seq = 999;

      const read = await store.read("t");
      (read[0]!.metadata!.tags as string[]).push("mutated-after-read");
      (read[0]!.event as { type: string; seq: number }).seq = 888;

      const reread = await store.read("t");
      assertJsonEqual(
        reread[0]!.metadata,
        { tags: ["a"] },
        "stored entry must be isolated from post-append and post-read mutation",
      );
      assertJsonEqual(
        reread[0]!.event,
        { type: "e", seq: 0 },
        "stored event must be isolated from mutation of an appended or read copy",
      );
    },
  },
  {
    name: "fork copies a prefix and then diverges independently",
    async run(create) {
      const store = await create();
      await store.append({ threadId: "src", expectedIndex: 0, entries: entriesFrom(0, 3) });

      // Full prefix (default upToIndex).
      await store.fork({ threadId: "src", newThreadId: "fork-full" });
      if ((await store.length("fork-full")) !== 3) {
        fail("fork with the default upToIndex must copy the full log");
      }

      // Partial prefix.
      await store.fork({ threadId: "src", newThreadId: "fork-1", upToIndex: 1 });
      assertJsonEqual(
        (await store.read("fork-1")).map((e) => e.index),
        [0],
        "fork with upToIndex 1 must copy only entry 0",
      );

      // upToIndex is exclusive.
      await store.fork({ threadId: "src", newThreadId: "fork-2", upToIndex: 2 });
      assertJsonEqual(
        (await store.read("fork-2")).map((e) => e.id),
        ["evt_0", "evt_1"],
        "fork with upToIndex 2 must copy entries 0 and 1 only",
      );

      // The fork appends independently from its copied length; the source is untouched.
      await store.append({ threadId: "fork-1", expectedIndex: 1, entries: [entry(1, "branch")] });
      assertJsonEqual(
        (await store.read("fork-1")).map((e) => (e.event as { type: string }).type),
        ["e0", "branch"],
        "a forked thread must append independently from its copied length",
      );
      if ((await store.length("src")) !== 3) {
        fail("appending to a fork must not touch the source thread");
      }
    },
  },
  {
    name: "fork rejects a non-empty target, an unknown source, and an out-of-range cutoff",
    async run(create) {
      const store = await create();
      await store.append({ threadId: "src", expectedIndex: 0, entries: entriesFrom(0, 3) });
      await store.fork({ threadId: "src", newThreadId: "fork-full" });

      let caughtExisting: unknown;
      try {
        await store.fork({ threadId: "src", newThreadId: "fork-full" });
      } catch (error) {
        caughtExisting = error;
      }
      if (
        !(caughtExisting instanceof Error) ||
        caughtExisting instanceof AgentEventLogConflictError
      ) {
        fail("forking onto a non-empty thread must reject with a plain Error");
      }

      let caughtUnknown: unknown;
      try {
        await store.fork({ threadId: "nope", newThreadId: "fork-nope" });
      } catch (error) {
        caughtUnknown = error;
      }
      if (
        !(caughtUnknown instanceof Error) ||
        caughtUnknown instanceof AgentEventLogConflictError
      ) {
        fail("forking an unknown source thread must reject with a plain Error");
      }

      let caughtRange: unknown;
      try {
        await store.fork({ threadId: "src", newThreadId: "fork-range", upToIndex: 99 });
      } catch (error) {
        caughtRange = error;
      }
      if (!(caughtRange instanceof Error) || caughtRange instanceof AgentEventLogConflictError) {
        fail("forking past the source length must reject with a plain Error");
      }
    },
  },
];

/**
 * Validates a store against the reference's semantics: empty read + zero length
 * for unknown threads; single and multi-entry append; contiguity misuse guard;
 * stale-`expectedIndex` conflict with correct fields; an interleaved concurrent
 * append race (exactly one winner); entry-id uniqueness; `read({ from })`
 * incremental correctness; thread isolation; metadata round-trip; deep-copy
 * isolation on append and read; and the full fork contract.
 *
 * Without a `harness`, every case runs in sequence and the first violation
 * throws. With one, each case is registered as its own test:
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * assertEventLogStoreConformance(createMyStore, { describe, it });
 * ```
 */
export async function assertEventLogStoreConformance(
  create: CreateStore,
  harness?: EventLogStoreConformanceHarness,
): Promise<void> {
  if (harness) {
    harness.describe("AgentEventLogStore conformance", () => {
      for (const testCase of cases) {
        harness.it(testCase.name, () => testCase.run(create));
      }
    });
    return;
  }
  for (const testCase of cases) {
    await testCase.run(create);
  }
}
