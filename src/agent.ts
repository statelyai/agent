import {
  ActorRefFrom,
  AnyEventObject,
  AnyMachineSnapshot,
  AnyStateMachine,
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
import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';
import { ZodEventMapping, EventSchemas } from './schemas';
import { createZodEventSchemas } from './utils';
import { TypeOf } from 'zod';
import {
  CoreTool,
  GenerateObjectResult,
  generateText,
  GenerateTextResult,
  LanguageModel,
  streamText,
} from 'ai';
import {
  AgentTemplate,
  AgentTemplateGenerateObjectOptions,
  GenerateTextOptions,
  StreamTextOptions,
} from './types';
import { simple } from './templates/simple';

export interface AgentRewardItem {
  goal: string;
  reward: number;
  timestamp: number;
}

export interface AgentChatHistory {
  source: string;
  content: any;
  timestamp: number;
  id: string;
  // which chat message we're responding to
  responseId?: string;
}

export interface AgentObservation {
  state: ObservedState;
  sessionId: string;
  timestamp: number;
}

export interface AgentContext {
  observations: any[];
  history: AgentChatHistory[];
  plans: AgentPlan[];
  rewards: AgentRewardItem[];
}

export interface AgentPlanOptions {
  goal: string;
  state: ObservedState;
  events: ZodEventMapping;
  logic: AnyStateMachine;
  template?: AgentTemplate;
}

export type AgentDecisionLogicInput = {
  goal: string;
  model?: ChatCompletionCreateParamsBase['model'];
  /**
   * Context to include
   */
  context?: any;
  template?: AgentTemplate;
} & Omit<Parameters<typeof generateText>[0], 'model' | 'tools' | 'prompt'>;

export type AgentDecisionLogic = PromiseActorLogic<
  void,
  AgentDecisionLogicInput | string
>;

type AgentLogic = TransitionActorLogic<
  AgentContext,
  | {
      type: 'agent.reward';
      reward: AgentRewardItem;
    }
  | {
      type: 'agent.observe';
      state: ObservedState;
      event: AnyEventObject;
      timestamp: number;
    }
  | {
      type: 'agent.history';
      history: AgentChatHistory;
    },
  any
>;

export type Agent<TEventSchemas extends ZodEventMapping> =
  ActorRefFrom<AgentLogic> & {
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
      options: AgentTextLogicInput
    ) => Promise<GenerateTextResult<Record<string, any>>>;
    fromText: () => PromiseActorLogic<
      GenerateTextResult<Record<string, any>>,
      AgentTextLogicInput
    >;

    // Stream text
    streamText: (
      options: AgentTextStreamLogicInput
    ) => AsyncIterable<{ textDelta: string }>;
    fromTextStream: () => ObservableActorLogic<
      { textDelta: string },
      AgentTextStreamLogicInput
    >;

    // Object
    // generateObject: <T>(
    //   options: AgentTemplateGenerateObjectOptions<T>
    // ) => Promise<GenerateObjectResult<T>>;
    // fromObject: <T>() => PromiseActorLogic<
    //   GenerateObjectResult<Record<string, any>>,
    //   AgentObjectLogicInput<T>
    // >;

    inspect: (inspectionEvent: InspectionEvent) => void;
    observe: ({
      state,
      event,
    }: {
      state: ObservedState;
      event: AnyEventObject;
      timestamp: number;
      eventOrigin: 'environment' | 'agent';
    }) => void;
    addHistory: (history: AgentChatHistory) => Promise<void>;
    reward: ({ goal, reward, timestamp }: AgentRewardItem) => void;
    plan: (options: AgentPlanOptions) => Promise<AgentPlan | undefined>;
  };

export type AgentTextLogicInput = Omit<GenerateTextOptions, 'model'> & {
  context?: any;
  template?: AgentTemplate;
};

export type AgentTextStreamLogicInput = Omit<StreamTextOptions, 'model'> & {
  context?: any;
  template?: AgentTemplate;
};

export type AgentObjectLogicInput<T> = Omit<
  AgentTemplateGenerateObjectOptions<T>,
  'model'
