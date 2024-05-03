import {
  AnyMachineSnapshot,
  fromPromise,
  PromiseActorLogic,
  Values,
} from 'xstate';
import OpenAI from 'openai';
import { getToolCalls } from './adapters/openai';
import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';
import { ZodEventTypes, EventSchemas } from './schemas';
import { createZodEventSchemas } from './utils';
import { TypeOf, z } from 'zod';
import { generateText, LanguageModel, tool } from 'ai';

type AgentLogic<TEventSchemas extends ZodEventTypes> = PromiseActorLogic<
  void,
  | {
      goal: string;
      model?: ChatCompletionCreateParamsBase['model'];
      /**
       * Context to include
       */
      context?: any;
    }
  | string
> & {
  eventTypes: Values<{
    [K in keyof TEventSchemas]: {
      type: K;
    } & TypeOf<TEventSchemas[K]>;
  }>;
  eventSchemas: EventSchemas<keyof TEventSchemas & string>;
};

export function createAgent<const TEventSchemas extends ZodEventTypes>({
  model,
  events,
}: {
  model: LanguageModel;
  events?: TEventSchemas;
}): AgentLogic<TEventSchemas> {
  const eventSchemas = events ? createZodEventSchemas(events) : undefined;

  const logic: Omit<
    AgentLogic<TEventSchemas>,
    'eventTypes' | 'eventSchemas'
  > = fromPromise(async ({ input, self }) => {
    const parentRef = self._parent;
    if (!parentRef) {
      return;
    }
    const resolvedInput = typeof input === 'string' ? { goal: input } : input;
    const state = parentRef.getSnapshot() as AnyMachineSnapshot;
    const contextToInclude = resolvedInput.context
      ? JSON.stringify(resolvedInput.context, null, 2)
      : 'No context provided';

    const toolCalls = await getToolCalls(
      state,
      (eventType) => eventType.startsWith('agent.'),
      eventSchemas ?? (state.machine.schemas as any)?.events
    );

    const toolMap: Record<string, any> = {};

    for (const toolCall of toolCalls) {
      toolMap[toolCall.function.name] = tool({
        description: toolCall.function.description,
        parameters: events?.[toolCall.eventType] ?? z.object({}),
        execute: async (params) => {
          parentRef.send({
            type: toolCall.eventType,
            ...params,
          });
        },
      });
    }

    await generateText({
      model,
      tools: toolMap,
      prompt: [
        `<context>\n${JSON.stringify(contextToInclude, null, 2)}\n</context>`,
        resolvedInput.goal,
        'Only make a single tool call.',
      ].join('\n\n'),
    });

    return;

    // const toolEvents = await getToolCalls(
    //   // model,
    //   // [
    //   //   `<context>\n${JSON.stringify(contextToInclude, null, 2)}\n</context>`,
    //   //   resolvedInput.goal,
    //   //   'Only make a single tool call.',
    //   // ].join('\n\n'),
    //   state,
    //   // resolvedInput.model ?? model,
    //   (eventType) => eventType.startsWith('agent.'),
    //   eventSchemas ?? (state.machine.schemas as any)?.events
    // );

    // if (toolEvents.length > 0) {
    //   parentRef.send(toolEvents[0]);
    // }

    // return;
  });

  (logic as any).eventSchemas = eventSchemas;

  return logic as AgentLogic<TEventSchemas>;
}
