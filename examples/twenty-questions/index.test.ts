import { describe, expect, test } from "vitest";
import { getInteraction, getStatePath, runAgent } from "@statelyai/agent";
import type { AgentDecisionRequest, AgentRequestExecutor, ChosenEvent } from "@statelyai/agent";
import { createMockJudge, type MockJudgeEntry } from "../mock-judge.js";
import {
  GUESS_CORRECT_THRESHOLD,
  PLAY_AGAIN_THRESHOLD,
  createClassifyAnswer,
  createClassifyGuessFeedback,
  createClassifyPlayAgain,
  idlePrompt,
  twentyQuestionsMachine,
  type PlayerEvent,
} from "./index.js";

/** The one text request left (`answerSideQuestion`), routed on `request.name`. */
function createClassifier(seenModels: string[] = []): AgentRequestExecutor {
  return async (request) => {
    seenModels.push(request.model);
    switch (request.name) {
      case "answerSideQuestion": {
        const question = request.prompt?.match(/Side question: (.*)/)?.[1] ?? "";
        return { result: `Briefly: the answer to "${question}" is yes.` };
      }
      default:
        throw new Error(`Unexpected request '${request.name}'.`);
    }
  };
}

const replyOf = (state: unknown) => (state as { reply: string }).reply;

/**
 * The three free-text judgments, answered by Jev question name from the raw
 * reply in the request state. Overrides replace a question's entry.
 */
function createJev(overrides: Record<string, MockJudgeEntry | MockJudgeEntry[]> = {}) {
  const jev = createMockJudge({
    // A reply ending in '?' is a side question back at the agent.
    reply: (state) => {
      const reply = replyOf(state);
      if (reply.endsWith("?")) return "sideQuestion";
      return reply === "mhm" || reply === "for sure" ? "yes" : "no";
    },
    guessCorrect: (state) => /^(yes|correct|right)$/i.test(replyOf(state)),
    playAgain: (state) => /^yes$/i.test(replyOf(state)),
    ...overrides,
  });
  const actors = {
    classifyAnswer: createClassifyAnswer(jev.model),
    classifyGuessFeedback: createClassifyGuessFeedback(jev.model),
    classifyPlayAgain: createClassifyPlayAgain(jev.model),
  };
  return { calls: jev.calls, actors };
}

