/**
 * Vercel AI SDK orchestrator-worker — ported to `setupAgent` with a
 * co-located `requests:` entry for the planning step. Applying the plan
 * into file changes is deterministic (no model call) in the source AI SDK
 * example, so it stays as a pure `always` transition rather than becoming
 * a request call.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#orchestrator-worker
 *
 * Run: OPENAI_API_KEY=... node --import tsx examples/ai-sdk-orchestrator-worker/index.ts
 */
import { z } from 'zod';
import { setupAgent, runAgent } from '../../src/index.js';
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

const agent = setupAgent({
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
  requests: {
    planImplementation: {
      schemas: {
        input: z.object({ featureRequest: z.string() }),
        output: implementationPlanSchema,
      },
      model: 'openai/gpt-4.1-mini',
      system: 'Plan feature implementations as file-level work.',
      prompt: ({ input }) => input.featureRequest,
    },
  },
});

export const planImplementation = agent.requests.planImplementation;

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
        id: 'planImplementation',
        src: 'planImplementation',
        input: ({ context }) => ({ featureRequest: context.featureRequest }),
        onDone: ({ output }) => ({
          target: 'implementing',
          context: { plan: output },
        }),
      },
    },
    implementing: {
      always: ({ context }) => ({
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
  const result = await runAgent(aiSdkOrchestratorWorkerMachine, {
    input: { featureRequest: 'Add settings page' },
    generateText: createAiSdkTextExecutor(),
  });
  if (result.status !== 'done') {
    throw new Error(`Orchestrator-worker example did not complete: ${result.status}`);
  }
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  console.log(await runAiSdkOrchestratorWorkerExample());
}
