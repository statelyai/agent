import {
  AnyMachineSnapshot,
  fromObservable,
  fromPromise,
  ObservableActorLogic,
  Observer,
  PromiseActorLogic,
  toObserver,
  Values,
} from 'xstate';
import { getToolCalls } from './utils';
import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';
import { ZodEventTypes, EventSchemas } from './schemas';
import { createZodEventSchemas } from './utils';
import { TypeOf, z } from 'zod';
import {
  generateText,
  GenerateTextResult,
  LanguageModel,
  streamText,
  tool,
} from 'ai';

export type AgentLogic<TEventSchemas extends ZodEventTypes> = PromiseActorLogic<
  void,
  | ({
      goal: string;
      model?: ChatCompletionCreateParamsBase['model'];
      /**
       * Context to include
       */
      context?: any;
    } & Omit<Parameters<typeof generateText>[0], 'model' | 'tools' | 'prompt'>)
  | string
> & {
  eventTypes: Values<{
    [K in keyof TEventSchemas]: {
      type: K;
    } & TypeOf<TEventSchemas[K]>;
  }>;
  eventSchemas: EventSchemas<keyof TEventSchemas & string>;
  fromText: () => ObservableActorLogic<
    GenerateTextResult<never>,
    AgentTextStreamLogicInput
  >;
  fromTextStream: () => ObservableActorLogic<
    { textDelta: string },
    AgentTextStreamLogicInput
  >;
};

export type AgentTextStreamLogicInput = Omit<
  Parameters<typeof streamText>[0],
  'model'
> & {
  context?: any;
};

export function createAgent<const TEventSchemas extends ZodEventTypes>({
  model,
  events,
  ...generateTextOptions
}: {
  model: LanguageModel;
  events?: TEventSchemas;
} & Omit<
  Parameters<typeof generateText>[0],
  'model' | 'tools' | 'prompt'
>): AgentLogic<TEventSchemas> {
  const eventSchemas = events ? createZodEventSchemas(events) : undefined;

  const logic: Omit<
    AgentLogic<TEventSchemas>,
    'eventTypes' | 'eventSchemas' | 'fromText' | 'fromTextStream'
  > = fromPromise(async ({ input, self }) => {
    const parentRef = self._parent;
    if (!parentRef) {
      return;
    }
    const resolvedInput = typeof input === 'string' ? { goal: input } : input;
    const state = parentRef.getSnapshot() as AnyMachineSnapshot;
    const contextToInclude =
      resolvedInput.context === true
        ? // include entire context
          parentRef.getSnapshot().context
        : resolvedInput.context
        ? JSON.stringify(resolvedInput.context, null, 2)
        : 'No context provided';

    const toolCalls = await getToolCalls(
      state,
      (eventType) => Object.keys(events ?? {}).includes(eventType),
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
      ...generateTextOptions,
    });

    return;
  });

  (logic as any).eventSchemas = eventSchemas;

  function fromText() {
    return fromPromise(
      async ({ input }: { input: AgentTextStreamLogicInput }) => {
        const observers = new Set<Observer<{ textDelta: string }>>();

        const prompt = [
          input.context &&
            `<context>\n${JSON.stringify(input.context, null, 2)}\n</context>`,
          input.prompt,
        ]
          .filter(Boolean)
          .join('\n\n');

        const result = await generateText({
          model,
          ...input,
          prompt,
        });

        return result;
      }
    );
  }

  function fromTextStream() {
    return fromObservable(({ input }: { input: AgentTextStreamLogicInput }) => {
      const observers = new Set<Observer<{ textDelta: string }>>();

      const prompt = [
        input.context &&
          `<context>\n${JSON.stringify(input.context, null, 2)}\n</context>`,
        input.prompt,
      ]
        .filter(Boolean)
        .join('\n\n');

      (async () => {
        const result = await streamText({
          model,
          ...input,
          prompt,
        });

        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            observers.forEach((observer) => {
              observer.next?.(part);
            });
          }
        }
      })();

      return {
        subscribe: (...args) => {
          const observer = toObserver(...(args as any));
          observers.add(observer);

          return {
            unsubscribe: () => {
              observers.delete(observer);
            },
          };
        },
      };
    });
  }

  (logic as any).fromText = fromText;
  (logic as any).fromTextStream = fromTextStream;

  return logic as AgentLogic<TEventSchemas>;
}
