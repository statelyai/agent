import {ChatOpenAI, OpenAIClient} from '@langchain/openai';


import {
    AnyEventObject,
    fromObservable,
    fromPromise,
    ObservableActorLogic,
    Observer,
    PromiseActorLogic,
    toObserver,
    Values,
} from 'xstate';
import {
    ContextSchema,
    ConvertContextToJSONSchema,
    ConvertToJSONSchemas,
    createEventSchemas,
    EventSchemas,
    getAllTransitions
} from './utils';
import {FromSchema} from 'json-schema-to-ts';
import {CreateOpenAIToolsAgentParams} from "langchain/agents";
import {RunnableLambda, RunnablePassthrough, RunnableSequence} from "@langchain/core/runnables";
import {JsonOutputToolsParser} from "langchain/output_parsers";
import {BaseLanguageModelInput} from "@langchain/core/dist/language_models/base";


/**
 * Creates [promise actor logic](https://stately.ai/docs/promise-actors) that uses the OpenAI API to generate a completion.
 *
 * @param openai The OpenAI instance.
 * @param agentSettings
 * @param inputFn A function that maps arbitrary input to OpenAI chat completion input.
 *
 */
export function fromChatCompletion<TInput>(
  openai: ChatOpenAI,
  agentSettings: CreateAgentOutput<any>,
  inputFn: (
    input: TInput
  ) => string | OpenAIClient.Chat.Completions.ChatCompletionCreateParamsNonStreaming
) {
  return fromPromise<OpenAIClient.Chat.Completions.ChatCompletion, TInput>(
    async ({ input }) => {
      const openAiInput = inputFn(input);
      const params: OpenAIClient.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
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
        return await openai.completionWithRetry(params);
    }
  );
}

/**
 * Creates [observable actor logic](https://stately.ai/docs/observable-actors) that uses the OpenAI API to generate a completion stream.
 *
 * @param openai The OpenAI instance to use.
 * @param agentSettings
 * @param inputFn A function that maps arbitrary input to OpenAI chat completion input.
 */
export function fromChatCompletionStream<TInput>(
  openai: ChatOpenAI,
  agentSettings: CreateAgentOutput<any>,
  inputFn: (
    input: TInput
  ) => string | OpenAIClient.Chat.Completions.ChatCompletionCreateParamsStreaming
) {
  return fromObservable<OpenAIClient.Chat.Completions.ChatCompletionChunk, TInput>(
    ({ input }) => {
      const observers = new Set<Observer<any>>();

      (async () => {
        const openAiInput = inputFn(input);
        const resolvedParams: OpenAIClient.Chat.Completions.ChatCompletionCreateParamsStreaming =
          typeof openAiInput === 'string'
            ? {
                model: agentSettings.model,
                messages: [
                  {
                    role: 'user',
                    content: openAiInput,
                  },
                ],
               stream: true
              }
            : openAiInput;
        const stream = await openai.completionWithRetry({
          ...resolvedParams 
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
 * @param agentSettings
 * @param inputFn A function that maps arbitrary input to OpenAI chat completion input.
 * @param options
 */
export function fromEventChoice<TInput>(
  openai: CreateOpenAIToolsAgentParams["llm"],
  agentSettings: CreateAgentOutput<any>,
  inputFn: (
    input: TInput
  ) => BaseLanguageModelInput,
  options?: {
    /**
     * Immediately execute sending the event to the parent actor.
     * @default false
     */
    execute?: boolean;
  }
) {
    return fromPromise<AnyEventObject[] | undefined, TInput>(
        async ({input, self, system}) => {
            const transitions = getAllTransitions(self._parent!.getSnapshot());
            const functionNameMapping: Record<string, string> = {};
            const functions = transitions
                .filter((t) => {
                    return !t.eventType.startsWith('xstate.');
                })
                .map((t) => {
                    const name = t.eventType.replace(/\./g, '_');
                    functionNameMapping[name] = t.eventType;
                    return {
                        type: 'function',
                        eventType: t.eventType,
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
                    }  ;
                });

            // await getToolsAgent({transitions, functionNameMapping, system, self, agentSettings, openai, ...options});

            const openAiInput = inputFn(input);

            const callSelectedTool = RunnableLambda.from(
                (toolInvocation: Record<string, any>) => { 
                      const toolCallChain = RunnableSequence.from([
                        (toolInvocation) => toolInvocation.args,
                         new RunnableLambda({
                             func: async (args) => {
                                 if(options?.execute) {
                                     // @ts-ignore
                                     system._relay(self, self._parent, {
                                         type: functionNameMapping[toolInvocation.type],
                                         ...args,
                                     })
                                 }
                             }
                         })
                    ]);
                    // We use `RunnablePassthrough.assign` here to return the intermediate `toolInvocation` params
                    // as well, but you can omit if you only care about the answer.
                    return RunnablePassthrough.assign({
                        output: toolCallChain,
                    });
                }
            );
            // @ts-ignore
            const modelWithTools =  openai.bind({tools: functions} )

            const chain = RunnableSequence.from([
                modelWithTools,
                new JsonOutputToolsParser(),
                // .map() allows us to apply a function for each item in a list of inputs.
                // Required because the model can call multiple tools at once.
                callSelectedTool.map(),
                new JsonOutputToolsParser()
            ]);

 
            return  await chain.invoke(  openAiInput);
        }
    );
}

export interface CreateAgentOutput<
  T extends {
    model: OpenAIClient.Chat.ChatCompletionCreateParams['model'];
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
    inputFn: (input: TInput) => string | OpenAIClient.Chat.ChatCompletionCreateParamsNonStreaming
  ) => PromiseActorLogic<
    FromSchema<Values<ConvertToJSONSchemas<T['events']>>>[] | undefined,
    TInput
  >;
  fromEventChoice: <TInput>(
    inputFn: (input: TInput) => string | OpenAIClient.ChatCompletionCreateParamsNonStreaming
  ) => PromiseActorLogic<
    FromSchema<Values<ConvertToJSONSchemas<T['events']>>>[] | undefined,
    TInput
  >;
  fromChatCompletion: <TInput>(
    inputFn: (input: TInput) => string | OpenAIClient.Chat.ChatCompletionCreateParamsNonStreaming
  ) => PromiseActorLogic<OpenAIClient.Chat.Completions.ChatCompletion, TInput>;
  fromChatCompletionStream: <TInput>(
    inputFn: (input: TInput) => string | OpenAIClient.Chat.ChatCompletionCreateParamsStreaming
  ) => ObservableActorLogic<
      OpenAIClient.Chat.Completions.ChatCompletionChunk,
    TInput
  >;
}

export function createAgent<
  T extends {
    model: OpenAIClient.Chat.ChatCompletionCreateParams['model'];
    context: ContextSchema;
    events: EventSchemas;
  }
>(openai: ChatOpenAI, settings: T): CreateAgentOutput<T> {
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
 
