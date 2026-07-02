import { z } from 'zod';
import { setup } from 'xstate';
import { createAgentSchemas, createTextLogic, runAgent } from '../../src/index.js';
import { createAiSdkTextExecutor } from '../ai-sdk-host/index.js';

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
const contextSchema = z.object({
  featureRequest: z.string(),
  plan: implementationPlanSchema.nullable(),
  changes: z.array(fileChangeSchema),
});
type OrchestratorWorkerContext = z.infer<typeof contextSchema>;

export const planImplementation = createTextLogic({
  schemas: {
    input: z.object({ featureRequest: z.string() }),
    output: implementationPlanSchema,
  },
  model: 'openai/gpt-4.1-mini',
  system: 'Plan feature implementations as file-level work.',
  prompt: ({ input }) => input.featureRequest,
});

function createPlannedFileChanges(
  featureRequest: string,
  plan: z.infer<typeof implementationPlanSchema>,
): Array<z.infer<typeof fileChangeSchema>> {
  return plan.files.map((file) => ({
    filePath: file.filePath,
    changeType: file.changeType,
    explanation: `Implement ${file.purpose} for ${featureRequest}`,
    code: `// ${file.changeType} ${file.filePath}`,
  }));
}

const agent = setup({
  schemas: createAgentSchemas({
    context: contextSchema,
    input: z.object({ featureRequest: z.string() }),
    output: z.object({
      plan: implementationPlanSchema,
      changes: z.array(fileChangeSchema),
    }),
  }),
  actorSources: {
    planImplementation,
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
      type: 'choice',
      choice: ({ context }: { context: OrchestratorWorkerContext }) => ({
        target: 'done',
        context: {
          changes: createPlannedFileChanges(
            context.featureRequest,
            context.plan ?? { files: [], estimatedComplexity: 'low' },
          ),
        },
      }),
    },
    done: { type: 'final' },
  },
});

export async function runAiSdkOrchestratorWorkerExample() {
  return await runAgent(aiSdkOrchestratorWorkerMachine, {
    input: { featureRequest: 'Add settings page' },
    generateText: createAiSdkTextExecutor(),
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  console.log(await runAiSdkOrchestratorWorkerExample());
}
