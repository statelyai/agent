import {
  ActorRefFrom,
  AnyEventObject,
  AnyStateMachine,
  EventObject,
  PromiseActorLogic,
  StateValue,
  TransitionActorLogic,
  Values,
} from 'xstate';
import {
  generateText,
  GenerateTextResult,
  LanguageModel,
  streamText,
} from 'ai';
import { ZodEventMapping } from './schemas';
import { TypeOf } from 'zod';

export type GenerateTextOptions = Parameters<typeof generateText>[0];

export type StreamTextOptions = Parameters<typeof streamText>[0];

export type AgentPlanOptions<TEvent extends EventObject> = {
  model: LanguageModel;
  state: ObservedState;
  goal: string;
  events: ZodEventMapping;
  logic?: AnyStateMachine;
  template?: PromptTemplate<TEvent>;
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

export type PromptTemplate<TEvents extends EventObject> = (data: {
  goal: string;
  /**
   * The state value
   */
  value?: StateValue;
  /**
   * The provided context
   */
  context?: any;
  /**
   * The logical model of the observed environment
   */
  logic?: unknown;
  /**
   * Past observations
   */
  observations?: AgentObservation[];
  feedback?: AgentFeedback[];
  messages?: AgentMessageHistory[];
  plans?: AgentPlan<TEvents>[];
}) => string;

export type AgentPlanner<T extends Agent<any>> = (
  agent: T['eventTypes'],
  options: AgentPlanOptions<T['eventTypes']>
) => Promise<AgentPlan<T['eventTypes']> | undefined>;

export type AgentDecideOptions = {
  goal: string;
  model?: LanguageModel;
  context?: any;
  state: ObservedState;
  logic: AnyStateMachine;
  execute?: (event: AnyEventObject) => Promise<void>;
  planner?: AgentPlanner<any>;
  events?: ZodEventMapping;
} & Omit<
  Parameters<typeof generateText>[0],
  'model' | 'tools' | 'prompt' | 'messages'
>;

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

export type AgentDecisionOptions = {
  goal: string;
  model?: LanguageModel;
  context?: any;
} & Omit<Parameters<typeof generateText>[0], 'model' | 'tools' | 'prompt'>;

export type AgentDecisionLogic<TEvents extends EventObject> = PromiseActorLogic<
  AgentPlan<TEvents> | undefined,
  AgentDecisionOptions | string
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

export type Agent<TEvents extends EventObject> = ActorRefFrom<
  AgentLogic<TEvents>
> & {
  name: string;
  events: ZodEventMapping;
  eventTypes: TEvents;
  model: LanguageModel;
  defaultOptions: GenerateTextOptions;

  // Decision
  decide: (
    options: AgentDecideOptions
  ) => Promise<AgentPlan<TEvents> | undefined>;

  // Generate text
  generateText: (
    options: AgentGenerateTextOptions
  ) => Promise<GenerateTextResult<Record<string, any>>>;

  // Stream text
  streamText: (
    options: AgentStreamTextOptions
  ) => AsyncIterable<{ textDelta: string }>;

  addObservation: (observation: AgentObservation) => void;
  addHistory: (history: AgentMessageHistory) => void;
  addFeedback: (feedbackItem: AgentFeedback) => void;
  addPlan: (plan: AgentPlan<TEvents>) => void;
  onMessage: (callback: (message: AgentMessageHistory) => void) => void;
};

export type AnyAgent = Agent<any>;

export type AgentGenerateTextOptions = Omit<GenerateTextOptions, 'model'> & {
  prompt: string;
  model?: LanguageModel;
  context?: any;
};

export type AgentStreamTextOptions = Omit<StreamTextOptions, 'model'> & {
  prompt: string;
  model?: LanguageModel;
  context?: any;
};

export interface ObservedState {
  value: string;
  context: Record<string, unknown>;
}
