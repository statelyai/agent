/**
 * Session actor — a long-lived agent driven by external events, via
 * `createAgentActor` (runAgent's engine in session mode).
 *
 * A quiz host machine: it drafts a question, waits for the player's answer,
 * grades it, and repeats until the player quits. A one-shot `runAgent` would
 * settle idle at every wait and resume by snapshot; a session keeps ONE live
 * actor across turns:
 *
 * - `session.actor.send(event)` re-opens the cycle after an idle settle;
 * - `await session.settled()` resolves at the next quiescence;
 * - every turn appends to one replayable event log (`session.events`);
 * - `session.usage()` aggregates across all turns.
 *
 * No API key needed: executors are scripted. Run:
 * npx tsx examples/session-actor/index.ts
 */
import { z } from "zod";
import { createAgentActor, setupAgent } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";

// Typed interaction meta for the idle answer gate: the pause's `label`, a
// button `label`/`style` per accepted event, and `textEvent` naming the ONE
// event free-typed text is delivered to (here, the player's answer).
const metaSchema = z.object({
  interaction: z
    .object({
      label: z.string(),
      events: z
        .record(
          z.string(),
          z.object({
            label: z.string().optional(),
            style: z.enum(["primary", "danger", "default"]).optional(),
          }),
        )
        .optional(),
      textEvent: z.string().optional(),
    })
    .optional(),
});

const sessionQuizSetup = setupAgent({
  meta: metaSchema,
  context: z.object({
    question: z.string().nullable(),
    rounds: z.number(),
    correct: z.number(),
  }),
  input: z.object({}),
  output: z.object({ rounds: z.number(), correct: z.number() }),
  events: {
    ANSWER: z.object({ text: z.string() }),
    QUIT: {},
  },
  // Deterministic idle detection: settle exactly when the machine is waiting.
  isSuspended: (snapshot) => snapshot.hasTag("waiting"),
});

export const sessionQuizMachine = sessionQuizSetup.createMachine({
  context: () => ({ question: null, rounds: 0, correct: 0 }),
  initial: "asking",
  states: {
    asking: {
      invoke: {
        src: "agent.generateText",
        input: () => ({ model: "host", prompt: "Ask one trivia question." }),
        onDone: ({ event }) => ({
          target: "waitingForAnswer",
          context: { question: String(event.output) },
        }),
      },
    },
    waitingForAnswer: {
      tags: ["waiting"],
      meta: {
        interaction: {
          // `{question}` resolves against context when the label is shown.
          label: "{question}",
          events: {
            ANSWER: { label: "Submit answer", style: "primary" },
            QUIT: { label: "End the quiz" },
          },
          // Whatever the player types is their answer.
          textEvent: "ANSWER",
        },
      },
      on: {
        ANSWER: ({ context, event }) => ({
          target: "grading",
          context: {
            rounds: context.rounds + 1,
            // Scripted grading keeps the example key-free; a real host would
            // grade with a request here.
            correct: context.correct + (event.text.length > 3 ? 1 : 0),
          },
        }),
        QUIT: { target: "done" },
      },
    },
    grading: {
      always: { target: "asking" },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ rounds: context.rounds, correct: context.correct }),
    },
  },
});

export async function runSession() {
  const generateText: AgentRequestExecutor = async () => ({
    output: "What state does an XState machine start in?",
    usage: { totalTokens: 12 },
  });

  const session = createAgentActor(sessionQuizMachine, {
    input: {},
    executors: { generateText },
  });

  // Turn 1: the machine asks and settles idle waiting for the player.
  let result = await session.settled();
  console.log(`settled: ${result.status}`); // idle

  // Turn 2: the player answers on the SAME live actor — no snapshot restore.
  session.actor.send({ type: "ANSWER", text: "the initial state" });
  result = await session.settled();
  console.log(`settled: ${result.status}`); // idle again (next question)

  // Turn 3: the player quits; the session finalizes.
  session.actor.send({ type: "QUIT" });
  result = await session.settled();
  console.log(`settled: ${result.status}`); // done
  if (result.status === "done") {
    console.log(`rounds: ${result.output.rounds}, correct: ${result.output.correct}`);
  }

  // One replayable log spans every turn; usage aggregates across the session.
  console.log(`log entries: ${session.events.length}`);
  console.log(`model calls: ${session.usage().modelCalls}`);
  return { session, result };
}

const isMain = process.argv[1]?.endsWith("session-actor/index.ts");
if (isMain) {
  await runSession();
}
