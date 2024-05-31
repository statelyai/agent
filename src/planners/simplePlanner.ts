import { CoreTool, tool } from 'ai';
import {
  AgentPlan,
  AgentPlanOptions,
  ObservedState,
  TransitionData,
} from '../types';
import { getAllTransitions } from '../utils';
import { AnyStateMachine } from 'xstate';
import { z } from 'zod';
import { defaultPromptTemplate } from '../templates/default';

const getTransitions = (state: ObservedState, logic: AnyStateMachine) => {
  if (!logic) {
    return [];
  }

  const resolvedState = logic.resolveState(state);
  return getAllTransitions(resolvedState);
};

export async function simplePlanner(
  options: AgentPlanOptions<any>
): Promise<AgentPlan<any> | undefined> {
  const template = options.template ?? defaultPromptTemplate;
  const transitions: TransitionData[] = options.logic
    ? getTransitions(options.state, options.logic)
    : Object.entries(options.events).map(([eventType, { description }]) => ({
        eventType,
        description,
      }));

  const filter = (eventType: string) =>
    Object.keys(options.events).includes(eventType);

  const functionNameMapping: Record<string, string> = {};
  const toolTransitions = transitions
    .filter((t) => {
      return filter(t.eventType);
    })
    .map((t) => {
      const name = t.eventType.replace(/\./g, '_');
      functionNameMapping[name] = t.eventType;

      return {
        type: 'function',
        eventType: t.eventType,
        description: t.description,
        name,
      } as const;
    });

  const toolMap: Record<string, CoreTool<any, any>> = {};

  for (const toolTransitionData of toolTransitions) {
    const toolZodType = options.events?.[toolTransitionData.eventType];

    toolMap[toolTransitionData.name] = tool({
      description: toolZodType?.description ?? toolTransitionData.description,
      parameters: toolZodType ?? z.object({}),
      execute: async (params) => {
        const event = {
          type: toolTransitionData.eventType,
          ...params,
        };

        return event;
      },
    });
  }

  const prompt = template({
    context: options.state.context,
    goal: options.goal,
  });

  const { model, ...otherOptions } = options;

  const result = await options.agent.generateText({
    model,
    prompt,
    tools: toolMap,
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
