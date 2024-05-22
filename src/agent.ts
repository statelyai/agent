import {
  ActorRefFrom,
  AnyEventObject,
  AnyMachineSnapshot,
  createActor,
  fromObservable,
  fromPromise,
  fromTransition,
  InspectionEvent,
  ObservableActorLogic,
  Observer,
  PromiseActorLogic,
  toObserver,
  TransitionActorLogic,
  Values,
} from 'xstate';
import { AgentPlan } from './utils';
import { ZodEventMapping, EventSchemas } from './schemas';
import { createZodEventSchemas } from './utils';
import { TypeOf } from 'zod';
import {
  CoreTool,
  generateText,
  GenerateTextResult,
  LanguageModel,
  streamText,
  StreamTextResult,
} from 'ai';
import {
  AgentPlanOptions,
  GenerateTextOptions,
  StreamTextOptions,
} from './types';
import { generatePlan } from './generatePlan';
import { randomUUID } from 'crypto';

export interface AgentFeedback {
  goal: string;
  observation: AgentObservation;
  attributes: Record<string, any>;
  timestamp: number;
}

export interface AgentMessageHistory {
  role: 'user' | 'assistant';
  content: any;
  timestamp: number;
  id: string;
  // which chat message we're responding to
  responseId?: string;
  sessionId?: string;
}

export interface AgentObservation {
  id: string;
  state: ObservedState | undefined;
  event: AnyEventObject;
  nextState: ObservedState;
  sessionId: string;
  timestamp: number;
}

export interface AgentContext {
  observations: AgentObservation[];
  history: AgentMessageHistory[];
  plans: AgentPlan[];
  feedback: AgentFeedback[];
}

export type AgentDecisionLogicInput = {
  goal: string;
  model?: LanguageModel;
  context?: any;
} & Omit<Parameters<typeof generateText>[0], 'model' | 'tools' | 'prompt'>;

export type AgentDecisionLogic = PromiseActorLogic<
  void,
  AgentDecisionLogicInput | string
>;

type AgentLogic = TransitionActorLogic<
  AgentContext,
  | {
      type: 'agent.reward';
      reward: AgentFeedback;
    }
  | {
      type: 'agent.observe';
      state: ObservedState | undefined;
      event: AnyEventObject;
      nextState: ObservedState;
      timestamp: number;
      // Which actor sent the event
      sessionId: string;
    }
  | {
      type: 'agent.history';
      history: AgentMessageHistory;
    }
  | {
      type: 'agent.plan';
      plan: AgentPlan;
    },
  any
>;

export type Agent<TEventSchemas extends ZodEventMapping = {}> =
  ActorRefFrom<AgentLogic> & {
    name: string;
    eventTypes: Values<{
      [K in keyof TEventSchemas]: {
        type: K;
      } & TypeOf<TEventSchemas[K]>;
    }>;
    eventSchemas: EventSchemas<keyof TEventSchemas & string>;

    // Decision
    decide: (input: AgentDecisionLogicInput) => Promise<
      | Values<{
          [K in keyof TEventSchemas]: {
            type: K;
          } & TypeOf<TEventSchemas[K]>;
        }>
      | undefined
    >;
    fromDecision: () => AgentDecisionLogic;

    // Generate text
    generateText: (
      options: AgentGenerateTextOptions
    ) => Promise<GenerateTextResult<Record<string, any>>>;

    fromText: () => PromiseActorLogic<
      GenerateTextResult<Record<string, any>>,
      AgentGenerateTextOptions
    >;

    // Stream text
    streamText: (
      options: AgentTextStreamLogicInput
    ) => AsyncIterable<{ textDelta: string }>;
    fromTextStream: () => ObservableActorLogic<
      { textDelta: string },
      AgentTextStreamLogicInput
    >;

    inspect: (inspectionEvent: InspectionEvent) => void;
    observe: ({
      state,
      event,
      nextState,
    }: {
      state: ObservedState | undefined;
      event: AnyEventObject;
      nextState: ObservedState;
      timestamp: number;
      sessionId: string;
    }) => void;
    addHistory: (history: AgentMessageHistory) => Promise<void>;
    addFeedback: (feedbackItem: AgentFeedback) => void;
    generatePlan: (options: AgentPlanOptions) => Promise<AgentPlan | undefined>;
    onMessage: (callback: (message: AgentMessageHistory) => void) => void;
  };

export type AgentGenerateTextOptions = Omit<GenerateTextOptions, 'model'> & {
  model?: LanguageModel;
  context?: any;
};

export type AgentTextStreamLogicInput = Omit<StreamTextOptions, 'model'> & {
  context?: any;
};

export function createAgent<const TEventSchemas extends ZodEventMapping>({
  name,
  model,
  events,
  stringify = JSON.stringify,
  ...generateTextOptions
}: {
  name: string;
  model: LanguageModel;
  events?: TEventSchemas;
  stringify?: typeof JSON.stringify;
} & GenerateTextOptions): Agent<TEventSchemas> {
  const messageListeners: Observer<AgentMessageHistory>[] = [];

  const eventSchemas = events ? createZodEventSchemas(events) : undefined;

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

  const agentLogic: AgentLogic = fromTransition(
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
    } as AgentContext
  );

  const agent = createActor(agentLogic) as unknown as Agent<TEventSchemas>;

  agent.name = name;

  agent.onMessage = (callback) => {
    messageListeners.push(toObserver(callback));
  };

  agent.fromDecision = () =>
    fromPromise(async ({ input, self }) => {
      const parentRef = self._parent;
      if (!parentRef) {
        return;
      }

      const resolvedInput = typeof input === 'string' ? { goal: input } : input;
      const snapshot = parentRef.getSnapshot() as AnyMachineSnapshot;
      const contextToInclude =
        resolvedInput.context === true
          ? // include entire context
            parentRef.getSnapshot().context
          : resolvedInput.context;
      const state = {
        value: snapshot.value,
        context: contextToInclude,
      };

      const plan = await generatePlan({
        model,
        goal: resolvedInput.goal,
        events: events ?? {}, // TODO: events should be required
        state,
        logic: parentRef.src as any,
        agent,
        ...generateTextOptions,
      });

      if (plan?.nextEvent) {
        // TODO: validate event
        parentRef.send(plan.nextEvent);
      }

      return;
    }) as AgentDecisionLogic;

  agent.eventSchemas = eventSchemas ?? ({} as any);

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
      content: result.text,
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
    AgentTextStreamLogicInput
  > {
    return fromPromise(async ({ input }) => {
      return await agentGenerateText(input);
    });
  }

  async function agentStreamText(
    input: AgentTextStreamLogicInput
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
    AgentTextStreamLogicInput
  > {
    return fromObservable(({ input }: { input: AgentTextStreamLogicInput }) => {
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
    const plan = await generatePlan(planOptions);

    if (plan) {
      agent.send({
        type: 'agent.plan',
        plan,
      });
    }

    return plan;
  };

  agent.start();

  return agent;
}

export interface ObservedState {
  value: string;
  context: Record<string, unknown>;
}
