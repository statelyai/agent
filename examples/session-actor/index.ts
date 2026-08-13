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
import type { SnapshotFrom } from "xstate";
import { createAgentActor, getStateMeta, setupAgent } from "@statelyai/agent";
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

const gradeSchema = z.object({
  correct: z.boolean(),
  /** The answer the question was looking for, shown back to the player. */
  expected: z.string(),
  explanation: z.string(),
});

const sessionQuizSetup = setupAgent({
  meta: metaSchema,
  context: z.object({
    question: z.string().nullable(),
    /** The answer being graded right now. */
    pendingAnswer: z.string(),
    /** Verdict on the previous answer, rendered above the next question. */
    lastGrade: z.string(),
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
  isIdle: (snapshot) => snapshot.hasTag("waiting"),
  requests: {
    gradeAnswer: {
      schemas: {
        input: z.object({ question: z.string(), answer: z.string() }),
        output: gradeSchema,
      },
      model: "host",
      system:
        "Grade a trivia answer. Return correct=true only if the answer is right in " +
        "substance, `expected` as the answer that was being looked for, and a one-line " +
        "explanation.",
      prompt: ({ input }) => `Question: ${input.question}\nAnswer: ${input.answer}`,
    },
  },
});

/** The one-line verdict a host shows before the next question. */
function renderGrade(question: string, grade: z.infer<typeof gradeSchema>): string {
  return [
    `${grade.correct ? "Correct" : "Incorrect"} — the answer to "${question}" is ${grade.expected}.`,
    grade.explanation,
  ].join(" ");
}

export const sessionQuizMachine = sessionQuizSetup.createMachine({
  context: () => ({ question: null, pendingAnswer: "", lastGrade: "", rounds: 0, correct: 0 }),
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
          // `{question}` resolves against context when the label is shown, and
          // `{lastGrade}` puts the verdict on the previous answer above it.
          label: "{lastGrade}\n\n{question}",
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
          context: { rounds: context.rounds + 1, pendingAnswer: event.text },
        }),
        QUIT: { target: "done" },
      },
    },
    // The answer is graded before the next question is drafted, so the player
    // always sees a verdict — not a silent jump to the next round.
    grading: {
      invoke: {
        src: "gradeAnswer",
        input: ({ context }) => ({
          question: context.question ?? "",
          answer: context.pendingAnswer,
        }),
        onDone: ({ context, output }) => ({
          target: "asking",
          context: {
            correct: context.correct + (output.correct ? 1 : 0),
            lastGrade: renderGrade(context.question ?? "", output),
            pendingAnswer: "",
          },
        }),
        onError: { target: "asking", context: { lastGrade: "", pendingAnswer: "" } },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ rounds: context.rounds, correct: context.correct }),
    },
  },
});

type QuizSnapshot = SnapshotFrom<typeof sessionQuizMachine>;

/**
 * What a host shows at an idle settle: the state's `meta.interaction.label`
 * with `{key}` placeholders resolved against context.
 */
export function idleLabel(snapshot: QuizSnapshot): string {
  const label = getStateMeta(snapshot).interaction?.label ?? "";
  return label
    .replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = (snapshot.context as Record<string, unknown>)[key];
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    })
    .trim();
}

export async function runSession() {
  // One scripted executor serves both requests; a real host would point them at
  // a model. Grading is keyed off the request's system prompt.
  const generateText: AgentRequestExecutor = async (request) => {
    if (request.system?.includes("Grade a trivia answer")) {
      const answer = (request.prompt ?? "").match(/Answer: (.*)/)?.[1] ?? "";
      return {
        output: {
          correct: /initial/i.test(answer),
          expected: "the initial state",
          explanation: "A machine starts in the state named by `initial`.",
        },
        usage: { totalTokens: 12 },
      };
    }
    return {
      output: "What state does an XState machine start in?",
      usage: { totalTokens: 12 },
    };
  };

  const session = createAgentActor(sessionQuizMachine, {
    input: {},
    executors: { generateText },
  });

  // Turn 1: the machine asks and settles idle waiting for the player.
  let result = await session.settled();
  console.log(`settled: ${result.status}`); // idle

  console.log(idleLabel(session.actor.getSnapshot()));

  // Turn 2: the player answers on the SAME live actor — no snapshot restore.
  session.actor.send({ type: "ANSWER", text: "the initial state" });
  result = await session.settled();
  console.log(`settled: ${result.status}`); // idle again (graded, then next question)
  // The verdict on the answer leads the next prompt.
  console.log(idleLabel(session.actor.getSnapshot()));

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
