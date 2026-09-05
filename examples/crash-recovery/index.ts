/**
 * Crash recovery — resume a run from XState's persisted snapshot.
 *
 * The process "crashes" mid-request:
 * the second model call is in flight when the run aborts, so its result was
 * never completed. The host stores `result.persist()`, then recovery is one
 * `runAgent(machine, { snapshot })` call:
 *
 * - completed state is restored (call one runs once);
 * - XState v6 re-enters the request that was in flight at the crash; the host
 *   executor must supply any required idempotency key and retry policy because
 *   the provider may have accepted the original request;
 * - the run continues to done.
 *
 * No API key needed: executors are scripted. Run:
 * npx tsx examples/crash-recovery/index.ts
 */
import { z } from "zod";
import type { Snapshot } from "xstate";
import { runAgent, setupAgent } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";

const crashRecoverySetup = setupAgent({
  context: z.object({
    // The topic is part of context, so it survives snapshot persistence.
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
export async function runUntilCrash(topic = "state machines"): Promise<Snapshot<unknown>> {
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
    signal: abort.signal,
  });

  console.log(`crashed with status '${crashed.status}'`);
  return crashed.persist();
}

/** Second process: recover from XState's persisted snapshot. */
export async function recover(persisted: Snapshot<unknown>) {
  const calls: string[] = [];
  const generateText: AgentRequestExecutor = async (request) => {
    calls.push(request.prompt ?? "");
    return { output: `Draft based on: ${request.prompt}` };
  };

  const recovered = await runAgent(crashRecoveryMachine, {
    snapshot: persisted,
    executors: { generateText },
  });

  console.log(`recovered with status '${recovered.status}'`);
  console.log(`model calls made during recovery: ${calls.length}`); // 1 — only the draft
  if (recovered.status === "done") {
    // The topic came back from context, so the recovered draft is specific.
    console.log(`topic: ${recovered.output.topic}`);
    console.log(`article: ${recovered.output.article}`);
  }
  return recovered;
}

const isMain = process.argv[1]?.endsWith("crash-recovery/index.ts");
if (isMain) {
  const snapshot = await runUntilCrash();
  await recover(snapshot);
}
