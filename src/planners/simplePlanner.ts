import { tool } from 'ai';
import {
  AgentPlan,
  AgentPlanOptions,
  ObservedState,
  PromptTemplate,
  TransitionData,
} from '../types';
import { createZodEventSchemas, getAllTransitions } from '../utils';
import { AnyStateMachine } from 'xstate';
import { z } from 'zod';

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

export async function simplePlanner(
  options: AgentPlanOptions
): Promise<AgentPlan<any> | undefined> {
  const transitions: TransitionData[] = options.logic
    ? getTransitions(options.state, options.logic)
    : Object.entries(options.events).map(([eventType, { description }]) => ({
        eventType,
        description,
      }));
  const eventSchemas = createZodEventSchemas(options.events);

  const filter = (eventType: string) =>
    Object.keys(options.events).includes(eventType);

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
      parameters: options.events?.[toolCall.eventType] ?? z.object({}),
      execute: async (params) => {
        const event = {
          type: toolCall.eventType,
          ...params,
        };

        return event;
      },
    });
  }
  const context = options.state.context
    ? `
<context>
${JSON.stringify(options.state.context, null, 2)}
</context>`.trim()
    : '';
  const prompt = `
${context}

${options.goal}

Only make a single tool call to achieve the goal.
      `.trim();

  const { model, ...otherOptions } = options;

  const result = await options.agent.generateText({
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
    goal: options.goal,
    state: options.state,
    steps: [
      {
        event: singleResult.result,
      },
    ],
    nextEvent: singleResult.result,
  };
}
