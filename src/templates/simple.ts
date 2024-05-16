import { generateText, tool } from 'ai';
import { GenerateTextOptions, AgentTemplate } from '../types';
import {
  createZodEventSchemas,
  getAllTransitions,
  PromptTemplate,
  TransitionData,
} from '../utils';
import { AnyStateMachine } from 'xstate';
import { z } from 'zod';
import { ObservedState } from '../agent';

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

export function simple(options?: GenerateTextOptions): AgentTemplate {
  return {
    plan: async (x) => {
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
      const prompt = `
<context>
${JSON.stringify(x.state.context, null, 2)}
</context>

${x.goal}

Only make a single tool call to achieve the goal.
      `.trim();

      const id = Date.now() + '';
      x.agent?.addHistory({
        content: prompt,
        id,
        source: 'user',
        timestamp: Date.now(),
      });

      const result = await generateText({
        model: x.model,
        prompt,
        tools: toolMap as any,
        ...options,
      });

      const singleResult = result.toolResults[0];

      x.agent?.addHistory({
        content: singleResult,
        id: Date.now() + '',
        source: 'model',
        timestamp: Date.now(),
        responseId: id,
      });

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
    },
  };
}
