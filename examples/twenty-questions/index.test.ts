import { describe, expect, test } from "vitest";
import { runAgent } from "../../src/index.js";
import type {
  AgentDecisionRequest,
  AgentMessage,
  AgentRequestExecutor,
  AgentUserInput,
  ChosenEvent,
} from "../../src/index.js";
import { twentyQuestionsMachine } from "./index.js";

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

describe("twenty-questions", () => {
  test("press-play flow: machine owns context, user prompts, and event validation", async () => {
    let askCount = 0;
    const decisionModels: string[] = [];
    const textModels: string[] = [];
    const prompts: string[] = [];
    const answers = ["mhm", "for sure", "no", "no"];

    const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
      decisionModels.push(request.model);
      askCount += 1;
      if (askCount <= 2) {
        return { event: { type: "ASK", question: `Is it question ${askCount}?` } };
      }
      return { event: { type: "GUESS", guess: "a cat" } };
    };

    const result = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 20 },
      executors: { generateText: createClassifier(textModels), decide },
      userInput: async (input: AgentUserInput) => {
        prompts.push(input.prompt ?? "");
        return answers.shift() ?? "no";
      },
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
    expect(prompts).toEqual([
      "Is it question 1?",
      "Is it question 2?",
      "My guess is a cat. Was I right?",
      "Do you want to play another round?",
    ]);
    expect(decisionModels).toEqual(["quick", "quick", "quick"]);
    expect(textModels).toEqual(["quick", "quick", "quick", "quick"]);
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

    const result = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 1 },
      executors: { generateText: createClassifier(), decide },
      userInput: async () => "correct",
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
    const answers = ["correct", "yes", "wrong", "no"];
    const prompts: string[] = [];

    const result = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 1 },
      executors: {
        generateText: createClassifier(),
        decide: async () => ({
          event: { type: "GUESS", guess: guesses.shift() ?? "unknown" },
        }),
      },
      userInput: async ({ prompt }) => {
        prompts.push(prompt ?? "");
        return answers.shift() ?? "no";
      },
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
    const prompts: string[] = [];
    const sideAnswers: { question: string; answer: string }[] = [];
    // Reply 1 is a side question; reply 2 answers the re-asked question; then
    // guess feedback and play-again wrap up.
    const answers = ["is a lizard considered domestic?", "mhm", "correct", "no"];

    let decisions = 0;
    const decide = async (): Promise<{ event: ChosenEvent }> => {
      decisions += 1;
      if (decisions === 1) {
        return { event: { type: "ASK", question: "Is it an animal?" } };
      }
      return { event: { type: "GUESS", guess: "a lizard" } };
    };

    const result = await runAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 20 },
      executors: { generateText: createClassifier(), decide },
      userInput: async ({ prompt }: AgentUserInput) => {
        prompts.push(prompt ?? "");
        return answers.shift() ?? "no";
      },
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
});
