import {
  AnyMachineSnapshot,
  createActor,
  EventObject,
  fromObservable,
  fromPromise,
  fromTransition,
  ObservableActorLogic,
  Observer,
  PromiseActorLogic,
  toObserver,
} from 'xstate';
import { ZodEventMapping } from './schemas';
import {
  CoreTool,
  generateText,
  GenerateTextResult,
  streamText,
  StreamTextResult,
} from 'ai';
import {
  Agent,
  AgentContext,
  AgentDecideOptions,
  AgentDecisionLogic,
  AgentDecisionOptions,
  AgentGenerateTextOptions,
  AgentLogic,
  AgentMessageHistory,
  AgentPlanner,
  AgentStorage,
  AgentStreamTextOptions,
  EventsFromZodEventMapping,
  GenerateTextOptions,
} from './types';
import { simplePlanner } from './planners/simplePlanner';
import { randomUUID } from 'crypto';
import { defaultTextTemplate } from './templates/defaultText';
import { createMemoryStorage } from './storage';

export function createAgent<
  const TEventSchemas extends ZodEventMapping,
  TEvents extends EventObject = EventsFromZodEventMapping<TEventSchemas>
>({
  name,
  model,
  events,
  planner = simplePlanner as AgentPlanner<Agent<TEvents>>,
  stringify = JSON.stringify,
  storage = createMemoryStorage(),
  ...generateTextOptions
}: {
  name: string;
  events: TEventSchemas;
  planner?: AgentPlanner<Agent<TEvents>>;
  stringify?: typeof JSON.stringify;
  storage?: AgentStorage;
} & GenerateTextOptions): Agent<TEvents> {
  const messageHistoryListeners: Observer<AgentMessageHistory>[] = [];

  const agentLogic: AgentLogic<TEvents> = fromTransition(
    (state, event, { sessionId }) => {
      switch (event.type) {
        case 'agent.feedback': {
          state.storage.append(sessionId, 'feedback', event.feedback);
          break;
        }
        case 'agent.observe': {
          state.storage.append(sessionId, 'observations', {
            id: randomUUID(),
            ...event.observation,
          });
          break;
        }
        case 'agent.history': {
          state.storage.append(sessionId, 'history', event.message);
          messageHistoryListeners.forEach((listener) =>
            listener.next?.(event.message)
          );
          break;
        }
        case 'agent.plan': {
          state.storage.append(sessionId, 'plans', event.plan);
          break;
        }
        default:
          break;
      }
      return state;
    },
    {
      storage,
    } as AgentContext<TEvents>
  );

  const agent = createActor(agentLogic) as unknown as Agent<TEvents>;

  agent.events = events;
  agent.model = model;
  agent.name = name;
  agent.defaultOptions = { ...generateTextOptions, model };

  agent.onMessage = (callback) => {
    messageHistoryListeners.push(toObserver(callback));
  };

  agent.decide = (opts) => {
    return agentDecide(agent, opts);
  };

  agent.addHistory = (history) => {
    agent.send({
      type: 'agent.history',
      message: history,
    });
  };

  agent.getHistory = async () => {
    return await storage.getAll(agent.sessionId, 'history');
  };

  agent.generateText = (opts) => agentGenerateText(agent, opts);

  agent.addObservation = (observation) => {
    agent.send({
      type: 'agent.observe',
      observation,
    });
  };

  agent.getObservations = async () => {
    return await storage.getAll(agent.sessionId, 'observations');
  };

  agent.addPlan = (plan) => {
    agent.send({
      type: 'agent.plan',
      plan,
    });
  };

  agent.getPlans = async () => {
    return await storage.getAll(agent.sessionId, 'plans');
  };

  agent.start();

  return agent;
}

export function fromDecision(
  agent: Agent<any>,
  defaultOptions?: AgentDecisionOptions
) {
  return fromPromise(async ({ input, self }) => {
    const parentRef = self._parent;
    if (!parentRef) {
      return;
    }

    const snapshot = parentRef.getSnapshot() as AnyMachineSnapshot;
    const inputObject = typeof input === 'string' ? { goal: input } : input;
    const resolvedInput = {
      ...defaultOptions,
      ...inputObject,
    };
    const contextToInclude =
      resolvedInput.context === true
        ? // include entire context
          parentRef.getSnapshot().context
        : resolvedInput.context;
    const state = {
      value: snapshot.value,
      context: contextToInclude,
    };

    const plan = await agentDecide(agent, {
      logic: parentRef.src as any,
      state,
      execute: async (event) => {
        parentRef.send(event);
      },
      ...resolvedInput,
    });

    return plan;
  }) as AgentDecisionLogic<any>;
}

async function agentGenerateText<T extends Agent<any>>(
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

async function agentDecide<T extends Agent<any>>(
  agent: T,
  options: AgentDecideOptions
) {
  const {
    planner = simplePlanner as AgentPlanner<any>,
    goal,
    events = agent.events,
    state,
    logic,
    model = agent.model,
    ...otherOptions
  } = options;
  // const planner = opts.planner ?? simplePlanner;
  const plan = await planner(agent, {
    model,
    goal,
    events,
    state,
    logic,
    ...otherOptions,
  });

  if (plan?.nextEvent) {
    await options.execute?.(plan.nextEvent);
  }

  return plan;
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
