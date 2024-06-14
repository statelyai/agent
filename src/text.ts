import type {
  CoreMessage,
  CoreTool,
  GenerateTextResult,
  StreamTextResult,
} from 'ai';
import {
  Agent,
  AgentGenerateTextOptions,
  AgentStreamTextOptions,
} from './types';
import { defaultTextTemplate } from './templates/defaultText';
import {
  AnyMachineSnapshot,
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
async function getMessages(
  agent: Agent<any>,
  prompt: string,
  options: AgentStreamTextOptions
): Promise<CoreMessage[]> {
  let messages: CoreMessage[] = [];
  if (options.messages === true) {
    messages = agent.select((s) => s.messages);
  } else if (typeof options.messages === 'function') {
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

export async function agentGenerateText<T extends Agent<any>>(
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
  agent: Agent<any>,
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

export function fromTextStream<T extends Agent<any>>(
  agent: T,
  defaultOptions?: AgentStreamTextOptions
): ObservableActorLogic<
  { textDelta: string },
  Omit<AgentStreamTextOptions, 'context'> & {
    context?: AgentStreamTextOptions['context'] | boolean;
  }
> {
  return fromObservable(({ input, self }) => {
    const context =
      input.context === true
        ? (self._parent?.getSnapshot() as AnyMachineSnapshot).context
        : input.context;

    const observers = new Set<Observer<{ textDelta: string }>>();

    // TODO: check if messages was provided instead

    (async () => {
      const result = await agentStreamText(agent, {
        ...defaultOptions,
        ...input,
        context,
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
  Omit<AgentGenerateTextOptions, 'context'> & {
    context?: AgentGenerateTextOptions['context'] | boolean;
  }
> {
  return fromPromise(async ({ input, self }) => {
    const context =
      input.context === true
        ? (self._parent?.getSnapshot() as AnyMachineSnapshot).context
        : input.context;
    return await agentGenerateText(agent, {
      ...input,
      ...defaultOptions,
      context,
    });
  });
}
