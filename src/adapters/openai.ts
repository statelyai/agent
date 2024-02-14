import type OpenAI from 'openai';
import {
  AnyEventObject,
  Observer,
  fromObservable,
  fromPromise,
  isMachineSnapshot,
  toObserver,
} from 'xstate';
import { getAllTransitions } from '../utils';
import { ChatCompletionCreateParamsNonStreaming } from 'openai/resources';
import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';
import { StatelyAgentAdapter, Tool } from '../types';

/**
 * Creates [promise actor logic](https://stately.ai/docs/promise-actors) that uses the OpenAI API to generate a completion.
 *
 * @param openai The OpenAI instance.
 * @param inputFn A function that maps arbitrary input to OpenAI chat completion input.
 *
 */
export function fromChatCompletion<TInput>(
  openai: OpenAI,
  agentSettings: StatelyAgentAdapter,
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
export function fromChatStream<TInput>(
  openai: OpenAI,
  agentSettings: StatelyAgentAdapter,
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
export function fromEvent<TInput>(
  openai: OpenAI,
  agentSettings: StatelyAgentAdapter,
  inputFn: (
    input: TInput
  ) => string | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
) {
  return fromPromise<AnyEventObject[] | undefined, TInput>(
    async ({ input, self, system }) => {
      const parentSnapshot = self._parent?.getSnapshot();

      if (!parentSnapshot || !isMachineSnapshot(parentSnapshot)) {
        return undefined;
      }

      const schemas = parentSnapshot.machine.schemas as any;
      const eventSchemaMap = schemas.events ?? {};

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
                t.description ?? eventSchemaMap[t.eventType]?.description,
              parameters: {
                type: 'object',
                properties: eventSchemaMap[t.eventType]?.properties ?? {},
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

      if (toolCalls?.length) {
        const events = toolCalls.map((tc) => {
          return {
            type: functionNameMapping[tc.function.name],
            ...JSON.parse(tc.function.arguments),
          };
        });

        const event = events[0]!;

        // @ts-ignore
        system._relay(self, self._parent, event);
      }

      return undefined;
    }
  );
}

export function createTool<TInput, T>({
  description,
  inputSchema,
  run,
}: Tool<TInput, T>): Tool<TInput, T> {
  return {
    description,
    inputSchema,
    run,
  };
}

/**
 * Creates [promise actor logic](https://stately.ai/docs/promise-actors) that passes the next possible transitions as functions to [OpenAI tool calls](https://platform.openai.com/docs/guides/function-calling) and returns an array of potential next events.
 *
 * @param openai The OpenAI instance to use.
 * @param inputFn A function that maps arbitrary input to OpenAI chat completion input.
 */
export function fromTool<TInput>(
  openai: OpenAI,
  agentSettings: StatelyAgentAdapter,
  tools: {
    [key: string]: Tool<any, any>;
  },
  inputFn: (
    input: TInput
  ) => string | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
) {
  return fromPromise<
    | {
        result: any;
        tool: string;
        toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
      }
    | undefined,
    TInput
  >(async ({ input, self, system }) => {
    const functionNameMapping: Record<string, string> = {};
    const resolvedTools = Object.entries(tools).map(([key, value]) => {
      return {
        type: 'function',
        function: {
          name: key,
          description: value.description,
          parameters: value.inputSchema,
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
      tools: resolvedTools,
    });

    const toolCalls = completion.choices[0]?.message.tool_calls;

    if (toolCalls?.length) {
      const toolCall = toolCalls[0]!;
      const tool = tools[toolCall.function.name];
      const args = JSON.parse(toolCall.function.arguments);

      if (tool) {
        const result = await tool.run(args);

        return {
          toolCall,
          tool: toolCall.function.name,
          result,
        };
      }
    }

    return undefined;
  });
}

export function createOpenAIAdapter<
  T extends {
    model: ChatCompletionCreateParamsBase['model'];
  }
>(openai: OpenAI, settings: T): StatelyAgentAdapter {
  const agentSettings: StatelyAgentAdapter = {
    model: settings.model,
    fromEvent: (input) => fromEvent(openai, agentSettings, input),
    fromChat: (input) => fromChatCompletion(openai, agentSettings, input),
    fromChatStream: (input) => fromChatStream(openai, agentSettings, input),
    fromTool: (input, tools) => fromTool(openai, agentSettings, tools, input),
  };

  return agentSettings;
}
