import type OpenAI from 'openai';
import {
  AnyEventObject,
  ObservableActorLogic,
  Observer,
  PromiseActorLogic,
  Values,
  fromObservable,
  fromPromise,
  setup,
  toObserver,
} from 'xstate';
import { getAllTransitions } from './utils';
import {
  ContextSchema,
  EventSchemas,
  ConvertContextToJSONSchema,
  ConvertToJSONSchemas,
  createEventSchemas,
} from './utils';
import { FromSchema } from 'json-schema-to-ts';
import { ChatCompletionCreateParamsNonStreaming } from 'openai/resources';
import {
  ChatCompletionCreateParamsBase,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';

/**
 * Creates [promise actor logic](https://stately.ai/docs/promise-actors) that uses the OpenAI API to generate a completion.
 *
 * @param openai The OpenAI instance.
 * @param inputFn A function that maps arbitrary input to OpenAI chat completion input.
 *
 */
export function fromChatCompletion<TInput>(
  openai: OpenAI,
  agentSettings: CreateAgentOutput<any>,
  inputFn: (
    input: TInput
  ) => string | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
) {
  return fromPromise<OpenAI.Chat.Completions.ChatCompletion, TInput>(
    async ({ input }) => {
      const openAiInput = inputFn(input);
      const params: ChatCompletionCreateParamsNonStreaming =
        typeof openAiInput === 'string'
          ? {
              model: agentSettings.model,
              messages: [
                {
                  role: 'user',
                  content: openAiInput,
                },
              ],
            }
          : openAiInput;
      const response = await openai.chat.completions.create(params);

      return response;
    }
  );
}

/**
 * Creates [observable actor logic](https://stately.ai/docs/observable-actors) that uses the OpenAI API to generate a completion stream.
 *
 * @param openai The OpenAI instance to use.
 * @param inputFn A function that maps arbitrary input to OpenAI chat completion input.
 */
export function fromChatCompletionStream<TInput>(
  openai: OpenAI,
  agentSettings: CreateAgentOutput<any>,
  inputFn: (
    input: TInput
  ) => string | OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
) {
  return fromObservable<OpenAI.Chat.Completions.ChatCompletionChunk, TInput>(
    ({ input }) => {
      const observers = new Set<Observer<any>>();

      (async () => {
        const openAiInput = inputFn(input);
        const resolvedParams: ChatCompletionCreateParamsBase =
          typeof openAiInput === 'string'
            ? {
                model: agentSettings.model,
                messages: [
                  {
                    role: 'user',
                    content: openAiInput,
                  },
                ],
              }
            : openAiInput;
        const stream = await openai.chat.completions.create({
          ...resolvedParams,
          stream: true,
        });

        for await (const part of stream) {
          observers.forEach((observer) => {
            observer.next?.(part);
          });
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
    }
  );
}

/**
 * Creates [promise actor logic](https://stately.ai/docs/promise-actors) that passes the next possible transitions as functions to [OpenAI tool calls](https://platform.openai.com/docs/guides/function-calling) and returns an array of potential next events.
 *
 * @param openai The OpenAI instance to use.
 * @param inputFn A function that maps arbitrary input to OpenAI chat completion input.
 */
export function fromEventChoice<TInput>(
  openai: OpenAI,
  agentSettings: CreateAgentOutput<any>,
  inputFn: (
    input: TInput
  ) => string | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  options?: {
    /**
     * Immediately execute sending the event to the parent actor.
     * @default false
     */
    execute?: boolean;
  }
) {
  return fromPromise<AnyEventObject[] | undefined, TInput>(
    async ({ input, self, system }) => {
      const transitions = getAllTransitions(self._parent!.getSnapshot());
      const functionNameMapping: Record<string, string> = {};
      const tools = transitions
        .filter((t) => {
          return !t.eventType.startsWith('xstate.');
        })
        .map((t) => {
          const name = t.eventType.replace(/\./g, '_');
          functionNameMapping[name] = t.eventType;
          return {
            type: 'function',
            function: {
              name,
              description:
                t.description ??
                agentSettings.schemas.events[t.eventType]?.description,
              parameters: {
                type: 'object',
                properties:
                  agentSettings.schemas.events[t.eventType]?.properties ?? {},
              },
            },
          } as const;
        });

      const openAiInput = inputFn(input);
      const completionParams: ChatCompletionCreateParamsNonStreaming =
        typeof openAiInput === 'string'
          ? {
              model: agentSettings.model,
              messages: [
                {
                  role: 'user',
                  content: openAiInput,
                },
              ],
            }
          : openAiInput;
      const completion = await openai.chat.completions.create({
        ...completionParams,
        tools,
      });

      const toolCalls = completion.choices[0]?.message.tool_calls;

      if (toolCalls) {
        const events = toolCalls.map((tc) => {
          return {
            type: functionNameMapping[tc.function.name],
            ...JSON.parse(tc.function.arguments),
          };
        });

        if (options?.execute) {
          events.forEach((event) => {
            // @ts-ignore
            system._relay(self, self._parent, event);
          });
        }
      }

      return undefined;
    }
  );
}

interface CreateAgentOutput<
  T extends {
    model: ChatCompletionCreateParamsBase['model'];
    context: ContextSchema;
    events: EventSchemas;
  }
> {
  model: T['model'];
  schemas: T;
  types: {
    context: FromSchema<ConvertContextToJSONSchema<T['context']>>;
    events: FromSchema<Values<ConvertToJSONSchemas<T['events']>>>;
  };
  fromEvent: <TInput>(
    inputFn: (input: TInput) => string | ChatCompletionCreateParamsNonStreaming
  ) => PromiseActorLogic<
    FromSchema<Values<ConvertToJSONSchemas<T['events']>>>[] | undefined,
    TInput
  >;
  fromEventChoice: <TInput>(
    inputFn: (input: TInput) => string | ChatCompletionCreateParamsNonStreaming
  ) => PromiseActorLogic<
    FromSchema<Values<ConvertToJSONSchemas<T['events']>>>[] | undefined,
    TInput
  >;
  fromChatCompletion: <TInput>(
    inputFn: (input: TInput) => string | ChatCompletionCreateParamsNonStreaming
  ) => PromiseActorLogic<OpenAI.Chat.Completions.ChatCompletion, TInput>;
  fromChatCompletionStream: <TInput>(
    inputFn: (input: TInput) => string | ChatCompletionCreateParamsStreaming
  ) => ObservableActorLogic<
    OpenAI.Chat.Completions.ChatCompletionChunk,
    TInput
  >;
}

export function createAgent<
  T extends {
    model: ChatCompletionCreateParamsBase['model'];
    context: ContextSchema;
    events: EventSchemas;
  }
>(openai: OpenAI, settings: T): CreateAgentOutput<T> {
  const agentSettings: CreateAgentOutput<T> = {
    model: settings.model,
    schemas: {
      context: {
        type: 'object',
        properties: settings.context,
        additionalProperties: false,
      },
      events: createEventSchemas(settings.events),
    } as any,
    types: {} as any,
    fromEvent: (input) =>
      // @ts-ignore
      fromEventChoice(openai, agentSettings, input, { execute: true }),
    // @ts-ignore infinitely deep
    fromEventChoice: (input) => fromEventChoice(openai, agentSettings, input),
    fromChatCompletion: (input) =>
      fromChatCompletion(openai, agentSettings, input),
    fromChatCompletionStream: (input) =>
      fromChatCompletionStream(openai, agentSettings, input),
  };

  return agentSettings as any;
}
