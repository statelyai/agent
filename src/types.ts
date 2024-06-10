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
  CoreMessage,
  CoreTool,
  generateText,
  GenerateTextResult,
  LanguageModel,
  streamText,
  StreamTextResult,
} from 'ai';
import { ZodEventMapping } from './schemas';
import { TypeOf } from 'zod';

export type GenerateTextOptions = Parameters<typeof generateText>[0];

export type StreamTextOptions = Parameters<typeof streamText>[0];

export type AgentPlanInput<TEvent extends EventObject> = {
  model: LanguageModel;
  state: ObservedState;
  goal: string;
  events: ZodEventMapping;
  machine?: AnyStateMachine;
  /**
   * The previous plan
   */
  previousPlan?: AgentPlan<any>;
};

export type AgentPlan<TEvent extends EventObject> = {
  goal: string;
  state: ObservedState;
  content?: string;
  steps?: Array<{
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
   * The observed state
   */
  state?: ObservedState;
  /**
   * The context to provide.
   * This overrides the observed state.context, if provided.
   */
  context?: any;
  /**
   * The state machine model of the observed environment
   */
  machine?: unknown;
  /**
   * The potential next transitions that can be taken
   * in the state machine
   */
  transitions?: TransitionData[];
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
  options: AgentPlanInput<T['eventTypes']>
) => Promise<AgentPlan<T['eventTypes']> | undefined>;

export type AgentDecideOptions = {
  goal: string;
  model?: LanguageModel;
  context?: any;
  state: ObservedState;
  machine: AnyStateMachine;
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

export type AgentMessageHistory = CoreMessage & {
  timestamp: number;
  id: string;
  /**
   * The response ID of the message, which references
   * which message this message is responding to, if any.
   */
  responseId?: string;
  result?: GenerateTextResult<any>;
};

export interface AgentObservation {
  id: string;
  state: ObservedState | undefined;
  event: AnyEventObject;
  nextState: ObservedState;
  sessionId: string;
  timestamp: number;
}

export type AgentContext = AgentMemoryData;

export type AgentDecisionInput = {
  goal: string;
  model?: LanguageModel;
  context?: any;
} & Omit<Parameters<typeof generateText>[0], 'model' | 'tools' | 'prompt'>;

export type AgentDecisionLogic<TEvents extends EventObject> = PromiseActorLogic<
  AgentPlan<TEvents> | undefined,
  AgentDecisionInput | string
>;

export type AgentLogic<TEvents extends EventObject> = TransitionActorLogic<
  AgentContext,
  | {
      type: 'agent.feedback';
      feedback: AgentFeedback;
    }
  | {
      type: 'agent.observe';
      observation: Omit<AgentObservation, 'id'>;
    }
  | {
      type: 'agent.history';
      message: AgentMessageHistory;
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
  /**
   * The general name of the agent. All agents with the same name are related and
   * able to share experiences (observations, feedback) with each other.
   */
  name: string;
  /**
   * The unique id of the agent. This is used to partition message history.
   */
  id?: string;
  description?: string;
  events: ZodEventMapping;
  eventTypes: TEvents;
  model: LanguageModel;
  defaultOptions: GenerateTextOptions;
  memory: AgentLongTermMemory | undefined;

  /**
   * Resolves with an `AgentPlan` based on the information provided in the `options`, including:
   *
   * - The `goal` for the agent to achieve
   * - The observed current `state`
   * - The `logic` (e.g. a state machine) that specifies what can happen next
   * - Additional `context`
   */
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
  ) => Promise<StreamTextResult<Record<string, CoreTool<any, any>>>>;

  addObservation: (observation: AgentObservation) => void;
  addHistory: (history: AgentMessageHistory) => void;
  addFeedback: (feedbackItem: AgentFeedback) => void;
  addPlan: (plan: AgentPlan<TEvents>) => void;
  onMessage: (callback: (message: AgentMessageHistory) => void) => void;
  /**
   * Selects agent data from its context.
   */
  select: <T>(selector: (context: AgentContext) => T) => T;
};

export type AnyAgent = Agent<any>;

export type FromAgent<T> = T | ((self: AnyAgent) => T | Promise<T>);

export interface CommonTextOptions {
  prompt: FromAgent<string>;
  model?: LanguageModel;
  context?: Record<string, any>;
  messages?: FromAgent<CoreMessage[]> | true;
  template?: PromptTemplate<any>;
  adapter?: AIAdapter;
}

export type AgentGenerateTextOptions = Omit<
  GenerateTextOptions,
  'model' | 'prompt' | 'messages'
> &
  CommonTextOptions;

export type AgentStreamTextOptions = Omit<
  StreamTextOptions,
  'model' | 'prompt' | 'messages'
> &
  CommonTextOptions;

export interface ObservedState {
  /**
   * The current state value of the state machine, e.g.
   * `"loading"` or `"processing"` or `"ready"`
   */
  value: StateValue;
  /**
   * Additional contextual data related to the current state
   */
  context: Record<string, unknown>;
}

export type AgentMemoryData = {
  observations: AgentObservation[];
  history: AgentMessageHistory[];
  plans: AgentPlan<any>[];
  feedback: AgentFeedback[];
};

export type AgentMemory = AppendOnlyStorage<AgentMemoryData>;

export interface AppendOnlyStorage<T extends Record<string, any[]>> {
  append<K extends keyof T>(
    sessionId: string,
    key: K,
    item: T[K][0]
  ): Promise<void>;
  getAll<K extends keyof T>(
    sessionId: string,
    key: K
  ): Promise<T[K] | undefined>;
}

export interface AgentLongTermMemory {
  get<K extends keyof AgentMemoryData>(key: K): Promise<AgentMemoryData[K]>;
  append<K extends keyof AgentMemoryData>(
    key: K,
    item: AgentMemoryData[K][0]
  ): Promise<void>;
  set<K extends keyof AgentMemoryData>(
    key: K,
    items: AgentMemoryData[K]
  ): Promise<void>;
}

export interface AIAdapter {
  generateText: typeof generateText;
  streamText: typeof streamText;
}
