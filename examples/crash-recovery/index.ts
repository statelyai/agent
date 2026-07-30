/**
 * Crash recovery — resume a run from its event log alone (events-only resume).
 *
 * The host persists every `AgentLogEntry` as it is produced (`onEvent` here;
 * an event-log store in production). The process then "crashes" mid-request:
 * the second model call is in flight when the run aborts, so its result was
 * never recorded. Recovery is one call — `runAgent(machine, { events })` with
 * NO snapshot:
 *
 * - recorded results are replayed, never re-executed (call one runs once);
 * - the request that was in flight when the log ended restarts idempotently
 *   (XState v6 re-enters restored pending invokes);
 * - the run continues to done on the same, still-replayable log.
 *
 * No API key needed: executors are scripted. Run:
 * npx tsx examples/crash-recovery/index.ts
 */
import { z } from "zod";
import { runAgent, setupAgent } from "@statelyai/agent";
import type { AgentLogEntry, AgentRequestExecutor } from "@statelyai/agent";

const crashRecoverySetup = setupAgent({
  context: z.object({
    outline: z.string().nullable(),
    article: z.string().nullable(),
  }),
  input: z.object({ topic: z.string() }),
  output: z.object({ outline: z.string(), article: z.string() }),
});

export const crashRecoveryMachine = crashRecoverySetup.createMachine({
  context: () => ({ outline: null, article: null }),
  initial: "outlining",
  states: {
    outlining: {
      invoke: {
        src: "agent.generateText",
        input: ({ context: _context }) => ({
          model: "writer",
          prompt: "Outline a short article.",
        }),
        onDone: ({ event }) => ({
          target: "drafting",
          context: { outline: String(event.output) },
        }),
      },
    },
    drafting: {
      invoke: {
        src: "agent.generateText",
        input: ({ context }) => ({
          model: "writer",
          prompt: `Write the article for this outline: ${context.outline}`,
        }),
        onDone: ({ event }) => ({
          target: "done",
          context: { article: String(event.output) },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        outline: context.outline ?? "",
        article: context.article ?? "",
      }),
    },
  },
});

/** First process: answers the outline call, hangs on the draft call, then "crashes". */
export async function runUntilCrash(): Promise<AgentLogEntry[]> {
  const persisted: AgentLogEntry[] = [];
  const abort = new AbortController();

  const generateText: AgentRequestExecutor = async (request) => {
    if (request.prompt?.startsWith("Write the article")) {
      // The draft call never resolves; the process dies while it is in flight.
      setTimeout(() => abort.abort(new Error("process crashed")), 10);
      return new Promise(() => {}) as never;
    }
    return { output: "1. Intro 2. Body 3. Outro" };
  };

  const crashed = await runAgent(crashRecoveryMachine, {
    input: { topic: "state machines" },
    executors: { generateText },
    onEvent: (entry) => persisted.push(entry), // the durable log
    signal: abort.signal,
  });

  console.log(`crashed with status '${crashed.status}' after logging:`);
  for (const entry of persisted) {
    console.log(`  [${entry.index}] ${entry.event.type}`);
  }
  return persisted;
}

/** Second process: recover from the persisted log alone. */
export async function recover(persisted: AgentLogEntry[]) {
  const calls: string[] = [];
  const generateText: AgentRequestExecutor = async (request) => {
    calls.push(request.prompt ?? "");
    return { output: `Draft based on: ${request.prompt}` };
  };

  const recovered = await runAgent(crashRecoveryMachine, {
    // Events-only resume: no snapshot. Recorded results replay; the in-flight
    // draft request re-executes.
    events: persisted,
    executors: { generateText },
  });

  console.log(`recovered with status '${recovered.status}'`);
  console.log(`model calls made during recovery: ${calls.length}`); // 1 — only the draft
  if (recovered.status === "done") {
    console.log(`article: ${recovered.output.article}`);
  }
  return recovered;
}

const isMain = process.argv[1]?.endsWith("crash-recovery/index.ts");
if (isMain) {
  const log = await runUntilCrash();
  await recover(log);
}
