import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { restoreSession, startSession } from './index.js';

import {
  createAiSdkExample,
  createChatbotExample,
  AgentNetworkDurableObject,
  createCloudflareAgentRunStore,
  createDurableObjectRunStore,
  createAdapterExample,
  createBranchingExample,
  createClassifyExample,
  createConditionalSubflowExample,
  createCustomerServiceSimExample,
  createDecideExample,
  createChatbotMessagesExample,
  createEmailExample,
  createErrorRetryExample,
  createHitlExample,
  createPersistenceExample,
  createPersistenceSessionHttpHandler,
  createStreamingSessionHttpController,
  createJokeExample,
  createJugsExample,
  createMapReduceExample,
  createMultiAgentNetworkExample,
  createNewspaperExample,
  runPersistenceExample,
  runPersistentMultiAgentNetworkExample,
  runPersistentStreamingExample,
  runPersistentSupervisorExample,
  createPlanAndExecuteExample,
  createRaffleExample,
  createRagExample,
  createReactAgentExample,
  createRewooExample,
  createReflectionExample,
  createRiverCrossingExample,
  createSimpleExample,
  createSqlAgentExample,
  createSubflowExample,
  createSupervisorExample,
  createToolCallingExample,
  createTutorExample,
} from '../examples/index.js';

function createSseReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async next(): Promise<{ event: string; data: unknown }> {
      while (true) {
        const match = buffer.match(/^event: ([^\n]+)\ndata: ([^\n]+)\n\n/);
        if (match) {
          buffer = buffer.slice(match[0].length);
          return {
            event: match[1]!,
            data: JSON.parse(match[2]!),
          };
        }

        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error('SSE stream closed before the next event was available.');
        }

        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },

    async cancel() {
      await reader.cancel();
    },
  };
}

