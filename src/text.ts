import type {
  CoreMessage,
  CoreTool,
  GenerateTextResult,
  StreamTextResult,
} from 'ai';
import {
  AgentGenerateTextOptions,
  AgentStreamTextOptions,
  AnyAgent,
} from './types';
import { defaultTextTemplate } from './templates/defaultText';
import {
  ObservableActorLogic,
  Observer,
  PromiseActorLogic,
  fromObservable,
  fromPromise,
  toObserver,
} from 'xstate';
import { randomId } from './utils';

/**
 * Gets an array of messages from the given prompt, based on the agent and options.
 *
 * @param agent
 * @param prompt
 * @param options
 * @returns
 */
export async function getMessages(
  agent: AnyAgent,
  prompt: string,
  options: Omit<AgentGenerateTextOptions, 'prompt'>
): Promise<CoreMessage[]> {
  let messages: CoreMessage[] = [];
  if (typeof options.messages === 'function') {
    messages = await options.messages(agent);
  } else if (options.messages) {
    messages = options.messages;
  }

  messages = messages.concat({
    role: 'user',
    content: prompt,
  });

  return messages;
}

export async function agentGenerateText<T extends AnyAgent>(
  agent: T,
  options: AgentGenerateTextOptions
) {
  const resolvedOptions = {
    ...agent.defaultOptions,
    ...options,
  };
  const template = resolvedOptions.template ?? defaultTextTemplate;
  // TODO: check if messages was provided instead
  const id = randomId();
  const goal =
    typeof resolvedOptions.prompt === 'string'
      ? resolvedOptions.prompt
      : await resolvedOptions.prompt(agent);

  const promptWithContext = template({
    goal,
    context: resolvedOptions.context,
  });

  const messages = await getMessages(agent, promptWithContext, resolvedOptions);

  agent.addMessage({
    id,
    role: 'user',
    content: promptWithContext,
    timestamp: Date.now(),
  });

  const result = await agent.adapter.generateText({
    ...resolvedOptions,
    prompt: undefined,
    messages,
  });

  agent.addMessage({
    content: result.text,
    id,
    role: 'assistant',
    timestamp: Date.now(),
    responseId: id,
    result,
  });

  return result;
}

export async function agentStreamText(
  agent: AnyAgent,
  options: AgentStreamTextOptions
): Promise<StreamTextResult<any>> {
  const resolvedOptions = {
    ...agent.defaultOptions,
    ...options,
  };
  const template = resolvedOptions.template ?? defaultTextTemplate;

  const id = randomId();
  const goal =
    typeof resolvedOptions.prompt === 'string'
      ? resolvedOptions.prompt
      : await resolvedOptions.prompt(agent);

  const promptWithContext = template({
    goal,
    context: resolvedOptions.context,
  });

  const messages = await getMessages(agent, promptWithContext, resolvedOptions);

  agent.addMessage({
    role: 'user',
    content: promptWithContext,
    id,
    timestamp: Date.now(),
  });

  const result = await agent.adapter.streamText({
    ...resolvedOptions,
    prompt: undefined,
    messages,
    onFinish: async (res) => {
      agent.addMessage({
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
          roundtrips: [], // TODO: how do we get this information?
        },
        content: res.text,
        id: randomId(),
        timestamp: Date.now(),
        responseId: id,
      });
    },
  });

  return result;
}

export function fromTextStream<T extends AnyAgent>(
  agent: T,
  defaultOptions?: AgentStreamTextOptions
): ObservableActorLogic<
  { textDelta: string },
  Omit<AgentStreamTextOptions, 'context'> & {
    context?: AgentStreamTextOptions['context'];
  }
> {
  return fromObservable(({ input }) => {
    const observers = new Set<Observer<{ textDelta: string }>>();

    // TODO: check if messages was provided instead

    (async () => {
      const result = await agentStreamText(agent, {
        ...defaultOptions,
        ...input,
        context: input.context,
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

export function fromText<T extends AnyAgent>(
  agent: T,
  defaultOptions?: AgentGenerateTextOptions
): PromiseActorLogic<
  GenerateTextResult<Record<string, CoreTool<any, any>>>,
  Omit<AgentGenerateTextOptions, 'context'> & {
    context?: AgentGenerateTextOptions['context'];
  }
> {
  return fromPromise(async ({ input }) => {
    return await agentGenerateText(agent, {
      ...input,
      ...defaultOptions,
      context: input.context,
    });
  });
}