> & {
  context?: any;
  template?: AgentTemplate;
};

export interface AgentState {
  state: ObservedState;
}

export function createAgent<const TEventSchemas extends ZodEventMapping>({
  model,
  events,
  stringify = JSON.stringify,
  template,
  ...generateTextOptions
}: {
  model: LanguageModel;
  events?: TEventSchemas;
  stringify?: typeof JSON.stringify;
  template?: AgentTemplate;
} & GenerateTextOptions): Agent<TEventSchemas> {
  const fallbackTemplate =
    template ?? simple({ model, ...generateTextOptions });
  const eventSchemas = events ? createZodEventSchemas(events) : undefined;

  const observe: Agent<TEventSchemas>['observe'] = ({
    state,
    event,
    timestamp,
    eventOrigin: eventOrigin,
  }) => {
    agent.send({
      type: 'agent.observe',
      state,
      event,
      timestamp,
    });
  };

  const agentLogic: AgentLogic = fromTransition(
    (state, event) => {
      switch (event.type) {
        case 'agent.reward': {
          state.rewards.push(event.reward);
          break;
        }
        case 'agent.observe': {
          state.observations.push({
            state: event.state,
            event: event.event,
            timestamp: event.timestamp,
          });
          break;
        }
        case 'agent.history': {
          state.history.push(event.history);
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
      rewards: [],
      history: [],
    } as AgentContext
  );

  const agent = createActor(agentLogic) as unknown as Agent<TEventSchemas>;

  agent.fromDecision = () =>
    fromPromise(async ({ input, self }) => {
      const parentRef = self._parent;
      if (!parentRef) {
        return;
      }

      const resolvedInput = typeof input === 'string' ? { goal: input } : input;
      const resolvedTemplate = resolvedInput.template ?? fallbackTemplate;
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

      if (!resolvedTemplate.plan) {
        console.error('No plan template found');
        return;
      }

      const plan = await resolvedTemplate.plan({
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

  async function agentGenerateText(options: AgentTextLogicInput) {
    const prompt = [
      options.context &&
        `<context>\n${stringify(options.context, null, 2)}\n</context>`,
      options.prompt,
    ]
      .filter(Boolean)
      .join('\n\n');

    const resolvedTemplate = options.template ?? fallbackTemplate;

    if (!resolvedTemplate.generateText) {
      throw new Error('No generateText method found on template');
    }

    const result = resolvedTemplate.generateText({
      model,
      agent,
      ...options,
      prompt,
    });

    return result;
  }

  async function agentGenerateObject<T>(options: AgentObjectLogicInput<T>) {
    const prompt = [
      options.context &&
        `<context>\n${stringify(options.context, null, 2)}\n</context>`,
      options.prompt,
    ]
      .filter(Boolean)
      .join('\n\n');

    const resolvedTemplate = options.template ?? fallbackTemplate;

    if (!resolvedTemplate.generateObject) {
      throw new Error('No generateObject method found on template');
    }

    const result = resolvedTemplate.generateObject<T>({
      model,
      agent,
      ...options,
      prompt,
    });

    return result;
  }

  agent.generateText = agentGenerateText;

  agent.addHistory = async (history) => {
    agent.send({
      type: 'agent.history',
      history,
    });
  };

  function fromText(): PromiseActorLogic<
    GenerateTextResult<Record<string, CoreTool<any, any>>>,
    AgentTextStreamLogicInput
  > {
    return fromPromise(async ({ input }) => {
      return await agentGenerateText(input);
    });
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
        const result = await streamText({
          model,
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
  agent.inspect = (inspectionEvent) => {};
  agent.observe = observe;
  agent.plan = async (planOptions: AgentPlanOptions) => {
    const resolvedTemplate = planOptions.template ?? fallbackTemplate;

    return await resolvedTemplate.plan?.({
      model,
      agent,
      ...planOptions,
    });
  };

  agent.start();

  return agent;
}

export interface ObservedState {
  value: string;
  context: Record<string, unknown>;
}
