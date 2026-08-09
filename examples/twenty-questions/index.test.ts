import { describe, expect, test } from "vitest";
import { getStateMeta, runAgent } from "@statelyai/agent";
import type {
  AgentDecisionRequest,
  AgentMessage,
  AgentRequestExecutor,
  ChosenEvent,
} from "@statelyai/agent";
import { idlePrompt, twentyQuestionsMachine, type PlayerEvent } from "./index.js";

function textContent(message: AgentMessage | undefined) {
  return typeof message?.content === "string" ? message.content : "";
}

function rawAnswerFrom(request: Parameters<AgentRequestExecutor>[0]) {
  return textContent(request.messages?.at(-1)).match(/Raw answer: (.*)/)?.[1] ?? "";
}

function createClassifier(seenModels: string[] = []): AgentRequestExecutor {
  return async (request) => {
    seenModels.push(request.model);
    const rawAnswer = rawAnswerFrom(request);
    if (request.system?.includes("guess was correct")) {
      return {
        output: {
          correct: /^(yes|correct|right)$/i.test(rawAnswer),
          reasoning: `classified guess feedback ${rawAnswer}`,
        },
      };
    }
    if (request.system?.includes("play another round")) {
      return {
        output: {
          playAgain: /^yes$/i.test(rawAnswer),
          reasoning: `classified play again ${rawAnswer}`,
        },
      };
    }
    if (request.system?.includes("side question")) {
      // answerSideQuestion: prompt carries `Side question: ...`.
      const question = request.prompt?.match(/Side question: (.*)/)?.[1] ?? "";
      return { output: `Briefly: the answer to "${question}" is yes.` };
    }
    // classifyAnswer: a reply ending in '?' is a side question back at the agent.
    if (rawAnswer.endsWith("?")) {
      return {
        output: {
          kind: "sideQuestion",
          question: rawAnswer,
          reasoning: `classified side question ${rawAnswer}`,
        },
      };
    }
    return {
      output: {
        kind: "answer",
        answer: rawAnswer === "mhm" || rawAnswer === "for sure" ? "yes" : "no",
        reasoning: `classified ${rawAnswer}`,
      },
    };
  };
}

interface PlayOptions {
  input?: { questionsRemaining: number };
  decide: (request: AgentDecisionRequest) => Promise<{ event: ChosenEvent }>;
  generateText?: AgentRequestExecutor;
  /** Consumed in order on each idle settle. */
  playerEvents: PlayerEvent[];
  on?: Record<string, (payload: never) => void>;
}

/**
 * Drives the machine through its idle-resume loop, recording the interaction
 * hint shown at each idle settle.
 */
async function play(options: PlayOptions) {
  const queued = [...options.playerEvents];
  const prompts: string[] = [];
  const interactions: { events: string[]; textEvent?: string }[] = [];
  const shared = {
    executors: {
      generateText: options.generateText ?? createClassifier(),
      decide: options.decide,
    },
    ...(options.on ? { on: options.on as never } : {}),
  };

  let result = await runAgent(twentyQuestionsMachine, {
    input: options.input ?? { questionsRemaining: 20 },
    ...shared,
  });

  while (result.status === "idle") {
    // Every idle state must advertise how a host can unblock it.
    const interaction = getStateMeta(result.snapshot).interaction;
    expect(
      interaction,
      `no interaction meta on ${JSON.stringify(result.snapshot.value)}`,
    ).toBeDefined();
    prompts.push(idlePrompt(result.snapshot));
    interactions.push({
      events: Object.keys(interaction!.events ?? {}),
      textEvent: interaction!.textEvent,
    });

    const event = queued.shift();
    if (!event) throw new Error(`ran out of player events at: ${prompts.at(-1)}`);
    // Buttons and free text alike are ordinary machine events the state accepts.
    expect(result.snapshot.can(event as never)).toBe(true);

    result = await runAgent(twentyQuestionsMachine, {
      snapshot: result.persistedSnapshot,
      event,
      ...shared,
    });
  }

  return { result, prompts, interactions };
}

