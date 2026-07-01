/**
 * Vercel AI SDK sub-agents as host-owned tools.
 *
 * The XState machine only sees tools on one request. The host decides those
 * tools delegate to AI SDK ToolLoopAgent workers.
 *
 * Run: OPENAI_API_KEY=... node --import tsx examples/ai-sdk-sub-agents/index.ts
 */
import assert from 'node:assert/strict';
import { openai } from '@ai-sdk/openai';
import {
  generateText,
  Output,
  stepCountIs,
  ToolLoopAgent,
  type Agent,
  type LanguageModel,
} from 'ai';
import { z } from 'zod';
import { createActor, toPromise, type AnyStateMachine } from 'xstate';
import { setupAgent, type AgentTool, type AgentToolExecute } from '../../src/index.js';
import { toAiSdkTools } from '../../src/ai-sdk/index.js';

const answerSchema = z.object({ answer: z.string() });

type SubAgentName = 'researcher' | 'writer';
type SubAgents = Record<SubAgentName, Agent>;
type SubAgentWorkflow = {
  agent: { requests: Record<string, any> };
  machine: AnyStateMachine;
};

export function createAiSdkSubAgents(model: LanguageModel): SubAgents {
  return {
    researcher: new ToolLoopAgent({
      id: 'researcher',
      model,
      instructions: 'Research the topic. Return concise notes.',
      stopWhen: stepCountIs(3),
    }),
    writer: new ToolLoopAgent({
      id: 'writer',
      model,
      instructions: 'Turn notes into a short final answer.',
      stopWhen: stepCountIs(3),
    }),
  };
}

function createSubAgentExecute(
  subAgents: SubAgents,
  name: SubAgentName,
): AgentToolExecute {
  return async (input) => {
    const prompt = z.object({ prompt: z.string() }).parse(input).prompt;
    const result = await subAgents[name].generate({ prompt });
    return result.text;
  };
}

function executeTool(tool: AgentTool | undefined, input: unknown) {
  return typeof tool === 'function' ? tool(input) : tool?.execute?.(input);
}

export function createAiSdkSubAgentWorkflow(
  subAgents: SubAgents,
): SubAgentWorkflow {
  const agent = setupAgent({
    context: z.object({
      task: z.string(),
      answer: z.string().nullable(),
    }),
    input: z.object({ task: z.string() }),
    output: answerSchema,
    requests: {
      supervise: {
        schemas: {
          input: z.object({ task: z.string() }),
          output: answerSchema,
        },
        model: 'openai/gpt-4.1-mini',
        system: [
          'You are a supervisor.',
          'Use askResearcher for facts and askWriter for the final wording.',
        ].join(' '),
        prompt: ({ input }) => input.task,
        tools: {
          askResearcher: {
            description: 'Ask the researcher sub-agent for notes.',
            inputSchema: z.object({ prompt: z.string() }),
            execute: createSubAgentExecute(subAgents, 'researcher'),
          },
          askWriter: {
            description: 'Ask the writer sub-agent for final wording.',
            inputSchema: z.object({ prompt: z.string() }),
            execute: createSubAgentExecute(subAgents, 'writer'),
          },
        },
      },
    },
  });

  const machine = agent.createMachine({
    id: 'ai-sdk-sub-agents',
    context: ({ input }) => ({ task: input.task, answer: null }),
    initial: 'supervising',
    states: {
      supervising: {
        invoke: {
          src: 'supervise',
          input: ({ context }) => ({ task: context.task }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { answer: output.answer },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ answer: context.answer ?? '' }),
      },
    },
  });

  return { agent, machine };
}

export async function runAiSdkSubAgentsDemo(task: string) {
  const model = openai('gpt-4.1-mini');
  const { agent, machine } = createAiSdkSubAgentWorkflow(
    createAiSdkSubAgents(model),
  );

  const actor = createActor(
    machine.provide({
      actorSources: {
        supervise: agent.requests.supervise.withExecutor(
          async ({ request, signal }: any) => {
            const { output } = await generateText({
              model,
              system: request.system,
              prompt: request.prompt ?? '',
              tools: toAiSdkTools(request.tools ?? {}),
              output: Output.object({ schema: answerSchema }),
              stopWhen: stepCountIs(8),
              abortSignal: signal,
            });
            return output;
          },
        ),
      },
    }) as any,
    { input: { task } },
  );

  actor.start();
  await toPromise(actor as any);
  return (actor.getSnapshot() as any).output;
}

export async function runAiSdkSubAgentsDeterministicExample() {
  const calls: string[] = [];
  const fakeSubAgents: SubAgents = {
    researcher: {
      version: 'agent-v1',
      id: 'researcher',
      tools: {},
      generate: async ({ prompt }) => {
        calls.push(`researcher:${prompt}`);
        return { text: `notes:${prompt}` } as any;
      },
      stream: async () => ({}) as any,
    },
    writer: {
      version: 'agent-v1',
      id: 'writer',
      tools: {},
      generate: async ({ prompt }) => {
        calls.push(`writer:${prompt}`);
        return { text: `final:${prompt}` } as any;
      },
      stream: async () => ({}) as any,
    },
  };
  const { agent, machine } = createAiSdkSubAgentWorkflow(fakeSubAgents);

  const actor = createActor(
    machine.provide({
      actorSources: {
        supervise: agent.requests.supervise.withExecutor(async ({ request }: any) => {
          const notes = await executeTool(request.tools?.askResearcher, {
            prompt: request.prompt,
          });
          const answer = await executeTool(request.tools?.askWriter, {
            prompt: String(notes),
          });
          return { answer: String(answer) };
        }),
      },
    }) as any,
    { input: { task: 'compose agent note' } },
  );
  actor.start();
  await toPromise(actor as any);

  assert.deepEqual(calls, [
    'researcher:compose agent note',
    'writer:notes:compose agent note',
  ]);
  assert.deepEqual((actor.getSnapshot() as any).output, {
    answer: 'final:notes:compose agent note',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    await runAiSdkSubAgentsDeterministicExample();
  } else {
    console.log(await runAiSdkSubAgentsDemo('Explain composable agents.'));
  }
}