describe('curated examples', () => {
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

  test('ai sdk example routes and drafts a structured reply', async () => {
    const machine = createAiSdkExample({
      adapter: {
        decide: async () => ({
          choice: 'billing',
          data: { confidence: 0.93 },
        }),
      },
      draftReply: async ({ route, confidence, message }) => ({
        subject: `${route.toUpperCase()} reply`,
        body: `${message} :: ${confidence.toFixed(2)}`,
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({ message: 'Please refund invoice 123.' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        route: 'billing',
        confidence: 0.93,
        subject: 'BILLING reply',
        body: 'Please refund invoice 123. :: 0.93',
      });
    }
  });

  test('chatbot messages example accumulates structured conversation turns', async () => {
    const machine = createChatbotMessagesExample(async (messages) => ({
      message: {
        role: 'assistant',
        content: `Replying to: ${messages.at(-1)?.content ?? ''}`,
      },
    }));

    const afterUserMessage = machine.transition(machine.getInitialState(), {
      type: 'messages.user',
      message: {
        role: 'user',
        content: 'Hello there',
      },
    });
    const result = await machine.execute(afterUserMessage);

    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.context.messages).toEqual([
        { role: 'user', content: 'Hello there' },
        { role: 'assistant', content: 'Replying to: Hello there' },
      ]);
      expect(result.context.finalMessage).toEqual({
        role: 'assistant',
        content: 'Replying to: Hello there',
      });
    }
  });

  test('rag example retrieves context and produces a grounded answer', async () => {
    const machine = createRagExample({
      retrieve: async (question) => ({
        documents: [
          { id: 'doc-1', content: `${question} :: first fact` },
          { id: 'doc-2', content: `${question} :: second fact` },
        ],
      }),
      answer: async ({ question, documents }) => ({
        answer: `${question} => ${documents.map((document) => document.content).join(' | ')}`,
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({ question: 'What is LangGraph?' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        question: 'What is LangGraph?',
        documents: [
          { id: 'doc-1', content: 'What is LangGraph? :: first fact' },
          { id: 'doc-2', content: 'What is LangGraph? :: second fact' },
        ],
        answer:
          'What is LangGraph? => What is LangGraph? :: first fact | What is LangGraph? :: second fact',
      });
    }
  });

  test('persistence example restores a durable session to the same final snapshot', async () => {
    const result = await runPersistenceExample(
      { request: 'Approve the annual budget summary.' },
      {
        summarize: async ({ request, approved }) => ({
          summary: `${request} :: approved=${String(approved)}`,
        }),
      }
    );

    expect(result.liveSnapshot).toEqual(result.restoredSnapshot);
    expect(result.liveSnapshot).toEqual(
      expect.objectContaining({
        value: 'done',
        status: 'done',
        output: {
          request: 'Approve the annual budget summary.',
          approved: true,
          summary: 'Approve the annual budget summary. :: approved=true',
        },
      })
    );
  });

  test('cloudflare durable object example store persists journal and snapshots', async () => {
    const storage = new Map<string, unknown>();
    const store = createDurableObjectRunStore({
      async get(key) {
        return storage.get(key) as never;
      },
      async put(key, value) {
        storage.set(key, value);
      },
    });

    await store.append('session-1', {
      type: 'xstate.init',
      at: 1,
    });
    await store.append('session-1', {
      type: 'approve',
      at: 2,
    });
    await store.saveSnapshot({
      sessionId: 'session-1',
      afterSequence: 2,
      snapshot: {
        value: 'done',
        context: {},
        status: 'done',
        createdAt: 2,
        sessionId: 'session-1',
        input: {},
      },
      createdAt: 2,
    });

    await expect(store.loadEvents('session-1')).resolves.toEqual([
      expect.objectContaining({ sequence: 1, type: 'xstate.init' }),
      expect.objectContaining({ sequence: 2, type: 'approve' }),
    ]);
    await expect(store.loadLatestSnapshot('session-1')).resolves.toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        afterSequence: 2,
      })
    );
  });

  test('cloudflare agents example store persists durable sessions in synced state', async () => {
    let state = {
      sessions: {},
    };
    const store = createCloudflareAgentRunStore({
      getState: () => state,
      setState: async (nextState) => {
        state = nextState;
      },
    });
    const machine = createPersistenceExample(async ({ request, approved }) => ({
      summary: `${request} :: approved=${String(approved)}`,
    }));

    const run = await startSession(machine, {
      store,
      input: {
        request: 'Approve the Cloudflare rollout.',
      },
    });

    await run.send({ type: 'approve' });

    const restored = await restoreSession(machine, {
      sessionId: run.sessionId,
      store,
    });

    expect(restored.getSnapshot()).toEqual(
      expect.objectContaining({
        value: 'done',
        status: 'done',
        output: {
          request: 'Approve the Cloudflare rollout.',
          approved: true,
          summary: 'Approve the Cloudflare rollout. :: approved=true',
        },
      })
    );
    expect(Object.keys(state.sessions)).toEqual([run.sessionId]);
  });

  test('http session example exposes start, send, and status over Request/Response', async () => {
    const handle = createPersistenceSessionHttpHandler({
      summarize: async ({ request, approved }) => ({
        summary: `${request} :: approved=${String(approved)}`,
      }),
    });

    const startResponse = await handle(
      new Request('https://agent.test/sessions', {
        method: 'POST',
        body: JSON.stringify({
          request: 'Approve the annual budget summary.',
        }),
        headers: {
          'content-type': 'application/json',
        },
      })
    );
    const startBody = await startResponse.json() as {
      sessionId: string;
      snapshot: { value: string; status: string };
    };

    expect(startBody.snapshot).toEqual(
      expect.objectContaining({
        value: 'review',
        status: 'active',
      })
    );

    const sendResponse = await handle(
      new Request(`https://agent.test/sessions/${startBody.sessionId}/events`, {
        method: 'POST',
        body: JSON.stringify({ type: 'approve' }),
        headers: {
          'content-type': 'application/json',
        },
      })
    );
    const sendBody = await sendResponse.json() as {
      snapshot: {
        value: string;
        status: string;
        output: {
          request: string;
          approved: boolean;
          summary: string;
        };
      };
    };

    expect(sendBody.snapshot).toEqual(
      expect.objectContaining({
        value: 'done',
        status: 'done',
        output: {
          request: 'Approve the annual budget summary.',
          approved: true,
          summary: 'Approve the annual budget summary. :: approved=true',
        },
      })
    );

    const statusResponse = await handle(
      new Request(`https://agent.test/sessions/${startBody.sessionId}`, {
        method: 'GET',
      })
    );
    const statusBody = await statusResponse.json() as {
      snapshot: {
        value: string;
        status: string;
        output: {
          request: string;
          approved: boolean;
          summary: string;
        };
      };
    };

    expect(statusBody.snapshot).toEqual(sendBody.snapshot);
  });

  test('http streaming session example reconnects with only new SSE parts after restore', async () => {
    const controller = createStreamingSessionHttpController();

    const startResponse = await controller.handle(
      new Request('https://agent.test/sessions', {
        method: 'POST',
        body: JSON.stringify({
          streamId: 'stream-1',
          text: 'hello',
        }),
        headers: {
          'content-type': 'application/json',
        },
      })
    );
    const startBody = await startResponse.json() as {
      sessionId: string;
    };

    const firstStreamResponse = await controller.handle(
      new Request(`https://agent.test/sessions/${startBody.sessionId}/stream`)
    );
    const firstReader = createSseReader(firstStreamResponse);

    controller.advance('stream-1');

    await expect(firstReader.next()).resolves.toEqual({
      event: 'textPart',
      data: {
        type: 'textPart',
        delta: 'hel',
      },
    });

    await firstReader.cancel();
    controller.dropActiveSession(startBody.sessionId);

    const secondStreamResponse = await controller.handle(
      new Request(`https://agent.test/sessions/${startBody.sessionId}/stream`)
    );
    const secondReader = createSseReader(secondStreamResponse);

    controller.advance('stream-1');

    await expect(secondReader.next()).resolves.toEqual({
      event: 'textPart',
      data: {
        type: 'textPart',
        delta: 'lo',
      },
    });
    await expect(secondReader.next()).resolves.toEqual({
      event: 'done',
      data: {
        text: 'hello',
      },
    });

    const statusResponse = await controller.handle(
      new Request(`https://agent.test/sessions/${startBody.sessionId}`)
    );
    const statusBody = await statusResponse.json() as {
      snapshot: {
        value: string;
        status: string;
        output: { text: string };
      };
    };

    expect(statusBody.snapshot).toEqual(
      expect.objectContaining({
        value: 'done',
        status: 'done',
        output: { text: 'hello' },
      })
    );
  });

  test('cloudflare durable network example restores and settles a network run', async () => {
    const storage = new Map<string, unknown>();
    const firstInstance = new AgentNetworkDurableObject({
      storage: {
        async get(key) {
          return storage.get(key) as never;
        },
        async put(key, value) {
          storage.set(key, value);
        },
      },
    });

    const startResponse = await firstInstance.fetch(
      new Request('https://example.com/start', {
        method: 'POST',
        body: JSON.stringify({ topic: 'durable networks' }),
      })
    );
    const started = await startResponse.json() as {
      sessionId: string;
      snapshot: { status: string };
    };

    const resumedInstance = new AgentNetworkDurableObject({
      storage: {
        async get(key) {
          return storage.get(key) as never;
        },
        async put(key, value) {
          storage.set(key, value);
        },
      },
    });
    const resumeResponse = await resumedInstance.fetch(
      new Request(
        `https://example.com/resume?sessionId=${started.sessionId}`,
        { method: 'POST' }
      )
    );
    const resumed = await resumeResponse.json() as {
      sessionId: string;
      snapshot: {
        status: string;
        output: {
          topic: string;
          handoffs: string[];
        };
      };
    };

    expect(started.sessionId).toBe(resumed.sessionId);
    expect(resumed.snapshot.status).toBe('done');
    expect(resumed.snapshot.output).toEqual(
      expect.objectContaining({
        topic: 'durable networks',
        handoffs: [
          'researcher:collect the strongest supporting facts',
          'writer:turn the current notes into a concise summary',
        ],
      })
    );
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

  test('error retry example recovers from transient invoke failures', async () => {
    const machine = createErrorRetryExample(async ({ attempt }) => {
      if (attempt === 1) {
        throw new Error('temporary outage');
      }

      return { answer: 'Recovered answer.' };
    });

    const result = await machine.execute(
      machine.getInitialState({ question: 'Can this retry?' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        answer: 'Recovered answer.',
        attempts: 2,
        errors: ['temporary outage'],
      });
    }
  });

  test('conditional subflow example routes directly into the requested child flow', async () => {
    const machine = createConditionalSubflowExample({
      draft: async ({ topic, bullets }) => ({
        draft: `${topic}: ${bullets.join(', ')}`,
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({
        topic: 'state machines',
        mode: 'draft',
        bullets: ['deterministic', 'resumable'],
      })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        mode: 'draft',
        bullets: ['deterministic', 'resumable'],
        draft: 'state machines: deterministic, resumable',
      });
    }
  });

  test('persistent multi-agent network example restores from a mid-handoff snapshot', async () => {
    let step = 0;
    const result = await runPersistentMultiAgentNetworkExample(
      { topic: 'resumable coordination' },
      {
        adapter: {
          decide: async () => {
            step += 1;

            if (step === 1) {
              return {
                choice: 'research',
                data: { focus: 'collect durable coordination notes' },
              };
            }

            if (step === 2) {
              return {
                choice: 'write',
                data: { angle: 'produce the final coordination memo' },
              };
            }

            return {
              choice: 'finalize',
              data: {},
            };
          },
        },
        research: async ({ topic, focus }) => ({
          notes: [`${topic}:${focus}:a`, `${topic}:${focus}:b`],
        }),
        write: async ({ topic, notes, angle }) => ({
          draft: `${topic} | ${angle} | ${notes.join(' / ')}`,
        }),
      }
    );

    expect(result.restoredSnapshot).toEqual(result.liveSnapshot);
    expect(result.liveSnapshot).toEqual(
      expect.objectContaining({
        value: 'done',
        output: {
          topic: 'resumable coordination',
          notes: [
            'resumable coordination:collect durable coordination notes:a',
            'resumable coordination:collect durable coordination notes:b',
          ],
          draft:
            'resumable coordination | produce the final coordination memo | resumable coordination:collect durable coordination notes:a / resumable coordination:collect durable coordination notes:b',
          handoffs: [
            'researcher:collect durable coordination notes',
            'writer:produce the final coordination memo',
          ],
        },
      })
    );
  });

  test('persistent supervisor example restores from a persisted retry handoff', async () => {
    let decisions = 0;

    const result = await runPersistentSupervisorExample(
      { request: 'Reverse the duplicate subscription charge.' },
      {
        adapter: {
          decide: async () => {
            decisions += 1;

            if (decisions === 1) {
              return {
                choice: 'retry',
                data: {
                  instruction: 'Retry using the verified billing email on file.',
                },
              };
            }

            return {
              choice: 'escalate',
              data: {
                reason: 'Escalate to billing because the account is still ambiguous.',
              },
            };
          },
        },
        handle: async ({ attempt, instruction }) => ({
          status: 'blocked' as const,
          issue:
            attempt === 1
              ? 'Missing account identifier.'
              : `Still blocked after retry: ${instruction}`,
        }),
        maxAttempts: 2,
      }
    );

    expect(result.liveSnapshot).toEqual(result.restoredSnapshot);
    expect(result.liveSnapshot).toEqual(
      expect.objectContaining({
        value: 'done',
        status: 'done',
        output: {
          request: 'Reverse the duplicate subscription charge.',
          status: 'escalated',
          resolution: null,
          escalationReason:
            'Escalate to billing because the account is still ambiguous.',
          attemptCount: 2,
          history: [
            'worker:1:blocked:Missing account identifier.',
            'supervisor:retry:Retry using the verified billing email on file.',
            'worker:2:blocked:Still blocked after retry: Retry using the verified billing email on file.',
            'supervisor:escalate:Escalate to billing because the account is still ambiguous.',
          ],
        },
      })
    );
  });

  test('persistent streaming example resumes with only new live parts after restore', async () => {
    const result = await runPersistentStreamingExample();

    expect(result.initialParts).toEqual(['hel']);
    expect(result.restoredParts).toEqual(['lo']);
    expect(result.initialSnapshot).toEqual(
      expect.objectContaining({
        value: 'writing',
        status: 'active',
      })
    );
    expect(result.restoredSnapshot).toEqual(
      expect.objectContaining({
        value: 'done',
        status: 'done',
        output: { text: 'hello' },
      })
    );
    expect(result.journal.map((event) => event.type)).toEqual([
      'xstate.init',
      'xstate.done.invoke.writing',
    ]);
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

  test('multi-agent network example coordinates specialist handoffs through a supervisor state', async () => {
    let step = 0;

    const machine = createMultiAgentNetworkExample({
      adapter: {
        decide: async () => {
          step += 1;

          if (step === 1) {
            return {
              choice: 'research',
              data: { focus: 'collect technical notes' },
            };
          }

          if (step === 2) {
            return {
              choice: 'write',
              data: { angle: 'produce a short memo' },
            };
          }

          return {
            choice: 'finalize',
            data: {},
          };
        },
      },
      research: async ({ topic, focus }) => ({
        notes: [`${topic}:${focus}:a`, `${topic}:${focus}:b`],
      }),
      write: async ({ topic, notes, angle }) => ({
        draft: `${topic} | ${angle} | ${notes.join(' / ')}`,
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({ topic: 'durable agents' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        topic: 'durable agents',
        notes: [
          'durable agents:collect technical notes:a',
          'durable agents:collect technical notes:b',
        ],
        draft:
          'durable agents | produce a short memo | durable agents:collect technical notes:a / durable agents:collect technical notes:b',
        handoffs: [
          'researcher:collect technical notes',
          'writer:produce a short memo',
        ],
      });
    }
  });

  test('tool-calling example emits live tool activity and completes with output', async () => {
    const machine = createToolCallingExample(async (city, emitProgress) => {
      emitProgress({
        toolName: 'getWeather',
        message: `Checking radar for ${city}`,
        step: 1,
      });
      emitProgress({
        toolName: 'getWeather',
        message: `Preparing forecast for ${city}`,
        step: 2,
      });

      return {
        forecast: `Rainy in ${city}`,
      };
    });

    const { createMemoryRunStore, startSession } = await import('./index.js');
    const run = await startSession(machine, {
      store: createMemoryRunStore(),
      input: { city: 'New York' },
    });
    const events: string[] = [];

    run.on('toolCall', (event) => {
      events.push(`call:${event.toolName}`);
    });
    run.on('toolProgress', (event) => {
      events.push(`progress:${event.toolName}:${event.step}`);
    });
    run.on('toolResult', (event) => {
      events.push(`result:${event.toolName}`);
    });

    await new Promise<void>((resolve, reject) => {
      run.onDone(() => resolve());
      run.onError((event) => reject(event.error));
    });

    expect(events).toEqual([
      'call:getWeather',
      'progress:getWeather:1',
      'progress:getWeather:2',
      'result:getWeather',
    ]);
    expect(run.getSnapshot()).toEqual(
      expect.objectContaining({
        output: { forecast: 'Rainy in New York' },
      })
    );
  });

  test('sql-agent example retries after a bad query and then answers from rows', async () => {
    let decisions = 0;

    const machine = createSqlAgentExample({
      adapter: {
        decide: async () => {
          decisions += 1;

          if (decisions === 1) {
            return {
              choice: 'query',
              data: {
                query: 'SELECT total FROM invoices WHERE customer = "Acme"',
              },
            };
          }

          if (decisions === 2) {
            return {
              choice: 'query',
              data: {
                query: "SELECT customer, total FROM invoices WHERE customer = 'Acme'",
              },
            };
          }

          return {
            choice: 'answer',
            data: {
              answer: 'Acme has one invoice total of 42.',
            },
          };
        },
      },
      executeQuery: async ({ query }) => {
        if (query.includes('"Acme"')) {
          return {
            status: 'error' as const,
            error: 'SQL syntax error near double quotes.',
          };
        }

        return {
          status: 'success' as const,
          rows: [{ customer: 'Acme', total: 42 }],
        };
      },
    });

    const result = await machine.execute(
      machine.getInitialState({
        question: 'What is Acme owed?',
        schema: 'invoices(customer text, total integer)',
      })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        question: 'What is Acme owed?',
        schema: 'invoices(customer text, total integer)',
        answer: 'Acme has one invoice total of 42.',
        latestRows: [{ customer: 'Acme', total: 42 }],
        latestError: null,
        queryHistory: [
          'SELECT total FROM invoices WHERE customer = "Acme"',
          "SELECT customer, total FROM invoices WHERE customer = 'Acme'",
        ],
      });
    }
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
      events.push(`call:${event.toolName}`);
    });
    run.on('toolResult', (event) => {
      events.push(`result:${event.toolName}`);
    });

    await new Promise<void>((resolve, reject) => {
      run.onDone(() => resolve());
      run.onError((event) => reject(event.error));
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

  test('rewoo example plans named steps, executes them with references, and solves the objective', async () => {
    const machine = createRewooExample({
      plan: async () => ({
        steps: [
          {
            id: 'E1',
            instruction: 'Collect a fact',
            input: 'LangGraphJS',
          },
          {
            id: 'E2',
            instruction: 'Summarize the fact',
            input: 'Use #E1 in one concise sentence',
          },
        ],
      }),
      executeStep: async ({ step, resolvedInput }) => ({
        result: `${step.id}:${resolvedInput}`,
      }),
      solve: async ({ resultsById }) => ({
        answer: `${resultsById.E1} | ${resultsById.E2}`,
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({ objective: 'understand the repo' })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        objective: 'understand the repo',
        steps: [
          {
            id: 'E1',
            instruction: 'Collect a fact',
            input: 'LangGraphJS',
          },
          {
            id: 'E2',
            instruction: 'Summarize the fact',
            input: 'Use #E1 in one concise sentence',
          },
        ],
        resultsById: {
          E1: 'E1:LangGraphJS',
          E2: 'E2:Use E1:LangGraphJS in one concise sentence',
        },
        answer: 'E1:LangGraphJS | E2:Use E1:LangGraphJS in one concise sentence',
      });
    }
  });

  test('supervisor example retries a blocked worker and can still resolve the request', async () => {
    let decisions = 0;

    const machine = createSupervisorExample({
      adapter: {
        decide: async () => {
          decisions += 1;

          return {
            choice: decisions === 1 ? 'retry' : 'escalate',
            data:
              decisions === 1
                ? { instruction: 'Retry using the customer email on file.' }
                : { reason: 'Escalate to billing.' },
          };
        },
      },
      handle: async ({ attempt, instruction }) =>
        attempt === 1
          ? {
              status: 'blocked' as const,
              issue: 'Missing account identifier.',
            }
          : {
              status: 'resolved' as const,
              response: `Resolved after retry: ${instruction}`,
            },
    });

    const result = await machine.execute(
      machine.getInitialState({
        request: 'Fix the duplicate subscription charge.',
      })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output).toEqual({
        request: 'Fix the duplicate subscription charge.',
        status: 'resolved',
        resolution: 'Resolved after retry: Retry using the customer email on file.',
        escalationReason: null,
        attemptCount: 2,
        history: [
          'worker:1:blocked:Missing account identifier.',
          'supervisor:retry:Retry using the customer email on file.',
          'worker:2:resolved:Resolved after retry: Retry using the customer email on file.',
        ],
      });
    }
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
