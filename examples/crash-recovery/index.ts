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
    // The topic is part of context, so it survives in the log's `@agent.init`
    // entry and is restored on an events-only resume.
    topic: z.string(),
    outline: z.string().nullable(),
    article: z.string().nullable(),
  }),
  input: z.object({ topic: z.string() }),
  output: z.object({ topic: z.string(), outline: z.string(), article: z.string() }),
});

export const crashRecoveryMachine = crashRecoverySetup.createMachine({
  context: ({ input }) => ({ topic: input.topic, outline: null, article: null }),
  initial: "outlining",
  states: {
    outlining: {
      invoke: {
        src: "agent.generateText",
        input: ({ context }) => ({
          model: "writer",
          prompt: `Outline a short article about ${context.topic}.`,
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
          prompt: `Write the article about ${context.topic} for this outline: ${context.outline}`,
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
        topic: context.topic,
        outline: context.outline ?? "",
        article: context.article ?? "",
      }),
    },
  },
});

/** First process: answers the outline call, hangs on the draft call, then "crashes". */
export async function runUntilCrash(topic = "state machines"): Promise<AgentLogEntry[]> {
  const persisted: AgentLogEntry[] = [];
  const abort = new AbortController();

  const generateText: AgentRequestExecutor = async (request) => {
    if (request.prompt?.startsWith("Write the article")) {
      // The draft call never resolves; the process dies while it is in flight.
      setTimeout(() => abort.abort(new Error("process crashed")), 10);
      return new Promise(() => {}) as never;
    }
    // Scripted, but topic-aware: the outline reflects the requested topic.
    return { output: `1. Intro to ${topic} 2. Body on ${topic} 3. Outro` };
  };

  const crashed = await runAgent(crashRecoveryMachine, {
    input: { topic },
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
    // The topic came back from the log's `@agent.init` input, so the recovered
    // draft is about the original topic, not a generic article.
    console.log(`topic: ${recovered.output.topic}`);
    console.log(`article: ${recovered.output.article}`);
  }
  return recovered;
}

const isMain = process.argv[1]?.endsWith("crash-recovery/index.ts");
if (isMain) {
  const log = await runUntilCrash();
  await recover(log);
}
