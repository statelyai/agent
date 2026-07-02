import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  initialTransition,
  transition,
  waitFor,
  type EventObject,
} from 'xstate';
import {
  type AgentRequest,
  assistantMessage,
  createAgentSchemas,
  executeAgentRequest,
  getAgentRequests,
  transitionResult,
  type AgentTextRequest,
  type AgentTools,
} from '../../src/index.js';
import { setupAgent } from '../../src/index.js';

export async function runDinavinterScreenSetBuilderExample() {
  const fieldSchema = z.object({
    type: z.enum(['text', 'email', 'password', 'submit']),
    name: z.string(),
    label: z.string(),
  });
  const screenDraftSchema = z.object({
    title: z.string(),
    fields: z.array(fieldSchema),
  });
  const schemas = createAgentSchemas({
    context: z.object({
      request: z.string(),
      draft: screenDraftSchema.nullable(),
    }),
    input: z.object({ request: z.string() }),
    output: screenDraftSchema,
  });
  const agent = setupAgent({
    schemas,
    requests: {
      draftScreen: {
        schemas: {
          input: z.object({ request: z.string() }),
          output: screenDraftSchema,
        },
        model: 'openai/gpt-5.4-nano',
        system: 'Create a form screen draft from the user request.',
        prompt: ({ input }) => input.request,
      },
    },
  });
  const machine = agent.createMachine({
    context: ({ input }) => ({ request: input.request, draft: null }),
    initial: 'drafting',
    states: {
      drafting: {
        invoke: {
          id: 'draftScreen',
          src: 'draftScreen',
          input: ({ context }) => ({ request: context.request }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { draft: output },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) =>
          (context as { draft: z.infer<typeof screenDraftSchema> | null }).draft
          ?? { title: '', fields: [] },
      },
    },
  });

  let [snapshot, actions] = initialTransition(machine, {
    request: 'Build a signup wizard.',
  });
  const [request] = getAgentRequests(actions, {
    snapshot,
    schemas,
    actors: agent.requests,
  });
  if (request?.kind !== 'text') {
    throw new Error('Expected a text request.');
  }

  const output = await executeAgentRequest(request, {
    generateText: async (
      request: AgentTextRequest & { tools: AgentTools },
    ) => {
      assert.equal(request.outputSchema, agent.requests.draftScreen.schemas.output);
      assert.equal(request.prompt, 'Build a signup wizard.');
      return {
        output: {
          title: 'Signup',
          fields: [
            { type: 'email', name: 'email', label: 'Email' },
            { type: 'password', name: 'password', label: 'Password' },
            { type: 'submit', name: 'submit', label: 'Create account' },
          ],
        },
      };
    },
  });

  [snapshot, actions] = transitionResult(machine, snapshot, request!, output);

  assert.deepEqual(getAgentRequests(actions, {
    snapshot,
    schemas,
    actors: agent.requests,
  }), []);
  assert.deepEqual(snapshot.output, {
    title: 'Signup',
    fields: [
      { type: 'email', name: 'email', label: 'Email' },
      { type: 'password', name: 'password', label: 'Password' },
      { type: 'submit', name: 'submit', label: 'Create account' },
    ],
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runDinavinterScreenSetBuilderExample();
}
