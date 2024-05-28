import {
  ActorRefFrom,
  AnyActorRef,
  AnyEventObject,
  AnyStateMachine,
  EventObject,
  InspectionEvent,
  ObservableActorLogic,
  PromiseActorLogic,
  Subscription,
  TransitionActorLogic,
  Values,
} from 'xstate';
import {
  generateText,
  GenerateTextResult,
  LanguageModel,
  streamText,
} from 'ai';
import { EventSchemas, ZodActionMapping, ZodEventMapping } from './schemas';
import { TypeOf } from 'zod';

export type GenerateTextOptions = Parameters<typeof generateText>[0];

export type StreamTextOptions = Parameters<typeof streamText>[0];

export type AgentPlanOptions = {
  model: LanguageModel;
  state: ObservedState;
  goal: string;
  events: ZodEventMapping;
  agent: Agent<any>;
  logic?: AnyStateMachine;
};

export type AgentPlan<TEvent extends EventObject> = {
  goal: string;
  state: ObservedState;
  steps: Array<{
    event: TEvent;
    nextState?: ObservedState;
  }>;
  nextEvent: TEvent | undefined;
};

export interface TransitionData {
  eventType: string;
  description?: string;
  guard?: { type: string };
  target?: any;
}

export type PromptTemplate = (data: {
  goal: string;
  context: any;
  logic?: unknown;
  transitions?: TransitionData[];
}) => string;

export type AgentPlanner<TEvent extends EventObject> = (
  options: AgentPlanOptions
) => Promise<AgentPlan<TEvent> | undefined>;

export type AgentDecideOptions = {
  goal: string;
  model?: LanguageModel;
  context?: any;
  actions: ZodActionMapping;
  state: ObservedState;
  logic: AnyStateMachine;
} & Omit<Parameters<typeof generateText>[0], 'model' | 'tools' | 'prompt'>;

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

export interface AgentContext<TEvents extends EventObject> {
  observations: AgentObservation[];
  history: AgentMessageHistory[];
  plans: AgentPlan<TEvents>[];
  feedback: AgentFeedback[];
}

export type AgentDecisionLogicInput = {
  goal: string;
  model?: LanguageModel;
  context?: any;
} & Omit<Parameters<typeof generateText>[0], 'model' | 'tools' | 'prompt'>;

export type AgentDecisionLogic<TEvents extends EventObject> = PromiseActorLogic<
  AgentPlan<TEvents> | undefined,
  AgentDecisionLogicInput | string
>;

export type AgentLogic<TEvents extends EventObject> = TransitionActorLogic<
  AgentContext<TEvents>,
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
      plan: AgentPlan<TEvents>;
    },
  any
>;

export type EventsFromZodEventMapping<TEventSchemas extends ZodEventMapping> =
  Values<{
    [K in keyof TEventSchemas & string]: {
      type: K;
    } & TypeOf<TEventSchemas[K]>;
  }>;

export type Agent<
  TEventSchemas extends ZodEventMapping = {},
  TEvents extends EventObject = EventsFromZodEventMapping<TEventSchemas>
> = ActorRefFrom<AgentLogic<TEvents>> & {
  name: string;
  eventTypes: TEvents;

  // Decision
  decide: (
    options: AgentDecideOptions
  ) => Promise<AgentPlan<TEvents> | undefined>;

  fromDecision: () => AgentDecisionLogic<TEvents>;

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
    options: AgentStreamTextOptions
  ) => AsyncIterable<{ textDelta: string }>;
  fromTextStream: () => ObservableActorLogic<
    { textDelta: string },
    AgentStreamTextOptions
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
  addFeedback: (feedbackItem: AgentFeedback) => Promise<void>;
  generatePlan: (
    options: AgentPlanOptions
  ) => Promise<AgentPlan<TEvents> | undefined>;
  onMessage: (callback: (message: AgentMessageHistory) => void) => void;
  interact: (
    actor: AnyActorRef,
    {
      goal,
      context,
    }: {
      goal: string;
      context: (state: ObservedState) => any;
    }
  ) => Subscription & Promise<void>;
};

export type AgentGenerateTextOptions = Omit<GenerateTextOptions, 'model'> & {
  model?: LanguageModel;
  context?: any;
};

export type AgentStreamTextOptions = Omit<StreamTextOptions, 'model'> & {
  model?: LanguageModel;
  context?: any;
};

export interface ObservedState {
  value: string;
  context: Record<string, unknown>;
}