describe("twenty-questions", () => {
  test("press-play flow: machine owns context, idle interaction hints, and event validation", async () => {
    let askCount = 0;
    const decisionModels: string[] = [];
    const textModels: string[] = [];

    const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
      decisionModels.push(request.model);
      askCount += 1;
      if (askCount <= 2) {
        return { event: { type: "ASK", question: `Is it question ${askCount}?` } };
      }
      return { event: { type: "GUESS", guess: "a cat" } };
    };

    const { result, prompts, interactions } = await play({
      decide,
      generateText: createClassifier(textModels),
      playerEvents: [
        { type: "ANSWER", rawAnswer: "mhm" },
        { type: "ANSWER", rawAnswer: "for sure" },
        { type: "GUESS_FEEDBACK", rawAnswer: "no" },
        { type: "PLAY_AGAIN", rawAnswer: "no" },
      ],
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output).toEqual({
      guess: "a cat",
      questionsUsed: 2,
      userScore: 1,
      agentScore: 0,
      roundsPlayed: 1,
    });
    // Labels interpolate `{question}` against the snapshot context.
    expect(prompts).toEqual([
      "Is it question 1?",
      "Is it question 2?",
      "My guess is a cat. Was I right?",
      "Do you want to play another round?",
    ]);
    expect(interactions).toEqual([
      { events: ["ANSWER_YES", "ANSWER_NO", "ANSWER"], textEvent: "ANSWER" },
      { events: ["ANSWER_YES", "ANSWER_NO", "ANSWER"], textEvent: "ANSWER" },
      { events: ["GUESS_RIGHT", "GUESS_WRONG", "GUESS_FEEDBACK"], textEvent: "GUESS_FEEDBACK" },
      { events: ["PLAY_AGAIN_YES", "PLAY_AGAIN_NO", "PLAY_AGAIN"], textEvent: "PLAY_AGAIN" },
    ]);
    expect(decisionModels).toEqual(["quick", "quick", "quick"]);
    expect(textModels).toEqual(["quick", "quick", "quick", "quick"]);
  });

  test("the pending question stays out of the transcript until it is answered", async () => {
    const decide = async (): Promise<{ event: ChosenEvent }> => ({
      event: { type: "ASK", question: "Is it an animal?" },
    });

    // First idle settle: the question has been asked, nothing answered yet.
    const asked = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 20 },
      executors: { generateText: createClassifier(), decide },
    });

    expect(asked.status).toBe("idle");
    if (asked.status !== "idle") throw new Error("expected idle");
    expect(asked.snapshot.context.question).toBe("Is it an animal?");
    expect(asked.snapshot.context.transcript).toEqual([]);

    // The entry appears only once an answer event arrives.
    const answered = await runAgent(twentyQuestionsMachine, {
      snapshot: asked.persistedSnapshot,
      event: { type: "ANSWER_YES" },
      executors: { generateText: createClassifier(), decide },
    });

    expect(answered.snapshot.context.transcript).toEqual([
      { question: "Is it an animal?", answer: "yes", rawAnswer: "yes" },
    ]);
  });

  test("a classified free-text answer records the raw reply on the transcript entry", async () => {
    let decisions = 0;
    const decide = async (): Promise<{ event: ChosenEvent }> => {
      decisions += 1;
      return decisions === 1
        ? { event: { type: "ASK", question: "Is it an animal?" } }
        : { event: { type: "GUESS", guess: "a cat" } };
    };

    const asked = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 20 },
      executors: { generateText: createClassifier(), decide },
    });
    if (asked.status !== "idle") throw new Error("expected idle");

    const answered = await runAgent(twentyQuestionsMachine, {
      snapshot: asked.persistedSnapshot,
      event: { type: "ANSWER", rawAnswer: "mhm" },
      executors: { generateText: createClassifier(), decide },
    });

    expect(answered.snapshot.context.transcript).toEqual([
      { question: "Is it an animal?", answer: "yes", rawAnswer: "mhm" },
    ]);
  });

  test("button events answer deterministically, without a classifier call", async () => {
    const textModels: string[] = [];
    let askCount = 0;

    const { result, prompts } = await play({
      generateText: createClassifier(textModels),
      decide: async () => {
        askCount += 1;
        return askCount === 1
          ? { event: { type: "ASK", question: "Is it an animal?" } }
          : { event: { type: "GUESS", guess: "a cat" } };
      },
      playerEvents: [{ type: "ANSWER_YES" }, { type: "GUESS_RIGHT" }, { type: "PLAY_AGAIN_NO" }],
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output).toEqual({
      guess: "a cat",
      questionsUsed: 1,
      userScore: 0,
      agentScore: 1,
      roundsPlayed: 1,
    });
    expect(prompts).toEqual([
      "Is it an animal?",
      "My guess is a cat. Was I right?",
      "Do you want to play another round?",
    ]);
    // No request executor ran: every reply came from a button.
    expect(textModels).toEqual([]);
  });

  test("guard rejects ASK on the final turn; resolveDecision retries through runAgent", async () => {
    let callCount = 0;
    const requestsSeen: AgentDecisionRequest[] = [];
    const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
      requestsSeen.push(request);
      callCount += 1;
      if (callCount === 1) {
        return { event: { type: "ASK", question: "One more?" } };
      }
      return { event: { type: "GUESS", guess: "a dog" } };
    };

    const { result } = await play({
      input: { questionsRemaining: 1 },
      decide,
      playerEvents: [
        { type: "GUESS_FEEDBACK", rawAnswer: "correct" },
        { type: "PLAY_AGAIN", rawAnswer: "no" },
      ],
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output).toEqual({
      guess: "a dog",
      questionsUsed: 0,
      userScore: 0,
      agentScore: 1,
      roundsPlayed: 1,
    });
    expect(callCount).toBe(2);
    expect(requestsSeen[1]!.attempts[0]!.failure).toBe("rejected-by-guard");
  });

  test("can play another round without host-side accepted-event branching", async () => {
    const guesses = ["a fish", "a piano"];

    const { result, prompts } = await play({
      input: { questionsRemaining: 1 },
      decide: async () => ({
        event: { type: "GUESS", guess: guesses.shift() ?? "unknown" },
      }),
      playerEvents: [
        { type: "GUESS_FEEDBACK", rawAnswer: "correct" },
        { type: "PLAY_AGAIN", rawAnswer: "yes" },
        { type: "GUESS_FEEDBACK", rawAnswer: "wrong" },
        { type: "PLAY_AGAIN", rawAnswer: "no" },
      ],
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output).toEqual({
      guess: "a piano",
      questionsUsed: 0,
      userScore: 1,
      agentScore: 1,
      roundsPlayed: 2,
    });
    expect(prompts).toEqual([
      "My guess is a fish. Was I right?",
      "Do you want to play another round?",
      "My guess is a piano. Was I right?",
      "Do you want to play another round?",
    ]);
  });

  test("side-question detour: answers it, emits SIDE_ANSWER, re-asks the SAME question without consuming a turn", async () => {
    const sideAnswers: { question: string; answer: string }[] = [];

    let decisions = 0;
    const decide = async (): Promise<{ event: ChosenEvent }> => {
      decisions += 1;
      if (decisions === 1) {
        return { event: { type: "ASK", question: "Is it an animal?" } };
      }
      return { event: { type: "GUESS", guess: "a lizard" } };
    };

    const { result, prompts } = await play({
      decide,
      // Reply 1 is a side question; reply 2 answers the re-asked question.
      playerEvents: [
        { type: "ANSWER", rawAnswer: "is a lizard considered domestic?" },
        { type: "ANSWER", rawAnswer: "mhm" },
        { type: "GUESS_FEEDBACK", rawAnswer: "correct" },
        { type: "PLAY_AGAIN", rawAnswer: "no" },
      ],
      on: {
        SIDE_ANSWER: (({ question, answer }: { question: string; answer: string }) => {
          sideAnswers.push({ question, answer });
        }) as never,
      },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");

    // The detour answered the side question (secret-free canned reply) ...
    expect(sideAnswers).toEqual([
      {
        question: "is a lizard considered domestic?",
        answer: 'Briefly: the answer to "is a lizard considered domestic?" is yes.',
      },
    ]);
    // ... and the SAME pending question was re-asked (no turn consumed, no
    // extra transcript entry: questionsUsed stays 1 for the single ASK).
    expect(prompts).toEqual([
      "Is it an animal?",
      "Is it an animal?",
      "My guess is a lizard. Was I right?",
      "Do you want to play another round?",
    ]);
    expect(result.output).toEqual({
      guess: "a lizard",
      questionsUsed: 1,
      userScore: 0,
      agentScore: 1,
      roundsPlayed: 1,
    });
  });
});
