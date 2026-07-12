import { describe, expect, test } from "vitest";
import { createActor, createAsyncLogic, toPromise, waitFor } from "xstate";
import {
  emailDrafter,
  emailDrafterSchemas,
  evaluatePrompt,
  draftEmail,
  gameMachine,
  jokeMachine,
  rateJoke as rateJokeLogic,
  tellJoke as tellJokeLogic,
} from "../examples/index.js";
import {
  getAgentRequests,
  resolveAgentStep,
  resolveDecision,
  runAgent,
  transitionAgentStep,
  type AgentTextRequest,
} from "./index.js";
import { initialTransition } from "xstate";

describe("curated XState setup examples", () => {
  test("email drafter follows prompt, revise, send loop with normal XState runtime", async () => {
    const calls: AgentTextRequest[] = [];
    const sent: unknown[] = [];
    const machine = emailDrafter.provide({
      actorSources: {
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

    const [chooseMove] = getAgentRequests(gameMachine, actions, snapshot);

    if (chooseMove?.kind !== "decision") {
      throw new Error("Expected a decision request.");
    }
    expect(chooseMove.events.map((event) => event.type)).toEqual(["ATTACK", "DEFEND", "FLEE"]);

    const attackEvent = await resolveDecision(chooseMove, async () => ({
      event: { type: "ATTACK", target: "goblin" },
    }));

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
    expect(finalStep.snapshot.output).toEqual({
      outcome: "continue",
      summary: "You strike the goblin.",
      playerHp: 20,
      enemyHp: 9,
    });
  });

  test("joke workflow loops until the decision ends it", async () => {
    const decisions = ["TELL_ANOTHER", "END"] as const;
    let jokes = 0;
    let decisionIndex = 0;
    const machine = jokeMachine.provide({
      actorSources: {
        tellJoke: tellJokeLogic.withExecutor(async ({ input }) => {
          jokes += 1;
          return { output: `joke ${jokes} about ${input.topic}` };
        }),
        rateJoke: rateJokeLogic.withExecutor(async () => ({
          output: { rating: jokes === 1 ? 3 : 9, explanation: "because" },
        })),
      },
    });

    // runAgent auto-delivers each chosen decision event: the machine's
    // `deciding` state loops back to `telling` on TELL_ANOTHER and ends on END.
    const result = await runAgent(machine, {
      input: { topic: "state machines" },
      decide: async () => ({ event: { type: decisions[decisionIndex++] ?? "END" } }),
    });

    expect(jokes).toBe(2);
    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output).toEqual({
      topic: "state machines",
      jokes: ["joke 1 about state machines", "joke 2 about state machines"],
      lastRating: 9,
    });
  });
});
