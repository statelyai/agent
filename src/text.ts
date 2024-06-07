import {
  CoreTool,
  GenerateTextResult,
  StreamTextResult,
  generateText,
  streamText,
} from 'ai';
import {
  Agent,
  AgentGenerateTextOptions,
  AgentStreamTextOptions,
} from './types';
import { randomUUID } from 'crypto';
import { defaultTextTemplate } from './templates/defaultText';
import {
  ObservableActorLogic,
  Observer,
  PromiseActorLogic,
  fromObservable,
  fromPromise,
  toObserver,
} from 'xstate';

export async function agentGenerateText<T extends Agent<any>>(
  agent: T,
  options: AgentGenerateTextOptions
) {
  const template = options.template ?? defaultTextTemplate;
  // TODO: check if messages was provided instead
  const id = randomUUID();
  const promptWithContext = template({
    goal: options.prompt,
    context: options.context,
  });

  agent.addHistory({
    id,
    role: 'user',
    content: promptWithContext,
    timestamp: Date.now(),
  });

  const result = await generateText({
    model: options.model ?? agent.model,
    ...options,
    prompt: promptWithContext,
  });

  agent.addHistory({
    content: result.toolResults ?? result.text,
    id,
    role: 'assistant',
    timestamp: Date.now(),
    responseId: id,
    result,
  });

  return result;
}

async function agentStreamText(
  agent: Agent<any>,
  options: AgentStreamTextOptions
): Promise<StreamTextResult<any>> {
  const template = options.template ?? defaultTextTemplate;

  const id = randomUUID();
  const promptWithContext = template({
    goal: options.prompt,
    context: options.context,
  });

  agent.addHistory({
    role: 'user',
    content: promptWithContext,
    id,
    timestamp: Date.now(),
  });

  const result = await streamText({
    model: options.model ?? agent.model,
    ...options,
    prompt: promptWithContext,
    onFinish: async (res) => {
      agent.addHistory({
        role: 'assistant',
        result: {
          text: res.text,
          finishReason: res.finishReason,
          logprobs: undefined,
          responseMessages: [],
          toolCalls: [],
          toolResults: [],
          usage: res.usage,
          warnings: res.warnings,
          rawResponse: res.rawResponse,
        },
        content: res.text,
        id: randomUUID(),
        timestamp: Date.now(),
        responseId: id,
      });
    },
  });

  return result;
}

export function fromTextStream<T extends Agent<any>>(
  agent: T,
  defaultOptions?: AgentStreamTextOptions
): ObservableActorLogic<{ textDelta: string }, AgentStreamTextOptions> {
  return fromObservable(({ input }: { input: AgentStreamTextOptions }) => {
    const observers = new Set<Observer<{ textDelta: string }>>();

    // TODO: check if messages was provided instead

    (async () => {
      const result = await agentStreamText(agent, {
        ...defaultOptions,
        ...input,
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
      subscribe: (...args: any[]) => {
        const observer = toObserver(...args);
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

export function fromText<T extends Agent<any>>(
  agent: T,
  defaultOptions?: AgentGenerateTextOptions
): PromiseActorLogic<
  GenerateTextResult<Record<string, CoreTool<any, any>>>,
  AgentGenerateTextOptions
> {
  return fromPromise(async ({ input }) => {
    return await agentGenerateText(agent, {
      ...input,
      ...defaultOptions,
    });
  });
}
