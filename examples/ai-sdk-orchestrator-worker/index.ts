import { z } from 'zod';
import {
  createActor,
  createAsyncLogic,
  setup,
  toPromise,
  type AnyActorLogic,
} from 'xstate';
import { createAgentSchemas, createTextLogic } from '../../src/index.js';
import { createAiSdkTextActor } from '../ai-sdk-host/index.js';

const implementationPlanSchema = z.object({
  files: z.array(z.object({
    purpose: z.string(),
    filePath: z.string(),
    changeType: z.enum(['create', 'modify', 'delete']),
  })),
  estimatedComplexity: z.enum(['low', 'medium', 'high']),
});

const fileChangeSchema = z.object({
  filePath: z.string(),
  changeType: z.enum(['create', 'modify', 'delete']),
  explanation: z.string(),
  code: z.string(),
});

export const planImplementation = createTextLogic({
  schemas: {
    input: z.object({ featureRequest: z.string() }),
    output: implementationPlanSchema,
  },
  model: 'openai/gpt-4.1-mini',
  system: 'Plan feature implementations as file-level work.',
  prompt: ({ input }) => input.featureRequest,
});

const agent = setup({
  schemas: createAgentSchemas({
    context: z.object({
      featureRequest: z.string(),
      plan: implementationPlanSchema.nullable(),
      changes: z.array(fileChangeSchema),
    }),
    input: z.object({ featureRequest: z.string() }),
    output: z.object({
      plan: implementationPlanSchema,
      changes: z.array(fileChangeSchema),
    }),
  }),
  actorSources: {
    planImplementation,
    implementPlannedFiles: createAsyncLogic<
      z.infer<typeof fileChangeSchema>[],
      {
        featureRequest: string;
        plan: z.infer<typeof implementationPlanSchema>;
      }
    >({
      run: async ({ input }) =>
        Promise.all(input.plan.files.map(async (file) => ({
          filePath: file.filePath,
          changeType: file.changeType,
          explanation: `Implement ${file.purpose} for ${input.featureRequest}`,
          code: `// ${file.changeType} ${file.filePath}`,
        }))),
    }),
  },
});

export const aiSdkOrchestratorWorkerMachine = agent.createMachine({
  id: 'ai-sdk-orchestrator-worker',
  context: ({ input }) => ({
    featureRequest: input.featureRequest,
    plan: null,
    changes: [],
  }),
  output: ({ context }) => ({
    plan: context.plan ?? { files: [], estimatedComplexity: 'low' },
    changes: context.changes,
  }),
  initial: 'planning',
  states: {
    planning: {
      invoke: {
        src: 'planImplementation',
        input: ({ context }) => ({ featureRequest: context.featureRequest }),
        onDone: ({ output }) => ({
          target: 'implementing',
          context: { plan: output },
        }),
      },
    },
    implementing: {
      invoke: {
        src: 'implementPlannedFiles',
        input: ({ context }) => ({
          featureRequest: context.featureRequest,
          plan: context.plan ?? { files: [], estimatedComplexity: 'low' },
        }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { changes: output },
        }),
      },
    },
    done: { type: 'final' },
  },
});

export async function runAiSdkOrchestratorWorkerExample() {
  const actor = createActor(
    aiSdkOrchestratorWorkerMachine.provide({
      actorSources: {
        planImplementation: createAiSdkTextActor(planImplementation),
      },
    }) as unknown as AnyActorLogic,
    { input: { featureRequest: 'Add settings page' } },
  );
  actor.start();
  return await toPromise(actor);
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  console.log(await runAiSdkOrchestratorWorkerExample());
}
