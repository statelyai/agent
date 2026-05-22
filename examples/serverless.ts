import { z } from 'zod';
import {
  createAgentMachine,
  decide,
  decideResultSchema,
  type DecideAdapter,
} from '../src/index.js';
import { execute } from '../src/local/index.js';
import { createOpenAiDecisionAdapter } from './_run.js';

const movementOptions = {
  moveLeft: {
    description: 'Move left when the goal is best served by exploring lower positions.',
  },
  moveRight: {
    description: 'Move right when the goal is best served by exploring higher positions.',
  },
  doNothing: {
    description: 'Stay still when there is not enough signal to move safely.',
  },
} as const;

interface AgentObservation {
  id: string;
  episodeId: string;
  state: { value: string; context: Record<string, unknown> };
  previousState?: { value: string; context: Record<string, unknown> };
}

interface AgentFeedback {
  observationId: string;
  note: string;
}

const db = {
  observations: [] as AgentObservation[],
  feedbackItems: [] as AgentFeedback[],
  decisions: [] as Array<{
    episodeId: string;
    choice: keyof typeof movementOptions;
    data: Record<string, unknown>;
  }>,
};

export function createServerlessExampleMachine(
  adapter: DecideAdapter = createOpenAiDecisionAdapter()
) {
  return createAgentMachine({
    id: 'serverless-example',
    schemas: {
      input: z.object({
        episodeId: z.string(),
        goal: z.string(),
      }),
      output: z.object({
        choice: z.enum(['moveLeft', 'moveRight', 'doNothing']),
        data: z.record(z.string(), z.unknown()),
      }),
    },
    context: (input) => ({
      episodeId: input.episodeId,
      goal: input.goal,
      choice: null as keyof typeof movementOptions | null,
      data: {} as Record<string, unknown>,
    }),
    initial: 'deciding',
    states: {
      deciding: {
        schemas: { output: decideResultSchema(movementOptions) },
        invoke: async ({ context }) =>
          decide({
            adapter,
            model: 'openai/gpt-5.4-nano',
            prompt: buildDecisionPrompt(context.episodeId, context.goal),
            options: movementOptions,
          }),
        onDone: ({ output }) => ({
          target: 'done',
          context: {
            choice: output.choice,
            data: output.data,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          choice: context.choice ?? 'doNothing',
          data: context.data,
        }),
      },
    },
  });
}

export async function postObservation(observation: AgentObservation) {
  db.observations.push(observation);
}

export async function postFeedback(feedback: AgentFeedback) {
  db.feedbackItems.push(feedback);
}

export async function getDecision(
  req: {
    query: {
      episodeId: string;
      goal: string;
    };
  },
  options: {
    adapter?: DecideAdapter;
  } = {}
) {
  const machine = createServerlessExampleMachine(options.adapter);
  const result = await execute(
    machine,
    machine.getInitialState({
      episodeId: req.query.episodeId,
      goal: req.query.goal,
    })
  );

  if (result.status !== 'done') {
    throw new Error('Serverless decision did not complete');
  }

  db.decisions.push({
    episodeId: req.query.episodeId,
    choice: result.output.choice,
    data: result.output.data,
  });

  return result.output;
}

function buildDecisionPrompt(episodeId: string, goal: string): string {
  const lastObservation = db.observations
    .filter((observation) => observation.episodeId === episodeId)
    .at(-1);
  const similarObservations = db.observations.filter(
    (observation) =>
      observation.previousState?.value === lastObservation?.previousState?.value
  );
  const similarFeedback = db.feedbackItems.filter((feedback) =>
    similarObservations.some(
      (observation) => observation.id === feedback.observationId
    )
  );

  return [
    `Goal: ${goal}`,
    lastObservation
      ? `Current state: ${JSON.stringify(lastObservation.state)}`
      : 'Current state: unknown',
    similarFeedback.length
      ? `Relevant feedback:\n${similarFeedback.map((feedback) => `- ${feedback.note}`).join('\n')}`
      : 'Relevant feedback: none',
  ].join('\n\n');
}