interface PlayOptions {
  input?: { questionsRemaining: number };
  decide: (request: AgentDecisionRequest) => Promise<{ event: ChosenEvent }>;
  generateText?: AgentRequestExecutor;
  jev?: ReturnType<typeof createJev>;
  /** Consumed in order on each idle settle. */
  playerEvents: PlayerEvent[];
  on?: { SIDE_ANSWER?: (payload: { question: string; answer: string }) => void };
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
    actors: (options.jev ?? createJev()).actors,
    ...(options.on ? { on: options.on } : {}),
  };

  let result = await runAgent(twentyQuestionsMachine, {
    input: options.input ?? { questionsRemaining: 20 },
    ...shared,
  });

  while (result.status === "idle") {
    // Every idle state must advertise how a host can unblock it.
    const interaction = getInteraction(result.snapshot);
    expect(interaction, `no interaction meta on ${getStatePath(result.snapshot)}`).toBeDefined();
    prompts.push(idlePrompt(result.snapshot));
    interactions.push({
      events: interaction!.events.map(({ type }) => type),
      textEvent: interaction!.textEvent,
    });

    const event = queued.shift();
    if (!event) throw new Error(`ran out of player events at: ${prompts.at(-1)}`);
    // Buttons and free text alike are ordinary machine events the state accepts.
    expect(result.snapshot.can(event)).toBe(true);

    result = await runAgent(twentyQuestionsMachine, {
      snapshot: result.persist(),
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
    const jev = createJev();

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
      jev,
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
    // Every free-text reply was read by a Jev judgment, not the text model.
    expect(jev.calls.map((call) => Object.keys(call.questions)[0])).toEqual([
      "reply",
      "reply",
      "guessCorrect",
      "playAgain",
    ]);
    expect(textModels).toEqual([]);
  });

  test("the pending question stays out of the transcript until it is answered", async () => {
    const decide = async (): Promise<{ event: ChosenEvent }> => ({
      event: { type: "ASK", question: "Is it an animal?" },
    });

    // First idle settle: the question has been asked, nothing answered yet.
    const asked = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 20 },
      executors: { generateText: createClassifier(), decide },
      actors: createJev().actors,
    });

    expect(asked.status).toBe("idle");
    if (asked.status !== "idle") throw new Error("expected idle");
    expect(asked.snapshot.context.question).toBe("Is it an animal?");
    expect(asked.snapshot.context.transcript).toEqual([]);

    // The entry appears only once an answer event arrives.
    const answered = await runAgent(twentyQuestionsMachine, {
      snapshot: asked.persist(),
      event: { type: "ANSWER_YES" },
      executors: { generateText: createClassifier(), decide },
      actors: createJev().actors,
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
      actors: createJev().actors,
    });
    if (asked.status !== "idle") throw new Error("expected idle");

    const answered = await runAgent(twentyQuestionsMachine, {
      snapshot: asked.persist(),
      event: { type: "ANSWER", rawAnswer: "mhm" },
      executors: { generateText: createClassifier(), decide },
      actors: createJev().actors,
    });

    expect(answered.snapshot.context.transcript).toEqual([
      { question: "Is it an animal?", answer: "yes", rawAnswer: "mhm" },
    ]);
  });

  test("button events answer deterministically, without a classifier call", async () => {
    const textModels: string[] = [];
    const jev = createJev();
    let askCount = 0;

    const { result, prompts } = await play({
      generateText: createClassifier(textModels),
      jev,
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
    // No request executor or Jev call ran: every reply came from a button.
    expect(textModels).toEqual([]);
    expect(jev.calls).toEqual([]);
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
        SIDE_ANSWER: ({ question, answer }) => {
          sideAnswers.push({ question, answer });
        },
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

  test("a free-text reply asks Jev one choice over the pending question and the reply", async () => {
    const jev = createJev();
    const { prompts } = await play({
      jev,
      decide: async (request) =>
        request.prompt?.includes("(none yet)")
          ? { event: { type: "ASK", question: "Is it an animal?" } }
          : { event: { type: "GUESS", guess: "a cat" } },
      playerEvents: [
        { type: "ANSWER", rawAnswer: "is a cat an animal?" },
        { type: "ANSWER", rawAnswer: "nope" },
        { type: "GUESS_RIGHT" },
        { type: "PLAY_AGAIN_NO" },
      ],
    });

    const [side, answer] = jev.calls;
    expect(side!.state).toEqual({ question: "Is it an animal?", reply: "is a cat an animal?" });
    expect(Object.keys(side!.questions)).toEqual(["reply"]);
    const question = side!.questions.reply as { type: string; criteria: object };
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria)).toEqual(["yes", "no", "sideQuestion"]);
    // sideQuestion re-asked the same question; "nope" was then read as no.
    expect(answer!.state).toEqual({ question: "Is it an animal?", reply: "nope" });
    expect(prompts.slice(0, 2)).toEqual(["Is it an animal?", "Is it an animal?"]);
  });

  test("guess feedback and play-again are one boolean question each; just under the threshold reads as no", async () => {
    const jev = createJev({
      guessCorrect: GUESS_CORRECT_THRESHOLD - 0.01,
      playAgain: PLAY_AGAIN_THRESHOLD - 0.01,
    });
    const { result } = await play({
      input: { questionsRemaining: 1 },
      jev,
      decide: async () => ({ event: { type: "GUESS", guess: "a fish" } }),
      playerEvents: [
        { type: "GUESS_FEEDBACK", rawAnswer: "sort of" },
        { type: "PLAY_AGAIN", rawAnswer: "maybe later" },
      ],
    });

    expect(jev.calls.map((call) => call.state)).toEqual([
      { guess: "a fish", reply: "sort of" },
      { question: "Do you want to play another round?", reply: "maybe later" },
    ]);
    expect(jev.calls.map((call) => Object.values(call.questions)[0]!.type)).toEqual([
      "boolean",
      "boolean",
    ]);
    expect(result.status === "done" && result.output).toMatchObject({
      userScore: 1,
      agentScore: 0,
      roundsPlayed: 1,
    });

    // At the threshold, both read as yes: the agent scores and a round starts.
    const at = await play({
      input: { questionsRemaining: 1 },
      jev: createJev({
        guessCorrect: GUESS_CORRECT_THRESHOLD,
        playAgain: [PLAY_AGAIN_THRESHOLD, 0],
      }),
      decide: async () => ({ event: { type: "GUESS", guess: "a fish" } }),
      playerEvents: [
        { type: "GUESS_FEEDBACK", rawAnswer: "sort of" },
        { type: "PLAY_AGAIN", rawAnswer: "maybe later" },
        { type: "GUESS_FEEDBACK", rawAnswer: "sort of" },
        { type: "PLAY_AGAIN", rawAnswer: "no" },
      ],
    });
    expect(at.result.status === "done" && at.result.output).toMatchObject({
      agentScore: 2,
      roundsPlayed: 2,
    });
  });
});
