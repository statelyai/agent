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
  AgentStreamTextOptions,
  EventsFromZodEventMapping,
  GenerateTextOptions,
} from './types';
import { simplePlanner } from './planners/simplePlanner';
import { randomUUID } from 'crypto';
import { defaultTextTemplate } from './templates/defaultText';

export function createAgent<
  const TEventSchemas extends ZodEventMapping,
  TEvents extends EventObject = EventsFromZodEventMapping<TEventSchemas>
>({
  name,
  model,
  events,
  planner = simplePlanner as AgentPlanner<Agent<TEvents>>,
  stringify = JSON.stringify,
  ...generateTextOptions
}: {
  name: string;
  events: TEventSchemas;
  planner?: AgentPlanner<Agent<TEvents>>;
  stringify?: typeof JSON.stringify;
} & GenerateTextOptions): Agent<TEvents> {
  const messageListeners: Observer<AgentMessageHistory>[] = [];

  const agentLogic: AgentLogic<TEvents> = fromTransition(
    (state, event) => {
      switch (event.type) {
        case 'agent.reward': {
          state.feedback.push(event.reward);
          break;
        }
        case 'agent.observe': {
          state.observations.push({
            id: randomUUID(),
            state: event.state,
            event: event.event,
            nextState: event.nextState,
            timestamp: event.timestamp,
            sessionId: event.sessionId,
          });
          break;
        }
        case 'agent.history': {
          state.history.push(event.history);
          messageListeners.forEach((listener) =>
            listener.next?.(event.history)
          );
          break;
        }
        case 'agent.plan': {
          state.plans.push(event.plan);
          break;
        }
        default:
          break;
      }
      return state;
    },
    {
      observations: [],
      plans: [],
      feedback: [],
      history: [],
    } as AgentContext<TEvents>
  );

  const agent = createActor(agentLogic) as unknown as Agent<TEvents>;

  agent.events = events;
  agent.model = model;
  agent.name = name;
  agent.defaultOptions = { ...generateTextOptions, model };

  agent.onMessage = (callback) => {
    messageListeners.push(toObserver(callback));
  };

  agent.decide = (opts) => {
    return agentDecide(agent, opts);
  };

  agent.addHistory = (history) => {
    agent.send({
      type: 'agent.history',
      history,
    });
  };

  agent.generateText = (opts) => agentGenerateText(agent, opts);

  agent.addObservation = ({
    state,
    event,
    nextState,
    timestamp,
    sessionId,
  }) => {
    agent.send({
      type: 'agent.observe',
      state,
      event,
      nextState,
      timestamp,
      sessionId,
    });
  };

  agent.addPlan = (plan) => {
    agent.send({
      type: 'agent.plan',
      plan,
    });
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

  const content = {
    prompt: options.prompt,
    context: options.context,
  };

  agent.addHistory({
    content,
    id,
    role: 'user',
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
  const content = {
    prompt: options.prompt,
    context: options.context,
  };
  agent.addHistory({
    content,
    id,
    role: 'user',
    timestamp: Date.now(),
  });

  const result = await streamText({
    model: options.model ?? agent.model,
    ...options,
    prompt: promptWithContext,
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
