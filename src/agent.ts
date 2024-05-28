import {
  AnyEventObject,
  AnyMachineSnapshot,
  AnyStateMachine,
  createActor,
  fromObservable,
  fromPromise,
  fromTransition,
  ObservableActorLogic,
  Observer,
  PromiseActorLogic,
  toObserver,
} from 'xstate';
import { ZodEventMapping, ZodActionMapping } from './schemas';
import {
  CoreTool,
  generateText,
  GenerateTextResult,
  LanguageModel,
  streamText,
  StreamTextResult,
} from 'ai';
import {
  Agent,
  AgentContext,
  AgentDecisionLogic,
  AgentDecisionLogicInput,
  AgentGenerateTextOptions,
  AgentLogic,
  AgentMessageHistory,
  AgentPlanner,
  AgentPlanOptions,
  AgentStreamTextOptions,
  EventsFromZodEventMapping,
  GenerateTextOptions,
  ObservedState,
} from './types';
import { simplePlanner } from './planners/simplePlanner';
import { randomUUID } from 'crypto';

export function createAgent<const TEventSchemas extends ZodEventMapping>({
  name,
  model,
  events,
  planner = simplePlanner,
  stringify = JSON.stringify,
  ...generateTextOptions
}: {
  name: string;
  model: LanguageModel;
  events?: TEventSchemas;
  planner?: AgentPlanner<EventsFromZodEventMapping<TEventSchemas>>;
  stringify?: typeof JSON.stringify;
} & GenerateTextOptions): Agent<TEventSchemas> {
  const messageListeners: Observer<AgentMessageHistory>[] = [];

  const observe: Agent<TEventSchemas>['observe'] = ({
    state,
    event,
    nextState,
    timestamp,
    sessionId,
    // eventOrigin,
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

  const agentLogic: AgentLogic<EventsFromZodEventMapping<TEventSchemas>> =
    fromTransition(
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
      } as AgentContext<EventsFromZodEventMapping<TEventSchemas>>
    );

  const agent = createActor(agentLogic) as unknown as Agent<TEventSchemas>;

  agent.name = name;

  agent.onMessage = (callback) => {
    messageListeners.push(toObserver(callback));
  };

  function getActions(onEvent: (event: AnyEventObject) => void) {
    const actions: ZodActionMapping = {};

    for (const [eventType, zodEventSchema] of Object.entries(events ?? {})) {
      actions[eventType] = {
        schema: zodEventSchema,
        action: async (_state, event) => {
          onEvent(event);
        },
      };
    }
    return actions;
  }

  agent.fromDecision = () =>
    fromPromise(async ({ input, self }) => {
      const parentRef = self._parent;
      if (!parentRef) {
        return;
      }

      const snapshot = parentRef.getSnapshot() as AnyMachineSnapshot;
      const resolvedInput: AgentDecisionLogicInput =
        typeof input === 'string' ? { goal: input } : input;
      const contextToInclude =
        resolvedInput.context === true
          ? // include entire context
            parentRef.getSnapshot().context
          : resolvedInput.context;
      const state = {
        value: snapshot.value,
        context: contextToInclude,
      };

      const actions = getActions((ev) => {
        parentRef.send(ev);
      });

      const plan = await agentDecide({
        goal: resolvedInput.goal,
        actions,
        logic: parentRef.src as any,
        state,
        ...generateTextOptions,
      });

      return plan;
    }) as AgentDecisionLogic<any>;

  async function agentDecide(opts: {
    goal: string;
    actions: ZodActionMapping;
    state: ObservedState;
    logic: AnyStateMachine;
  }) {
    const events: ZodEventMapping = {};
    for (const [name, action] of Object.entries(opts.actions)) {
      events[name] = action.schema;
    }

    const plan = await planner({
      model,
      goal: opts.goal,
      events,
      state: opts.state,
      logic: opts.logic,
      agent,
      ...generateTextOptions,
    });

    if (plan?.nextEvent) {
      await opts.actions[plan.nextEvent.type]?.action(
        opts.state,
        plan.nextEvent
      );
    }

    return plan;
  }

  agent.decide = agentDecide;

  agent.addHistory = async (history) => {
    agent.send({
      type: 'agent.history',
      history,
    });
  };

  async function agentGenerateText(options: AgentGenerateTextOptions) {
    const prompt = [
      options.context &&
        `<context>\n${stringify(options.context, null, 2)}\n</context>`,
      options.prompt,
    ]
      .filter(Boolean)
      .join('\n\n');

    const id = Date.now() + '';

    agent.addHistory({
      content: prompt,
      id,
      role: 'user',
      timestamp: Date.now(),
    });

    const messages = options.messages ?? [];
    const { prompt: _, ...optionsWithoutPrompt } = options;

    messages.push({
      content: prompt,
      role: 'user',
    });

    const result = await generateText({
      model,
      ...optionsWithoutPrompt,
      messages,
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

  agent.generateText = agentGenerateText;

  function fromText(): PromiseActorLogic<
    GenerateTextResult<Record<string, CoreTool<any, any>>>,
    AgentStreamTextOptions
  > {
    return fromPromise(async ({ input }) => {
      return await agentGenerateText(input);
    });
  }

  async function agentStreamText(
    input: AgentStreamTextOptions
  ): Promise<StreamTextResult<any>> {
    const id = randomUUID();
    agent.addHistory({
      content: input.prompt,
      id,
      role: 'user',
      timestamp: Date.now(),
    });
    const result = await streamText({
      model,
      ...input,
      prompt: input.prompt,
    });

    return result;
  }

  function fromTextStream(): ObservableActorLogic<
    { textDelta: string },
    AgentStreamTextOptions
  > {
    return fromObservable(({ input }: { input: AgentStreamTextOptions }) => {
      const observers = new Set<Observer<{ textDelta: string }>>();

      const prompt = [
        input.context &&
          `<context>\n${stringify(input.context, null, 2)}\n</context>`,
        input.prompt,
      ]
        .filter(Boolean)
        .join('\n\n');

      (async () => {
        const result = await agentStreamText({
          ...input,
          prompt,
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

  agent.fromText = fromText;
  agent.fromTextStream = fromTextStream;
  agent.inspect = (inspectionEvent) => {
    if (inspectionEvent.type === '@xstate.snapshot') {
      agent.send({
        type: 'agent.observe',
        event: inspectionEvent.event,
        nextState: {
          value: (inspectionEvent.snapshot as AnyMachineSnapshot).value,
          context: (inspectionEvent.snapshot as AnyMachineSnapshot).context,
        },
        sessionId: agent.sessionId,
        state: undefined,
        timestamp: Date.now(),
      });
    }
  };
  agent.observe = observe;
  agent.generatePlan = async (planOptions: AgentPlanOptions) => {
    const plan = await planner(planOptions);

    if (plan) {
      agent.send({
        type: 'agent.plan',
        plan,
      });
    }

    return plan;
  };

  agent.interact = (actorRef, { goal, context: contextFn }) => {
    let currentState = actorRef.getSnapshot();
    console.log(currentState.value);
    let subscribed = true;

    async function observeAndPlan({
      event,
      snapshot,
    }: {
      event: AnyEventObject;
      snapshot: AnyMachineSnapshot;
    }) {
      agent.observe({
        state: currentState,
        event: event,
        nextState: snapshot as AnyMachineSnapshot,
        sessionId: agent.sessionId,
        timestamp: Date.now(),
      });
      currentState = snapshot;
      const actions = getActions((ev) => {
        console.log('sending event', ev);
        actorRef.send(ev);
      });
      console.log(currentState.value);
      const plan = await agent.decide({
        state: currentState,
        actions,
        goal,
        logic: actorRef.src as any,
        context: contextFn(currentState),
      });

      console.log('next event', plan?.nextEvent);
    }
    actorRef.system.inspect({
      next: async (inspectionEvent) => {
        if (!subscribed) {
          return;
        }
        if (
          inspectionEvent.actorRef === actorRef &&
          inspectionEvent.type === '@xstate.snapshot'
        ) {
          await observeAndPlan({
            event: inspectionEvent.event,
            snapshot: inspectionEvent.snapshot as AnyMachineSnapshot,
          });
        }
      },
    });

    observeAndPlan({
      event: { type: 'xstate.init' },
      snapshot: currentState,
    });

    const promise = new Promise((res, rej) => {});
    (promise as any).unsubscribe = () => {
      subscribed = false;
    };

    return promise as any;
  };

  agent.start();

  return agent;
}
