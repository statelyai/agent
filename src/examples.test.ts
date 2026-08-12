import { describe, expect, test } from "vitest";
import { createActor, createAsyncLogic, toPromise, waitFor } from "xstate";
import {
  emailDrafter,
  emailDrafterSchemas,
  evaluatePrompt,
  draftEmail,
  gameMachine,
  runRpsExample,
  jokeMachine,
  rateJoke as rateJokeLogic,
  tellJoke as tellJokeLogic,
} from "../examples/index.js";
import { runAgent, type AgentTextRequest } from "./index.js";
// The step envelope (getAgentRequests/resolveAgentStep/transitionAgentStep) is
// internal now — imported straight from ./steps.js (it backs verify.ts and these
// example checks); resolveDecision remains on the public /steps subpath.
import { getAgentRequests, resolveAgentStep, transitionAgentStep } from "./steps.js";
import { resolveDecision } from "./index.js";
import { initialTransition } from "xstate";

describe("curated XState setup examples", () => {
  test("email drafter follows prompt, revise, send loop with normal XState runtime", async () => {
    const calls: AgentTextRequest[] = [];
    const sent: unknown[] = [];
    const machine = emailDrafter.provide({
      actors: {
        evaluatePrompt: evaluatePrompt.withExecutor(async ({ request }) => {
          calls.push(request);
          const satisfied = calls.filter((call) => call.system?.includes("Evaluate")).length > 1;
          return {
            output: {
              satisfied,
              missing: satisfied ? [] : ["recipient"],
              questions: satisfied ? [] : ["Who should receive it?"],
            },
          };
        }),
        draftEmail: draftEmail.withExecutor(async ({ request }) => {
          calls.push(request);
          return {
            output: {
              to: "riley@example.com",
              subject: "Thanks for meeting",
              body: "Hi Riley, thanks for meeting today.",
            },
          };
        }),
        sendEmail: createAsyncLogic<
          { sent: boolean },
          { draft: { to: string; subject: string; body: string } }
        >({
          run: async ({ input }) => {
            sent.push(input);
            return { sent: true };
          },
        }),
      },
    });

    const actor = createActor(machine);
    actor.start();

    actor.send({
      type: "PROMPT_SUBMITTED",
      prompt: "Write a thank you email after the meeting.",
    });
    await waitFor(actor, (snapshot) => snapshot.matches("needsMoreInfo"));

    actor.send({
      type: "MORE_INFO",
      details: "Send it to riley@example.com.",
    });
    await waitFor(actor, (snapshot) => snapshot.matches("reviewing"));

    expect(actor.getSnapshot().context.draft).toEqual({
      to: "riley@example.com",
      subject: "Thanks for meeting",
      body: "Hi Riley, thanks for meeting today.",
    });
    expect(calls.at(-1)).toEqual(
      expect.objectContaining({
        prompt: undefined,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: "Write a thank you email after the meeting.",
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Send it to riley@example.com."),
          }),
        ]),
      }),
    );

    actor.send({ type: "SEND" });
    await waitFor(actor, (snapshot) => snapshot.matches("sent"));
    actor.send({ type: "END" });
    await toPromise(actor);

    expect(sent).toEqual([
      {
        draft: {
          to: "riley@example.com",
          subject: "Thanks for meeting",
          body: "Hi Riley, thanks for meeting today.",
        },
      },
    ]);
    expect(actor.getSnapshot().output).toEqual({
      sentEmails: [
        {
          to: "riley@example.com",
          subject: "Thanks for meeting",
          body: "Hi Riley, thanks for meeting today.",
        },
      ],
    });
  });

  test("email drafter exports schemas for host-side event validation", () => {
    const result = emailDrafterSchemas.events.PROMPT_SUBMITTED["~standard"].validate({
      type: "PROMPT_SUBMITTED",
      prompt: "Draft an email",
    });

    expect(result).toEqual({
      value: {
        prompt: "Draft an email",
      },
    });
  });

  test("game workflow exposes only whitelisted moves as decision candidates", async () => {
    const [snapshot, actions] = initialTransition(gameMachine, {
      playerHp: 20,
      enemyHp: 15,
    });

    const [chooseMove] = getAgentRequests(actions, { machine: gameMachine, snapshot });

    if (chooseMove?.kind !== "decision") {
      throw new Error("Expected a decision request.");
    }
    expect(chooseMove.events.map((event) => event.type)).toEqual(["ATTACK", "DEFEND", "FLEE"]);

    const attackEvent = await resolveDecision(chooseMove, {
      decide: async () => ({ event: { type: "ATTACK", target: "goblin" } }),
    });

    const attackStep = transitionAgentStep(gameMachine, snapshot, attackEvent as never);

    const [summarize] = attackStep.requests;
    if (summarize?.kind !== "text") {
      throw new Error("Expected a text request.");
    }
    expect(summarize.events).toEqual([]);

    const finalStep = resolveAgentStep(gameMachine, attackStep, summarize, {
      summary: "You strike the goblin.",
      playerHp: 20,
      enemyHp: 9,
    });

    expect(finalStep.done).toBe(true);
    // The summary is a narrated log; the model's line is embedded in it.
    expect(finalStep.snapshot.output).toMatchObject({
      outcome: "continue",
      playerHp: 20,
      enemyHp: 9,
    });
    expect((finalStep.snapshot.output as { summary: string }).summary).toContain(
      "You strike the goblin.",
    );
  });

  test("event-log game feeds the saved round history back into each decide prompt", async () => {
    const prompts: string[] = [];
    // The human always throws rock. The mock model uses ONLY the rendered
    // history in the prompt: after round 1 it sees "human threw rock" and
    // counters with paper every time. Winning from round 2 on proves the event
    // log the machine saved to context round-trips into the model's prompt.
    const result = await runRpsExample({
      input: { targetWins: 3 },
      humanThrows: Array.from({ length: 8 }, () => ({ type: "HUMAN_ROCK" as const })),
      decide: async (request) => {
        prompts.push(request.prompt ?? "");
        const humanThrewRock = request.prompt?.includes("human threw rock");
        return { event: { type: humanThrewRock ? "THROW_PAPER" : "THROW_SCISSORS" } };
      },
    });

    expect(prompts[0]).toContain("No rounds played yet.");
    expect(prompts[1]).toContain("Round 1: human threw rock, you threw scissors — human win");
    expect(result.outcome).toBe("lost");
    expect(result.opponentScore).toBe(3);
    expect(result.playerScore).toBe(1);
  });

  /** Joke machine wired to counting stubs: `n` jokes told, ratings 3 then 9. */
  function provideJokeStubs() {
    const jokes: string[] = [];
    const machine = jokeMachine.provide({
      actors: {
        tellJoke: tellJokeLogic.withExecutor(async ({ input }) => {
          const joke = `joke ${jokes.length + 1} about ${input.topic}`;
          jokes.push(joke);
          return { output: joke };
        }),
        rateJoke: rateJokeLogic.withExecutor(async () => ({
          output: { rating: jokes.length === 1 ? 3 : 9, explanation: "because" },
        })),
      },
    });
    return { machine, jokes };
  }

  test("joke workflow loops until the decision ends it", async () => {
    const { machine, jokes } = provideJokeStubs();
    const decisionPrompts: string[] = [];

    // runAgent auto-delivers each chosen decision event: the machine's
    // `deciding` state loops back to `telling` on TELL_ANOTHER and ends on END.
    const result = await runAgent(machine, {
      input: { topic: "state machines" },
      executors: {
        generateText: async () => ({ output: {} }),
        decide: async (request) => {
          decisionPrompts.push(request.prompt ?? "");
          return { event: { type: "END" } };
        },
      },
    });

    // The machine, not the model, owns the first revision: no decision is asked
    // for until the improvement pass has already produced a second joke.
    expect(jokes).toHaveLength(2);
    expect(decisionPrompts).toHaveLength(1);
    expect(decisionPrompts[0]).toContain("Last joke rating: 9");
    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output).toMatchObject({
      topic: "state machines",
      joke: "joke 2 about state machines",
      firstJoke: "joke 1 about state machines",
      jokes: ["joke 1 about state machines", "joke 2 about state machines"],
      lastRating: 9,
    });
    // The revision notice carries the score the first attempt got.
    expect(result.status === "done" && result.output.revisionNotice).toContain(
      "First attempt scored 3/10",
    );
  });

  test("joke workflow stops at MAX_JOKES even when the decision says keep going", async () => {
    const { machine, jokes } = provideJokeStubs();
    let decisions = 0;

    const result = await runAgent(machine, {
      input: { topic: "state machines" },
      executors: {
        generateText: async () => ({ output: {} }),
        decide: async () => {
          decisions += 1;
          return { event: { type: "TELL_ANOTHER" } };
        },
      },
    });

    // Improvement pass, one TELL_ANOTHER loop, then the joke cap ends the run
    // before a second decision is ever requested.
    expect(jokes).toHaveLength(3);
    expect(decisions).toBe(1);
    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output.joke).toBe("joke 3 about state machines");
  });
});
