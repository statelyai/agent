/**
 * Framework-owned snapshot persistence.
 *
 * The store is ordinary application code: one JSON file per run. Stately
 * Agent supplies no storage adapter. Each request loads or saves XState's
 * native persisted snapshot and can run in a fresh process.
 *
 * Run: npx tsx examples/file-snapshot-store/index.ts
 */
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "xstate";
import { runAgent, type AgentRequestExecutors } from "@statelyai/agent";
import { portableLoopMachine } from "../portable-xstate-loop/index.js";

/** Ordinary application I/O; use the equivalent APIs from your framework. */
export async function saveSnapshot(
  directory: string,
  id: string,
  snapshot: Snapshot<unknown>,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.json`), JSON.stringify(snapshot), "utf8");
}

export async function loadSnapshot(
  directory: string,
  id: string,
): Promise<Snapshot<unknown> | undefined> {
  const path = join(directory, `${id}.json`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as Snapshot<unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function runFileSnapshotStoreExample(
  directory: string,
  executors: AgentRequestExecutors,
): Promise<{ draft: string }> {
  const runId = "release-42";

  // Request/process one: run until the machine waits for approval.
  const paused = await runAgent(portableLoopMachine, {
    input: { topic: "framework-owned storage" },
    executors,
  });
  if (paused.status !== "idle") throw new Error(`Expected idle, got '${paused.status}'.`);
  await saveSnapshot(directory, runId, paused.persist());

  // Request/process two: load the native snapshot and deliver a normal event.
  const snapshot = await loadSnapshot(directory, runId);
  if (!snapshot) throw new Error(`No snapshot stored for '${runId}'.`);
  const resumed = await runAgent(portableLoopMachine, {
    snapshot,
    event: { type: "APPROVE" },
    executors,
  });
  if (resumed.status !== "done") throw new Error(`Expected done, got '${resumed.status}'.`);
  return resumed.output;
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  const directory = mkdtempSync(join(tmpdir(), "stately-agent-snapshots-"));
  const output = await runFileSnapshotStoreExample(directory, {
    generateText: async () => ({ output: "Stored the framework way." }),
  });
  console.log({ directory, output });
}
