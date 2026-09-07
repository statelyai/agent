/**
 * Application-owned lifetime vs application-owned storage.
 *
 * Both halves below drive the SAME machine (`portable-xstate-loop`) to the same
 * result, and differ only in what the application chooses to own:
 *
 *   1. Storage. `runFileSnapshotStoreExample` runs the machine to its idle
 *      review pause, writes the native XState snapshot to a JSON file, and
 *      resumes from that file. Nothing in memory survives between the two
 *      steps — they could be separate requests or separate processes.
 *   2. Lifetime. `runLongLivedActor` keeps one `createActor` alive across the
 *      model draft and the APPROVE event, watching it through the
 *      application's own subscription. Nothing is ever persisted; everything
 *      lives in memory and dies with the process.
 *
 * That contrast is the teaching point: Stately Agent supplies no storage
 * adapter and no actor supervisor. The store here is ordinary application I/O
 * and the actor is ordinary XState, so you can pick either end of the axis (or
 * both) with the APIs your framework already has.
 *
 * Run: npx tsx examples/file-snapshot-store/index.ts
 */
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActor, waitFor, type Snapshot } from "xstate";
import {
  getStatePath,
  provideExecutors,
  runAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";
import { portableLoopMachine } from "../portable-xstate-loop/index.js";

// --- 1. Application-owned storage -------------------------------------------

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

// --- 2. Application-owned lifetime ------------------------------------------

/**
 * The same run with no persistence at all: `provideExecutors` binds the model
 * executors once, then actor lifetime, subscriptions, and external events are
 * plain XState. The returned `states` come from the application's own
 * subscription, not from anything the library records.
 */
export async function runLongLivedActor(
  topic: string,
  executors: AgentRequestExecutors,
): Promise<{ draft: string; states: string[] }> {
  const states: string[] = [];
  const actor = createActor(provideExecutors(portableLoopMachine, executors), {
    input: { topic },
  });
  actor.subscribe((snapshot) => states.push(getStatePath(snapshot)));
  actor.start();

  await waitFor(actor, (snapshot) => snapshot.matches("reviewing"));
  actor.send({ type: "APPROVE" });
  const done = await waitFor(actor, (snapshot) => snapshot.status === "done");
  actor.stop();

  if (!done.output) {
    throw new Error("The completed actor did not produce an output.");
  }

  return { draft: done.output.draft, states };
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  // Routed on `request.name` — the `setupAgent({ requests })` key — so each
  // stand-in fails loudly if the machine grows a second request.
  const stored = await runFileSnapshotStoreExample(
    mkdtempSync(join(tmpdir(), "stately-agent-snapshots-")),
    {
      generateText: async (request) => {
        if (request.name !== "draft") throw new Error(`unexpected request: ${request.name}`);
        return { output: "Stored the framework way." };
      },
    },
  );
  console.log("Storage owned by the application (resumed from JSON):", stored);

  const live = await runLongLivedActor("application-owned actors", {
    generateText: async (request) => {
      if (request.name !== "draft") throw new Error(`unexpected request: ${request.name}`);
      return { output: "The application owns this actor." };
    },
  });
  console.log("Lifetime owned by the application (never persisted):", live);
}
