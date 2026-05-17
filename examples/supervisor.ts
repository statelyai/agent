import { z } from 'zod';
import {
  createAgentMachine,
  decide,
  decideResultSchema,
  type DecideAdapter,
} from '../src/index.js';
import {
  closePrompt,
  createOpenAiDecisionAdapter,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const handlingParamsSchema = z.object({
  attempt: z.number().int().min(1),
  instruction: z.string().nullable().optional(),
});

const workerResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('resolved'),
    response: z.string(),
  }),
  z.object({
    status: z.literal('blocked'),
    issue: z.string(),
  }),
]);

const supervisorOptions = {
  retry: {
    description: 'Retry the worker with a concrete instruction for the next attempt.',
    schema: z.object({
      instruction: z.string(),
    }),
  },
  escalate: {
    description: 'Escalate the task to a human or specialist owner.',
    schema: z.object({
      reason: z.string(),
    }),
  },
} as const;

export function createSupervisorExample(
  options: {
    adapter?: DecideAdapter;
    handle?: (args: {
      request: string;
      attempt: number;
      instruction: string | null;
      priorIssues: string[];
    }) => Promise<z.infer<typeof workerResultSchema>>;
    maxAttempts?: number;
  } = {}
) {
  const adapter = options.adapter ?? createOpenAiDecisionAdapter();
  const maxAttempts = options.maxAttempts ?? 2;
  const handle =
    options.handle ??
    ((args: {
      request: string;
      attempt: number;
      instruction: string | null;
      priorIssues: string[];
    }) =>
      generateExampleObject({
        schema: workerResultSchema,
        system: [
          'You are an operations worker handling a support request.',
          'Resolve the request when you have enough information.',
          'Return status="blocked" with a concise issue when the request cannot be completed yet.',
        ].join('\n'),
        prompt: [
          `Request: ${args.request}`,
          `Attempt: ${args.attempt}`,
          args.instruction
            ? `Supervisor instruction: ${args.instruction}`
            : 'Supervisor instruction: none',
          args.priorIssues.length
            ? `Prior issues:\n${args.priorIssues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}`
            : 'Prior issues: none',
        ].join('\n'),
      }));

  return createAgentMachine({
    id: 'supervisor-example',
    schemas: {
      input: z.object({
        request: z.string(),
      }),
      output: z.object({
        request: z.string(),
        status: z.enum(['resolved', 'escalated']),
        resolution: z.string().nullable(),
        escalationReason: z.string().nullable(),
        attemptCount: z.number().int().min(0),
        history: z.array(z.string()),
      }),
    },
    context: (input) => ({
      request: input.request,
      attemptCount: 0,
      latestIssue: null as string | null,
      resolution: null as string | null,
      escalationReason: null as string | null,
      history: [] as string[],
      priorIssues: [] as string[],
    }),
    initial: ({ context }) => ({
      target: 'handling',
      input: {
        attempt: 1,
        instruction: null,
      },
      context,
    }),
    states: {
      handling: {
        schemas: { input: handlingParamsSchema, output: workerResultSchema },
        invoke: async ({ context, input }) =>
          handle({
            request: context.request,
            attempt: input.attempt,
            instruction: input.instruction ?? null,
            priorIssues: context.priorIssues,
          }),
        onDone: ({ output, context, }) => {
          const nextAttemptCount = context.attemptCount + 1;

          if (output.status === 'resolved') {
            return {
              target: 'done',
              context: {
                attemptCount: nextAttemptCount,
                resolution: output.response,
                history: [
                  ...context.history,
                  `worker:${nextAttemptCount}:resolved:${output.response}`,
                ],
              },
            };
          }

          return {
            target: 'supervising',
            context: {
              attemptCount: nextAttemptCount,
              latestIssue: output.issue,
              priorIssues: [...context.priorIssues, output.issue],
              history: [
                ...context.history,
                `worker:${nextAttemptCount}:blocked:${output.issue}`,
              ],
            },
          };
        },
      },
      supervising: {
        schemas: { output: decideResultSchema(supervisorOptions) },
        invoke: async ({ context }) =>
          decide({
            adapter,
            model: 'openai/gpt-5.4-nano',
            prompt: [
              'You supervise a worker that may need retries or escalation.',
              `Max attempts: ${maxAttempts}`,
              `Completed attempts: ${context.attemptCount}`,
              '',
              `Request: ${context.request}`,
              `Latest issue: ${context.latestIssue ?? 'none'}`,
              context.history.length
                ? `History:\n${context.history.map((entry, index) => `${index + 1}. ${entry}`).join('\n')}`
                : 'History: none',
              '',
              context.attemptCount >= maxAttempts
                ? 'You should normally escalate because the worker has reached the attempt limit.'
                : 'Retry only if a concrete next instruction could unblock the worker.',
            ].join('\n'),
            options: supervisorOptions,
          }),
        onDone: ({ output, context }) => {
          if (output.choice === 'retry') {
            const instruction =
              output.data.instruction
              ?? 'Retry once with a more concrete plan and any available context.';

            return {
              target: 'handling',
              context: {
                history: [
                  ...context.history,
                  `supervisor:retry:${instruction}`,
                ],
              },
              input: {
                attempt: context.attemptCount + 1,
                instruction,
              },
            };
          }

          const reason =
            output.data.reason
            ?? `Escalated after ${context.attemptCount} unsuccessful attempts.`;

          return {
            target: 'done',
            context: {
              escalationReason: reason,
              history: [
                ...context.history,
                `supervisor:escalate:${reason}`,
              ],
            },
          };
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          request: context.request,
          status: context.resolution ? ('resolved' as const) : ('escalated' as const),
          resolution: context.resolution,
          escalationReason: context.escalationReason,
          attemptCount: context.attemptCount,
          history: context.history,
        }),
      },
    },
  });
}

async function main() {
  try {
    const request = await prompt('Request');
    const machine = createSupervisorExample();
    console.log(
      formatResult(await machine.execute(machine.getInitialState({ request })))
    );
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
