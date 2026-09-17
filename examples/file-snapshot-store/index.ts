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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActor, waitFor, type AnyStateMachine, type Snapshot } from "xstate";
import {
  getStatePath,
  provideExecutors,
  runAgent,
  type AgentRequestExecutors,
  type RunAgentOptions,
} from "@statelyai/agent";
import { portableLoopMachine } from "../portable-xstate-loop/index.js";

// The machine this example persists and resumes. Re-exported so the library
// can render its statechart beside the run, rather than reporting that this
// example has no machine to inspect.
export { portableLoopMachine };

/**
 * The seams a host threads through every leg of a multi-run example: its
 * executors, its cancellation signal, and the observers that make one story
 * out of several `runAgent` calls. Declared here, not imported, so the example
 * stays a single self-contained file (see CONTRIBUTING).
 */
type ExampleRunOptions = Pick<
  RunAgentOptions<AnyStateMachine>,
  "executors" | "signal" | "onTransition" | "on" | "onTrace" | "inspect"
>;

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
  observers: Omit<ExampleRunOptions, "executors"> = {},
): Promise<{ draft: string }> {
  const runId = "release-42";

  // Request/process one: run until the machine waits for approval.
  const paused = await runAgent(portableLoopMachine, {
    ...(observers as object),
    input: { topic: "framework-owned storage" },
    executors,
  });
  if (paused.status !== "idle") throw new Error(`Expected idle, got '${paused.status}'.`);
  await saveSnapshot(directory, runId, paused.persist());

  // Request/process two: load the native snapshot and deliver a normal event.
  const snapshot = await loadSnapshot(directory, runId);
  if (!snapshot) throw new Error(`No snapshot stored for '${runId}'.`);
  const resumed = await runAgent(portableLoopMachine, {
    ...(observers as object),
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
  observers: Omit<ExampleRunOptions, "executors"> = {},
): Promise<{ draft: string; states: string[] }> {
  const states: string[] = [];
  const actor = createActor(provideExecutors(portableLoopMachine, executors), {
    input: { topic },
    ...(observers.inspect ? { inspect: observers.inspect } : {}),
  });
  actor.subscribe((snapshot) => states.push(getStatePath(snapshot)));
  // Cancellation is the application's job here too: `runAgent` would wire the
  // signal up itself, but this half owns the actor, so stopping it is what a
  // cancelled request means. A stopped actor settles its `waitFor`s.
  const stop = () => actor.stop();
  observers.signal?.addEventListener("abort", stop, { once: true });
  actor.start();

  try {
    await waitFor(actor, (snapshot) => snapshot.matches("reviewing"));
    actor.send({ type: "APPROVE" });
    const done = await waitFor(actor, (snapshot) => snapshot.status === "done");
    actor.stop();

    if (!done.output) {
      throw new Error("The completed actor did not produce an output.");
    }

    return { draft: done.output.draft, states };
  } finally {
    observers.signal?.removeEventListener("abort", stop);
    actor.stop();
  }
}

/**
 * Both halves in one call: a run persisted to disk and resumed in what stands
 * in for a second process, then the same run kept alive in one actor with
 * nothing persisted. Neither half is a single machine a host can drive, so the
 * example exports this — see {@link ExampleRunOptions}.
 */
export async function runFileSnapshotStoreDemo(options: ExampleRunOptions = {}) {
  const { executors, ...observers } = options;
  // Routed on `request.name` so a stand-in fails loudly if the machine grows
  // a second request; a host with real executors passes its own instead.
  const stand_in: AgentRequestExecutors = {
    generateText: async (request) => {
      if (request.name !== "draft") throw new Error(`unexpected request: ${request.name}`);
      return { output: "Drafted without a model — this half is about storage." };
    },
  };
  const directory = mkdtempSync(join(tmpdir(), "stately-agent-snapshots-"));
  try {
    const stored = await runFileSnapshotStoreExample(directory, executors ?? stand_in, observers);
    const live = await runLongLivedActor(
      "application-owned actors",
      executors ?? stand_in,
      observers,
    );
    return {
      storageOwnedByTheApplication: stored.draft,
      lifetimeOwnedByTheApplication: live.draft,
      statesSeenByTheApplication: live.states,
      snapshotDirectory: `${directory} (removed after the run)`,
    };
  } finally {
    // The snapshot has already been written, read back and resumed from by the
    // time this runs — the directory was scratch space, not output. A host
    // calls this on every click, so leaving them behind accumulates.
    await rm(directory, { recursive: true, force: true });
  }
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
