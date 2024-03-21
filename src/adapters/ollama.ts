import {
  AnyEventObject,
  Observer,
  fromObservable,
  fromPromise,
  isMachineSnapshot,
  toObserver,
} from 'xstate';
import { getAllTransitions } from '../utils';
import { StatelyAgentAdapter, Tool } from '../types';
import { ChatRequest, ChatResponse, Ollama } from 'ollama';

/**
 * Creates [promise actor logic](https://stately.ai/docs/promise-actors) that uses the Ollama API to generate a completion.
 *
 * @param ollama The ollama instance.
 * @param inputFn A function that maps arbitrary input to ollama chat completion input.
 *
 */
export function fromChatCompletion<TInput>(
  ollama: Ollama,
  agentSettings: StatelyAgentAdapter,
  inputFn: (
    input: TInput
  ) => string | ChatRequest
) {
  return fromPromise<ChatResponse, TInput>(
    async ({ input }) => {
      const ollamaInput = inputFn(input);
      const params: ChatRequest = typeof ollamaInput === 'string' ? {
        model: agentSettings.model,
        messages: [
          {
            role: 'user',
            content: ollamaInput,
          },
        ],
      } : ollamaInput;

      const response = await ollama.chat({ ...params, stream: false })

      return response;
    }
  );
}

/**
 * Creates [observable actor logic](https://stately.ai/docs/observable-actors) that uses the Ollama API to generate a completion stream.
 *
 * @param ollama The Ollama instance to use.
 * @param inputFn A function that maps arbitrary input to Ollama chat completion input.
 */
export function fromChatStream<TInput>(
  ollama: Ollama,
  agentSettings: StatelyAgentAdapter,
  inputFn: (
    input: TInput
  ) => string | ChatRequest
) {
  return fromObservable<AsyncGenerator<ChatResponse>, TInput>(
    ({ input }) => {
      const observers = new Set<Observer<any>>();

      (async () => {
        const ollamaInput = inputFn(input);
        const resolvedParams: ChatRequest =
          typeof ollamaInput === 'string'
            ? {
              model: agentSettings.model,
              messages: [
                {
                  role: 'user',
                  content: ollamaInput,
                },
              ],
            }
            : ollamaInput;
        const stream = await ollama.chat({
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
 * Creates [promise actor logic](https://stately.ai/docs/promise-actors) that passes the next possible transitions as functions to Ollama tool calls ⚠️ currently stubbed and returns an array of potential next events.
 *
 * @param ollama The ollama instance to use.
 * @param inputFn A function that maps arbitrary input to Olama chat completion input.
 */
export function fromEvent<TInput>(
  ollama: Ollama,
  agentSettings: StatelyAgentAdapter,
  inputFn: (
    input: TInput
  ) => string | ChatRequest
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

      const ollamaInput = inputFn(input);
      const completionParams: ChatRequest =
        typeof ollamaInput === 'string'
          ? {
            model: agentSettings.model,
            messages: [
              {
                role: 'user',
                content: ollamaInput,
              },
            ],
          }
          : ollamaInput;
      const completion = await ollama.chat({
        ...completionParams,
        stream: false
        // tools,
      });

      const toolCalls: { function: { name: string, arguments: string } }[] = [];

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
 * Creates [promise actor logic](https://stately.ai/docs/promise-actors) that passes the next possible transitions as functions to Ollama tool calls ⚠️ currently stubbed and returns an array of potential next events.
 *
 * @param ollama The Ollama instance to use.
 * @param inputFn A function that maps arbitrary input to Ollama chat completion input.
 */
export function fromTool<TInput>(
  ollama: Ollama,
  agentSettings: StatelyAgentAdapter,
  tools: {
    [key: string]: Tool<any, any>;
  },
  inputFn: (
    input: TInput
  ) => string | ChatRequest
) {
  return fromPromise<
    | {
      result: any;
      tool: string;
      toolCall: { function: { name: string, arguments: string } };
    }
    | undefined,
    TInput
  >(async ({ input }) => {
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

    const ollamaInput = inputFn(input);
    const completionParams: ChatRequest =
      typeof ollamaInput === 'string'
        ? {
          model: agentSettings.model,
          messages: [
            {
              role: 'user',
              content: ollamaInput,
            },
          ],
        }
        : ollamaInput;
    const completion = await ollama.chat({
      ...completionParams,
      stream: false,
      // tools: resolvedTools,
    });

    const toolCalls: { function: { name: string, arguments: string } }[] = [];

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

export function createOllamaAdapter<
  T extends {
    model: ChatRequest['model'];
  }
>(ollama: Ollama, settings: T): StatelyAgentAdapter {
  const agentSettings: StatelyAgentAdapter = {
    model: settings.model,
    fromEvent: (input) => fromEvent(ollama, agentSettings, input),
    fromChat: (input) => fromChatCompletion(ollama, agentSettings, input),
    fromChatStream: (input) => fromChatStream(ollama, agentSettings, input),
    fromTool: (input, tools) => fromTool(ollama, agentSettings, tools, input),
  };

  return agentSettings;
}
