/**
 * Durable checkpoints in a file-backed snapshot store.
 *
 * Each idle settle writes the snapshot to a JSON file keyed by session id.
 * A fresh `runAgent` call — a stand-in for a new process after a crash or
 * redeploy — loads it back and resumes. The snapshot is the entire process
 * state, so nothing else needs to be threaded between turns.
 *
 * The store here is `node:fs` writing JSON files under the OS temp dir. Swap
 * `save`/`load` for a `better-sqlite3` table to get the same shape backed by
 * SQLite:
 *
 *   // CREATE TABLE snapshots (session_id TEXT PRIMARY KEY, snapshot TEXT);
 *   save: (id, snap) => db.prepare(
 *     'INSERT OR REPLACE INTO snapshots VALUES (?, ?)'
 *   ).run(id, JSON.stringify(snap));
 *   load: (id) => JSON.parse(
 *     db.prepare('SELECT snapshot FROM snapshots WHERE session_id = ?').get(id).snapshot
 *   );
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/file-snapshot-store/index.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { runAgent, setupAgent } from "../../src/index.js";
import { createAiSdkExecutors } from "../../src/ai-sdk/index.js";
import { runExampleMain } from "../helpers/main.js";
import type { Snapshot } from "xstate";

const draftContextSchema = z.object({ topic: z.string(), draft: z.string().nullable() });

const agentSetup = setupAgent({
  context: draftContextSchema,
  input: z.object({ topic: z.string() }),
  output: z.object({ draft: z.string() }),
  events: {
    APPROVE: z.object({}),
    REJECT: z.object({ reason: z.string() }),
  },
  requests: {
    writeDraft: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      system:
        "You draft short, concrete announcement copy. Two or three sentences. " +
        'If the topic includes a "Revision:" note, apply it. Return only the draft text.',
      prompt: ({ input }) => input.topic,
    },
  },
  // drafting's onDone sets `draft` before every path into "reviewing" (a
  // REJECT loops back through drafting, which re-sets it) — narrow it
  // non-null from "reviewing" onward.
  states: {
    drafting: {},
    reviewing: {
      schemas: { context: draftContextSchema.extend({ draft: z.string() }) },
    },
    published: {
      schemas: { context: draftContextSchema.extend({ draft: z.string() }) },
    },
  },
});

// drafting → reviewing (idle HITL) → published, with a REJECT loop back to
// drafting. Each REJECT is one idle/resume cycle through the store.
export const draftMachine = agentSetup.createMachine({
  id: "file-snapshot-drafter",
  context: ({ input }) => ({ topic: input.topic, draft: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "reviewing", context: { draft: output } }),
      },
    },
    reviewing: {
      on: {
        APPROVE: { target: "published" },
        REJECT: ({ context, event }) => ({
          target: "drafting",
          context: { topic: `${context.topic}\nRevision: ${event.reason}` },
        }),
      },
    },
    published: {
      type: "final",
      output: ({ context }) => ({ draft: context.draft }),
    },
  },
});

// ─── File-backed snapshot store ───
//
// One JSON file per session id. `save` on every idle settle; `load` when a
// fresh process resumes. See the SQLite sketch in the header comment.
export interface SnapshotStore {
  save(sessionId: string, snapshot: Snapshot<unknown>): void;
  load(sessionId: string): Snapshot<unknown>;
}

export function createFileSnapshotStore(dir: string): SnapshotStore {
  const pathFor = (sessionId: string) => join(dir, `${sessionId}.json`);
  return {
    save(sessionId, snapshot) {
      writeFileSync(pathFor(sessionId), JSON.stringify(snapshot), "utf8");
    },
    load(sessionId) {
      return JSON.parse(readFileSync(pathFor(sessionId), "utf8")) as Snapshot<unknown>;
    },
  };
}

const generateText = async ({ prompt }: { prompt?: string }) => ({
  output: `Draft: ${prompt ?? ""}`,
});

export async function runFileSnapshotStoreExample() {
  const store = createFileSnapshotStore(mkdtempSync(join(tmpdir(), "agent-snap-")));
  const sessionId = "refund-123";

  // ── Process 1: run to the first idle, checkpoint to disk. ──
  const first = await runAgent(draftMachine, {
    input: { topic: "release notes" },
    generateText,
  });
  assert.equal(first.status, "idle");
  store.save(sessionId, first.snapshot);

  // ── Process 2 (fresh runAgent): load, reject once, checkpoint again. ──
  const second = await runAgent(draftMachine, {
    snapshot: store.load(sessionId),
    event: { type: "REJECT", reason: "too terse" },
    generateText,
  });
  // REJECT loops back through drafting to reviewing → idle again.
  assert.equal(second.status, "idle");
  store.save(sessionId, second.snapshot);

  // ── Process 3 (fresh runAgent): load, approve, run to done. ──
  const third = await runAgent(draftMachine, {
    snapshot: store.load(sessionId),
    event: { type: "APPROVE" },
    generateText,
  });
  assert.equal(third.status, "done");
  assert.deepEqual(third.status === "done" ? third.output : undefined, {
    draft: "Draft: release notes\nRevision: too terse",
  });
}

// Direct run: the same idle → persist-to-disk → fresh-process resume dance,
// but with a real model writing the draft and a real snapshot file on disk.
export async function main() {
  const { generateText } = createAiSdkExecutors({
    models: { writer: openai("gpt-5.4-mini") },
  });
  const dir = mkdtempSync(join(tmpdir(), "agent-snap-"));
  const store = createFileSnapshotStore(dir);
  const sessionId = "release-123";
  const snapshotPath = join(dir, `${sessionId}.json`);

  // Process 1: draft, settle idle at review, checkpoint to disk.
  const first = await runAgent(draftMachine, {
    input: { topic: "Launch of our new snapshot store" },
    generateText,
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });
  assert.equal(first.status, "idle");
  store.save(sessionId, first.snapshot);
  console.log(`Draft checkpointed to ${snapshotPath}`);
  console.log(`Draft: ${first.snapshot.context.draft}\n`);

  // Process 2 (fresh runAgent): load, request a revision, checkpoint again.
  const second = await runAgent(draftMachine, {
    snapshot: store.load(sessionId),
    event: { type: "REJECT", reason: "make it punchier" },
    generateText,
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });
  assert.equal(second.status, "idle");
  store.save(sessionId, second.snapshot);
  console.log(`Revised draft: ${second.snapshot.context.draft}\n`);

  // Process 3 (fresh runAgent): load, approve, run to done.
  const third = await runAgent(draftMachine, {
    snapshot: store.load(sessionId),
    event: { type: "APPROVE" },
    generateText,
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });
  if (third.status !== "done") {
    throw new Error(`Draft did not publish: ${third.status}`);
  }
  console.log("Published:", third.output.draft);
}

runExampleMain(import.meta.url, main);
