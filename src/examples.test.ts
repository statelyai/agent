import { describe, expect, test } from 'vitest';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import {
  emailDrafter,
  emailDrafterSchemas,
  evaluatePrompt,
  draftEmail,
  chooseMove as chooseMoveLogic,
  gameMachine,
  gameSchemas,
  jokeMachine,
  summarizeTurn,
  tellJoke as tellJokeLogic,
} from '../examples/index.js';
import {
  getAgentRequests,
  type AgentTextRequest,
  transitionResult,
} from './index.js';
import { initialTransition, transition } from 'xstate';

describe('curated XState setup examples', () => {
  test('email drafter follows prompt, revise, send loop with normal XState runtime', async () => {
    const calls: AgentTextRequest[] = [];
    const sent: unknown[] = [];
    const machine = emailDrafter.provide({
      actorSources: {
        evaluatePrompt: evaluatePrompt.withExecutor(async ({ input, request }) => {
          calls.push(request);
          const satisfied =
            calls.filter((call) => call.system?.includes('Evaluate')).length > 1;
          return {
            satisfied,
            missing: satisfied ? [] : ['recipient'],
            questions: satisfied ? [] : ['Who should receive it?'],
          };
        }),
        draftEmail: draftEmail.withExecutor(async ({ request }) => {
          calls.push(request);
          return {
            to: 'riley@example.com',
            subject: 'Thanks for meeting',
            body: 'Hi Riley, thanks for meeting today.',
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
      type: 'PROMPT_SUBMITTED',
      prompt: 'Write a thank you email after the meeting.',
    });
    await waitFor(actor, (snapshot) => snapshot.matches('needsMoreInfo'));

    actor.send({
      type: 'MORE_INFO',
      details: 'Send it to riley@example.com.',
    });
    await waitFor(actor, (snapshot) => snapshot.matches('reviewing'));

    expect(actor.getSnapshot().context.draft).toEqual({
      to: 'riley@example.com',
      subject: 'Thanks for meeting',
      body: 'Hi Riley, thanks for meeting today.',
    });
    expect(calls.at(-1)).toEqual(
      expect.objectContaining({
        prompt: undefined,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: 'Write a thank you email after the meeting.',
          }),
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Send it to riley@example.com.'),
          }),
        ]),
      })
    );

    actor.send({ type: 'SEND' });
    await waitFor(actor, (snapshot) => snapshot.matches('sent'));
    actor.send({ type: 'END' });
    await toPromise(actor);

    expect(sent).toEqual([
      {
        draft: {
          to: 'riley@example.com',
          subject: 'Thanks for meeting',
          body: 'Hi Riley, thanks for meeting today.',
        },
      },
    ]);
    expect(actor.getSnapshot().output).toEqual({
      sentEmails: [
        {
          to: 'riley@example.com',
          subject: 'Thanks for meeting',
          body: 'Hi Riley, thanks for meeting today.',
        },
      ],
    });
  });

  test('email drafter exports schemas for host-side event validation', () => {
    const result = emailDrafterSchemas.events.PROMPT_SUBMITTED['~standard'].validate({
      type: 'PROMPT_SUBMITTED',
      prompt: 'Draft an email',
    });

    expect(result).toEqual({
      value: {
        prompt: 'Draft an email',
      },
    });
  });

  test('game workflow exposes only whitelisted moves as event tools', async () => {
    let [snapshot, actions] = initialTransition(gameMachine, {
      playerHp: 20,
      enemyHp: 15,
    });

    const [chooseMove] = getAgentRequests(actions, {
      snapshot,
      schemas: gameSchemas,
      actors: { chooseMove: chooseMoveLogic, summarizeTurn },
    });

    expect(chooseMove?.events.map((event) => event.type)).toEqual([
      'ATTACK',
      'DEFEND',
      'FLEE',
    ]);

    if (chooseMove?.kind !== 'text') {
      throw new Error('Expected a text request.');
    }
    const attackTool = chooseMove.tools.send_event_ATTACK!;
    if (typeof attackTool === 'function') {
      throw new Error('Expected event tool descriptor.');
    }
    const attackEvent = await attackTool.execute?.({ target: 'goblin' });

    [snapshot, actions] = transition(gameMachine, snapshot, attackEvent as never);
    const [summarize] = getAgentRequests(actions, {
      snapshot,
      schemas: gameSchemas,
      actors: { chooseMove: chooseMoveLogic, summarizeTurn },
    });

    expect(summarize?.events).toEqual([]);

    [snapshot] = transitionResult(gameMachine, snapshot, summarize!, {
      summary: 'You strike the goblin.',
      playerHp: 20,
      enemyHp: 9,
    });

    expect(snapshot.status).toBe('done');
    expect(snapshot.output).toEqual({
      outcome: 'continue',
      summary: 'You strike the goblin.',
      playerHp: 20,
      enemyHp: 9,
    });
  });

  test('joke workflow loops until user feedback is done', async () => {
    const feedback = ['try another one', 'ok done'];
    let jokes = 0;
    const machine = jokeMachine.provide({
      actorSources: {
        tellJoke: tellJokeLogic.withExecutor(async ({ input }) => {
          jokes += 1;
          return `joke ${jokes} about ${input.topic}`;
        }),
        'agent.userInput': createAsyncLogic({
          run: async () => ({ feedback: feedback.shift() ?? 'done' }),
        }),
      },
    });

    const actor = createActor(machine, { input: { topic: 'state machines' } });
    actor.start();
    await toPromise(actor);

    expect(jokes).toBe(2);
    expect(actor.getSnapshot().output).toEqual({
      joke: 'joke 2 about state machines',
    });
  });
});
