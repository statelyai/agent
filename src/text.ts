import {
  generateText,
  streamText,
  type CoreMessage,
  type CoreTool,
  type GenerateTextResult,
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

export function fromTextStream<T extends AnyAgent>(
  agent: T,
  options?: AgentStreamTextOptions
): ObservableActorLogic<
  { textDelta: string },
  Omit<AgentStreamTextOptions, 'context'> & {
    context?: AgentStreamTextOptions['context'];
  }
> {
  const template = options?.template ?? defaultTextTemplate;
  return fromObservable(({ input }) => {
    const observers = new Set<Observer<{ textDelta: string }>>();

    // TODO: check if messages was provided instead

    (async () => {
      const model = input.model ? agent.wrap(input.model) : agent.model;
      const goal =
        typeof input.prompt === 'string'
          ? input.prompt
          : await input.prompt(agent);
      const promptWithContext = template({
        goal,
        context: input.context,
      });
      const messages = await getMessages(agent, promptWithContext, input);
      const result = await streamText({
        ...options,
        ...input,
        prompt: undefined, // overwritten by messages
        model,
        messages,
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
  options?: AgentGenerateTextOptions
): PromiseActorLogic<
  GenerateTextResult<Record<string, CoreTool<any, any>>>,
  Omit<AgentGenerateTextOptions, 'context'> & {
    context?: AgentGenerateTextOptions['context'];
  }
> {
  const resolvedOptions = {
    ...agent.defaultOptions,
    ...options,
  };

  const template = resolvedOptions.template ?? defaultTextTemplate;

  return fromPromise(async ({ input }) => {
    const goal =
      typeof input.prompt === 'string'
        ? input.prompt
        : await input.prompt(agent);

    const promptWithContext = template({
      goal,
      context: input.context,
    });

    const messages = await getMessages(agent, promptWithContext, input);

    const model = input.model ? agent.wrap(input.model) : agent.model;

    return await generateText({
      ...input,
      ...options,
      prompt: undefined,
      messages,
      model,
    });
  });
}
