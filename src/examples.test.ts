import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createChatbotExample,
  createAdapterExample,
  createBranchingExample,
  createClassifyExample,
  createCustomerServiceSimExample,
  createDecideExample,
  createEmailExample,
  createHitlExample,
  createJokeExample,
  createJugsExample,
  createMapReduceExample,
  createNewspaperExample,
  createPlanAndExecuteExample,
  createRaffleExample,
  createReactAgentExample,
  createReflectionExample,
  createRiverCrossingExample,
  createSimpleExample,
  createSubflowExample,
  createToolCallingExample,
  createTutorExample,
} from '../examples/index.js';

describe('curated examples', () => {
  test('ships the canonical examples directory', () => {
    const examplesDir = resolve(process.cwd(), 'examples');
    expect(existsSync(resolve(examplesDir, 'simple.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'hitl.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'decide.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'classify.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'adapter.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'branching.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'chatbot.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'customer-service-sim.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'email.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'joke.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'jugs.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'map-reduce.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'newspaper.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'plan-and-execute.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'raffle.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'react-agent.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'reflection.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'river-crossing.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'subflow.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'tool-calling.ts'))).toBe(true);
    expect(existsSync(resolve(examplesDir, 'tutor.ts'))).toBe(true);
  });

  test('simple example runs to a final output', async () => {
    const machine = createSimpleExample(async () => ({
      summary: 'A short summary.',
    }));
    const result = await machine.execute(
      machine.getInitialState({ text: 'Longer source text.' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({ summary: 'A short summary.' });
    }
  });

  test('hitl example exposes typed pending events', async () => {
    const machine = createHitlExample();
    const result = await machine.execute(
      machine.getInitialState({ task: 'Draft an answer' })
    );

    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.value).toBe('gathering');
      expect(result.events['user.message']).toBeDefined();
      expect(result.events['user.approve']).toBeDefined();
    }
  });

  test('decide example chooses a branch and carries typed data', async () => {
    const machine = createDecideExample({
      decide: async () => ({
        choice: 'askForClarification',
        data: { question: 'Which order is affected?' },
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({
        request: 'The customer says their invoice is wrong.',
      })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        action: 'askForClarification',
        payload: { question: 'Which order is affected?' },
      });
    }
  });

  test('classify example reduces to a category only', async () => {
    const machine = createClassifyExample({
      decide: async () => ({
        choice: 'billing',
        data: {},
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({
        request: 'I need help with a refund for my duplicate charge.',
      })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({ category: 'billing' });
    }
  });

  test('adapter example uses the provided schema-aware adapter', async () => {
    const machine = createAdapterExample({
      decide: async () => ({
        choice: 'billing',
        data: { confidence: 0.9 },
      }),
    });
    const result = await machine.execute(machine.getInitialState({ message: 'refund my last invoice' }));

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        route: 'billing',
        confidence: 0.9,
      });
    }
  });

  test('branching example fans out plain async work and summarizes it', async () => {
    const machine = createBranchingExample({
      analyzeDocs: async () => 'docs',
      analyzeIssues: async () => 'issues',
      analyzeCode: async () => 'code',
      summarize: async ({ docs, issues, code }) => ({
        summary: `${docs}/${issues}/${code}`,
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({ topic: 'agents' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        docs: 'docs',
        issues: 'issues',
        code: 'code',
        summary: 'docs/issues/code',
      });
    }
  });

  test('decide example uses structured payloads while classify does not', async () => {
    const decideMachine = createDecideExample({
      decide: async () => ({
        choice: 'reply',
        data: { message: 'Hello there' },
      }),
    });
    const classifyMachine = createClassifyExample({
      decide: async () => ({
        choice: 'general',
        data: {},
      }),
    });

    const decideResult = await decideMachine.execute(
      decideMachine.getInitialState({
        request: 'Please answer this support question.',
      })
    );
    const classifyResult = await classifyMachine.execute(
      classifyMachine.getInitialState({
        request: 'This is a general support question.',
      })
    );

    expect(decideResult.status).toBe('done');
    expect(classifyResult.status).toBe('done');

    if (decideResult.status === 'done' && classifyResult.status === 'done') {
      expect(decideResult.output).toEqual({
        action: 'reply',
        payload: { message: 'Hello there' },
      });
      expect(classifyResult.output).toEqual({ category: 'general' });
    }
  });

  test('hitl example event schemas validate payloads', async () => {
    const machine = createHitlExample();
    const pending = await machine.execute(
      machine.getInitialState({ task: 'Draft an answer' })
    );

    expect(pending.status).toBe('pending');
    if (pending.status === 'pending') {
      const validation = pending.events['user.message']!['~standard'].validate({
        type: 'user.message',
        message: 'Here is the missing detail',
      });

      expect(validation.issues).toBeUndefined();
    }
  });

  test('decide example uses schemas on branch payloads', async () => {
    const machine = createDecideExample({
      decide: async () => ({
        choice: 'reply',
        data: { message: 'Resolved' },
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({
        request: 'Please respond to this support request.',
      })
    );

    expect(result.status).toBe('done');
    expect(
      z
        .object({
          action: z.string(),
          payload: z.object({ message: z.string() }),
        })
        .safeParse(result.status === 'done' ? result.output : null).success
    ).toBe(true);
  });

  test('chatbot example accepts a user message and replies', async () => {
    const machine = createChatbotExample({
      adapter: {
        decide: async () => ({ choice: 'respond', data: {} }),
      },
      reply: async () => ({ response: 'Assistant reply' }),
    });

    const pending = await machine.execute(machine.getInitialState());
    expect(pending.status).toBe('pending');

    if (pending.status === 'pending') {
      const next = machine.transition(pending.state, {
        type: 'user.message',
        message: 'Hello there',
      });
      const result = await machine.execute(next);

      expect(result.status).toBe('pending');
      if (result.status === 'pending') {
        expect(result.context.transcript).toEqual([
          'User: Hello there',
          'Assistant: Assistant reply',
        ]);
      }
    }
  });

  test('customer service sim example reaches a terminal outcome', async () => {
    const machine = createCustomerServiceSimExample({
      serviceReply: async () => ({ response: 'We can help.' }),
      customerReply: async () => ({
        response: 'Thanks, that works.',
        done: true,
        outcome: 'resolved',
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({ issue: 'I want a refund.' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        transcript: [
          'Customer: I want a refund.',
          'Agent: We can help.',
          'Customer: Thanks, that works.',
        ],
        turnCount: 1,
        outcome: 'resolved',
      });
    }
  });

  test('email example can pause for clarification and then draft using tools', async () => {
    let checkCount = 0;
    const machine = createEmailExample({
      adapter: {
        decide: async () => {
          checkCount += 1;
          return checkCount === 1
            ? {
                choice: 'askForClarification',
                data: { questions: ['Which day should I offer?'] },
              }
            : { choice: 'draft', data: {} };
        },
      },
      tools: {
        lookupContactName: async () => 'Pat Lee',
        lookupAvailability: async () => ['Friday at 1 PM'],
        createSignature: async (name) => `Best,\n${name}`,
      },
      compose: async ({
        email,
        instructions,
        clarifications,
        contactName,
        availability,
        signature,
      }) => ({
        replyEmail: [
          `Hi ${contactName},`,
          '',
          `Thanks for your note: "${email}"`,
          instructions,
          clarifications.join(' '),
          `I am available ${availability.join(' or ')}.`,
          '',
          signature,
        ]
          .filter(Boolean)
          .join('\n'),
      }),
    });

    const first = await machine.execute(
      machine.getInitialState({
        email: 'Can you meet next week?',
        instructions: 'Reply with one specific slot.',
      })
    );

    expect(first.status).toBe('pending');
    if (first.status === 'pending') {
      expect(first.context.questions).toEqual(['Which day should I offer?']);

      const next = machine.transition(first.state, {
        type: 'user.answer',
        answer: 'Offer Friday afternoon.',
      });
      const done = await machine.execute(next);

      expect(done.status).toBe('done');
      if (done.status === 'done') {
        expect(
          z
            .object({
              replyEmail: z.string(),
              clarifications: z.array(z.string()),
            })
            .safeParse(done.output).success
        ).toBe(true);
      }
    }
  });

  test('joke example produces a rating and acceptance flag', async () => {
    const machine = createJokeExample({
      tellJoke: async () => ({ joke: 'A short joke about ducks.' }),
      rateJoke: async () => ({ rating: 9, explanation: 'It works.' }),
    });

    const result = await machine.execute(
      machine.getInitialState({ topic: 'ducks' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        topic: 'ducks',
        joke: 'A short joke about ducks.',
        rating: 9,
        explanation: 'It works.',
        accepted: true,
      });
    }
  });

  test('jugs example solves the 3 and 5 gallon puzzle', async () => {
    const machine = createJugsExample();
    const result = await machine.execute(machine.getInitialState());

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        jug3: 3,
        jug5: 4,
        steps: [
          'Filled the 5-gallon jug.',
          'Poured from the 5-gallon jug into the 3-gallon jug.',
          'Emptied the 3-gallon jug.',
          'Poured from the 5-gallon jug into the 3-gallon jug.',
          'Filled the 5-gallon jug.',
          'Poured from the 5-gallon jug into the 3-gallon jug.',
        ],
        reasoning: [
          'Start by filling the larger jug.',
          'Transfer water into the 3-gallon jug.',
          'Empty the smaller jug to make room.',
          'Move the remaining water into the 3-gallon jug.',
          'Refill the 5-gallon jug.',
          'Top off the 3-gallon jug to leave 4 gallons.',
          'The 5-gallon jug now holds exactly 4 gallons.',
        ],
      });
    }
  });

  test('map-reduce example decomposes work items and reduces the result', async () => {
    const machine = createMapReduceExample({
      planSubjects: async () => ({
        subjects: ['one', 'two'],
      }),
      writeJoke: async (subject) => `joke:${subject}`,
      chooseBest: async (jokes) => ({
        bestJoke: jokes.at(-1) ?? '',
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({ topic: 'agents' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        subjects: ['one', 'two'],
        jokes: ['joke:one', 'joke:two'],
        bestJoke: 'joke:two',
      });
    }
  });

  test('subflow example composes a child machine inside a parent workflow', async () => {
    const machine = createSubflowExample({
      research: async (topic) => ({
        bullets: [`fact about ${topic}`, `detail about ${topic}`],
      }),
      write: async ({ topic, bullets }) => ({
        draft: `${topic}: ${bullets.join(' / ')}`,
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({ topic: 'agents' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        bullets: ['fact about agents', 'detail about agents'],
        draft: 'agents: fact about agents / detail about agents',
      });
    }
  });

  test('tool-calling example emits live tool activity and completes with output', async () => {
    const machine = createToolCallingExample(async (city) => ({
      forecast: `Rainy in ${city}`,
    }));

    const { createMemoryRunStore, startSession } = await import('./index.js');
    const run = await startSession(machine, {
      store: createMemoryRunStore(),
      input: { city: 'New York' },
    });
    const events: string[] = [];

    run.on('toolCall', (event) => {
      events.push(`call:${(event as { toolName: string }).toolName}`);
    });
    run.on('toolResult', (event) => {
      events.push(`result:${(event as { toolName: string }).toolName}`);
    });

    await new Promise<void>((resolve, reject) => {
      run.on('done', () => resolve());
      run.on('error', (event) => reject((event as { error: unknown }).error));
    });

    expect(events).toEqual(['call:getWeather', 'result:getWeather']);
    expect(run.getSnapshot()).toEqual(
      expect.objectContaining({
        output: { forecast: 'Rainy in New York' },
      })
    );
  });

  test('react agent example loops through a tool and returns a final answer', async () => {
    const { createMemoryRunStore, startSession } = await import('./index.js');
    const agent = createReactAgentExample({
      search: async (query) => `result for ${query}`,
      model: async ({ messages }) => {
        const last = messages.at(-1);

        if (!last || last.role === 'user') {
          return {
            kind: 'tool' as const,
            toolName: 'search',
            input: { query: 'weather in sf' },
            message: 'Searching for weather in sf',
          };
        }

        if (last.role === 'tool') {
          return {
            kind: 'final' as const,
            message: `I found: ${last.content}`,
          };
        }

        return {
          kind: 'final' as const,
          message: 'I could not complete the request.',
        };
      },
    });
    const run = await startSession(agent, {
      store: createMemoryRunStore(),
      input: {
        messages: [{ role: 'user', content: 'weather in sf' }],
      },
    });
    const events: string[] = [];

    run.on('toolCall', (event) => {
      events.push(`call:${(event as { toolName: string }).toolName}`);
    });
    run.on('toolResult', (event) => {
      events.push(`result:${(event as { toolName: string }).toolName}`);
    });

    await new Promise<void>((resolve, reject) => {
      run.on('done', () => resolve());
      run.on('error', (event) => reject((event as { error: unknown }).error));
    });

    expect(events).toEqual(['call:search', 'result:search']);
    expect(run.getSnapshot()).toEqual(
      expect.objectContaining({
        output: expect.objectContaining({
          finalMessage: 'I found: result for weather in sf',
        }),
      })
    );
  });

  test('newspaper example loops through critique and revision', async () => {
    const machine = createNewspaperExample({
      search: async () => ({ searchResults: ['a', 'b', 'c'] }),
      curate: async () => ({ searchResults: ['a', 'b'] }),
      write: async () => ({ article: 'Draft article' }),
      critique: async (_article, revisionCount) => ({
        critique: revisionCount === 0 ? 'Tighten the ending.' : null,
      }),
      revise: async (article, critique) => ({
        article: `${article} Revised: ${critique}`,
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({ topic: 'Robotics' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        topic: 'Robotics',
        article: 'Draft article Revised: Tighten the ending.',
        revisionCount: 1,
        searchResults: ['a', 'b'],
      });
    }
  });

  test('plan-and-execute example creates a plan, executes steps, and synthesizes', async () => {
    const machine = createPlanAndExecuteExample({
      plan: async () => ({
        plan: ['one', 'two'],
      }),
      executeStep: async ({ step }) => ({
        result: `result:${step}`,
      }),
      synthesize: async ({ stepResults }) => ({
        answer: stepResults.join(' + '),
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({ goal: 'ship a feature' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        goal: 'ship a feature',
        plan: ['one', 'two'],
        stepResults: ['result:one', 'result:two'],
        answer: 'result:one + result:two',
      });
    }
  });

  test('raffle example collects entries and reports a winner', async () => {
    const machine = createRaffleExample(async (entries) => ({
      winningEntry: entries[1] ?? '',
      firstRunnerUp: entries[0] ?? '',
      secondRunnerUp: entries[2] ?? '',
      explanation: 'Selected the second entry for the demo.',
    }));

    const pending = await machine.execute(machine.getInitialState());
    expect(pending.status).toBe('pending');

    if (pending.status === 'pending') {
      let state = machine.transition(pending.state, {
        type: 'user.entry',
        entry: 'TypeScript',
      });
      state = machine.transition(state, {
        type: 'user.entry',
        entry: 'Rust',
      });
      state = machine.transition(state, {
        type: 'user.entry',
        entry: 'Go',
      });
      state = machine.transition(state, { type: 'user.draw' });

      const result = await machine.execute(state);
      expect(result.status).toBe('done');
      if (result.status === 'done') {
        expect(result.output).toEqual({
          entries: ['TypeScript', 'Rust', 'Go'],
          winner: 'Rust',
          firstRunnerUp: 'TypeScript',
          secondRunnerUp: 'Go',
          explanation: 'Selected the second entry for the demo.',
        });
      }
    }
  });

  test('reflection example loops through critique and revision until ready', async () => {
    const machine = createReflectionExample({
      draft: async () => ({
        draft: 'Initial draft',
      }),
      reflect: async ({ revisionCount }) => ({
        feedback: revisionCount === 0 ? 'Clarify the main point.' : null,
      }),
      revise: async ({ draft, feedback }) => ({
        draft: `${draft} Revised: ${feedback}`,
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({ task: 'Explain event sourcing simply.' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        task: 'Explain event sourcing simply.',
        draft: 'Initial draft Revised: Clarify the main point.',
        feedback: null,
        revisionCount: 1,
      });
    }
  });

  test('river crossing example moves every item safely to the right bank', async () => {
    const machine = createRiverCrossingExample();
    const result = await machine.execute(machine.getInitialState());

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        leftBank: [],
        rightBank: ['cabbage', 'goat', 'wolf'],
        steps: [
          'The farmer took the goat across the river.',
          'The farmer crossed the river alone.',
          'The farmer took the wolf across the river.',
          'The farmer took the goat across the river.',
          'The farmer took the cabbage across the river.',
          'The farmer crossed the river alone.',
          'The farmer took the goat across the river.',
        ],
        reasoning: [
          'Move the goat first so it is not left with the cabbage.',
          'Return alone to ferry another item.',
          'Take the wolf across while the goat waits safely alone.',
          'Bring the goat back so the wolf is not left with it.',
          'Take the cabbage across now that the goat is with you.',
          'Return alone to fetch the goat.',
          'Bring the goat across to complete the crossing.',
          'Everyone is safely across.',
        ],
      });
    }
  });

  test('tutor example gives feedback and a response', async () => {
    const machine = createTutorExample({
      teach: async () => ({ instruction: 'Use a more complete sentence.' }),
      respond: async () => ({ response: 'Claro, puedo ayudarte.' }),
    });

    const result = await machine.execute(
      machine.getInitialState({ message: 'Yo necesito ayuda' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        conversation: [
          'User: Yo necesito ayuda',
          'Tutor: Claro, puedo ayudarte.',
        ],
        feedback: 'Use a more complete sentence.',
        response: 'Claro, puedo ayudarte.',
      });
    }
  });
});
