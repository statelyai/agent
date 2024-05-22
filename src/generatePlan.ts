import { tool } from 'ai';
import { AgentStrategyPlanOptions } from './types';
import {
  AgentPlan,
  createZodEventSchemas,
  getAllTransitions,
  PromptTemplate,
  TransitionData,
} from './utils';
import { AnyStateMachine } from 'xstate';
import { z } from 'zod';
import { ObservedState } from './agent';

const getTransitions = (state: ObservedState, logic: AnyStateMachine) => {
  if (!logic) {
    return [];
  }

  const resolvedState = logic.resolveState(state);
  return getAllTransitions(resolvedState);
};

export const defaultPromptTemplate: PromptTemplate = (data) => {
  return `
<context>
${JSON.stringify(data.context, null, 2)}
</context>

${data.goal}

Only make a single tool call to achieve the goal.
  `.trim();
};

export async function generatePlan(
  x: AgentStrategyPlanOptions
): Promise<AgentPlan | undefined> {
  const transitions: TransitionData[] = x.logic
    ? getTransitions(x.state, x.logic)
    : Object.entries(x.events).map(([eventType, { description }]) => ({
        eventType,
        description,
      }));
  const eventSchemas = createZodEventSchemas(x.events);

  const filter = (eventType: string) =>
    Object.keys(x.events).includes(eventType);

  const functionNameMapping: Record<string, string> = {};
  const tools = transitions
    .filter((t) => {
      return filter(t.eventType);
    })
    .map((t) => {
      const name = t.eventType.replace(/\./g, '_');
      functionNameMapping[name] = t.eventType;
      const eventSchema = eventSchemas?.[t.eventType];
      const {
        description,
        properties: { type, ...properties },
      } = eventSchema ?? ({} as any);

      return {
        type: 'function',
        eventType: t.eventType,
        function: {
          name,
          description: t.description ?? description,
          parameters: {
            type: 'object',
            properties: properties ?? {},
          },
        },
      } as const;
    });

  const toolMap: Record<string, any> = {};

  for (const toolCall of tools) {
    toolMap[toolCall.function.name] = tool({
      description: toolCall.function.description,
      parameters: x.events?.[toolCall.eventType] ?? z.object({}),
      execute: async (params) => {
        const event = {
          type: toolCall.eventType,
          ...params,
        };

        return event;
      },
    });
  }
  const context = x.state.context
    ? `
<context>
${JSON.stringify(x.state.context, null, 2)}
</context>`.trim()
    : '';
  const prompt = `
${context}

${x.goal}

Only make a single tool call to achieve the goal.
      `.trim();

  const { model, ...otherOptions } = x;

  const result = await x.agent!.generateText({
    model,
    prompt,
    tools: toolMap as any,
    ...otherOptions,
  });

  const singleResult = result.toolResults[0];

  if (!singleResult) {
    return undefined;
  }

  return {
    goal: x.goal,
    state: x.state,
    steps: [
      {
        event: singleResult.result,
      },
    ],
    nextEvent: singleResult.result,
  };
}
