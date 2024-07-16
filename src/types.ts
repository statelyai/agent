import {
  ActorLogic,
  ActorRefFrom,
  AnyActorRef,
  AnyEventObject,
  AnyStateMachine,
  EventFrom,
  EventObject,
  PromiseActorLogic,
  SnapshotFrom,
  StateValue,
  Subscription,
  TransitionSnapshot,
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
import { ZodContextMapping, ZodEventMapping } from './schemas';
import { TypeOf } from 'zod';

export type GenerateTextOptions = Parameters<typeof generateText>[0];

export type StreamTextOptions = Parameters<typeof streamText>[0];

export type AgentPlanInput<TEvent extends EventObject> = Omit<
  GenerateTextOptions,
  'prompt' | 'messages' | 'tools'
> & {
  /**
   * The currently observed state.
   */
  state: ObservedState;
  /**
   * The goal for the agent to accomplish.
   * The agent will create a plan based on this goal.
   */
  goal: string;
  /**
   * The events that the agent can trigger. This is a mapping of
   * event types to Zod event schemas.
   */
  events: ZodEventMapping;
  /**
   * The state machine that represents the environment the agent
   * is interacting with.
   */
  machine?: AnyStateMachine;
  /**
   * The previous plan.
   */
  previousPlan?: AgentPlan<TEvent>;
};

export type AgentPlan<TEvent extends EventObject> = {
  goal: string;
  state: ObservedState;
  content?: string;
  /**
   * Executes the plan based on the given `state` and resolves with
   * a potential next `event` to trigger to achieve the `goal`.
   */
  execute: (state: ObservedState) => Promise<TEvent | undefined>;
  nextEvent: TEvent | undefined;
  sessionId: string;
  timestamp: number;
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
  observations?: AgentObservation<any>[]; // TODO
  feedback?: AgentFeedback[];
  messages?: AgentMessage[];
  plans?: AgentPlan<TEvents>[];
}) => string;

export type AgentPlanner<T extends AnyAgent> = (
  agent: T,
  input: AgentPlanInput<T['types']['events']>
) => Promise<AgentPlan<T['types']['events']> | undefined>;

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
  observationId: string;
  attributes: Record<string, any>;
  timestamp: number;
  sessionId: string;
}

export interface AgentFeedbackInput {
  goal: string;
  observationId: string; // Observation ID;
  attributes: Record<string, any>;
  timestamp?: number;
}

export type AgentMessage = CoreMessage & {
  timestamp: number;
  id: string;
  /**
   * The response ID of the message, which references
   * which message this message is responding to, if any.
   */
  responseId?: string;
  result?: GenerateTextResult<any>;
  sessionId: string;
};

export type AgentMessageInput = CoreMessage & {
  timestamp?: number;
  id?: string;
  /**
   * The response ID of the message, which references
   * which message this message is responding to, if any.
   */
  responseId?: string;
  result?: GenerateTextResult<any>;
};

export interface AgentObservation<TActor extends AnyActorRef> {
  id: string;
  prevState: SnapshotFrom<TActor> | undefined;
  event: EventFrom<TActor>;
  state: SnapshotFrom<TActor>;
  machineHash: string | undefined;
  sessionId: string;
  timestamp: number;
}

export interface AgentObservationInput {
  id?: string;
  prevState: ObservedState | undefined;
  event: AnyEventObject;
  state: ObservedState;
  machine?: AnyStateMachine;
  timestamp?: number;
}

export type AgentDecisionInput = {
  goal: string;
  model?: LanguageModel;
  context?: any;
} & Omit<Parameters<typeof generateText>[0], 'model' | 'tools' | 'prompt'>;

export type AgentDecisionLogic<TEvents extends EventObject> = PromiseActorLogic<
  AgentPlan<TEvents> | undefined,
  AgentDecisionInput | string
>;

export type AgentEmitted<TEvents extends EventObject> =
  | {
      type: 'feedback';
      feedback: AgentFeedback;
    }
  | {
      type: 'observation';
      observation: AgentObservation<any>; // TODO
    }
  | {
      type: 'message';
      message: AgentMessage;
    }
  | {
      type: 'plan';
      plan: AgentPlan<TEvents>;
    };

export type AgentLogic<TEvents extends EventObject> = ActorLogic<
  TransitionSnapshot<AgentMemoryContext>,
  | {
      type: 'agent.feedback';
      feedback: AgentFeedback;
    }
  | {
      type: 'agent.observe';
      observation: AgentObservation<any>; // TODO
    }
  | {
      type: 'agent.message';
      message: AgentMessage;
    }
  | {
      type: 'agent.plan';
      plan: AgentPlan<TEvents>;
    },
  any, // TODO: input
  any,
  AgentEmitted<TEvents>
>;

export type EventsFromZodEventMapping<TEventSchemas extends ZodEventMapping> =
  Values<{
    [K in keyof TEventSchemas & string]: {
      type: K;
    } & TypeOf<TEventSchemas[K]>;
  }>;

export type ContextFromZodContextMapping<
  TContextSchema extends ZodContextMapping
> = {
  [K in keyof TContextSchema & string]: TypeOf<TContextSchema[K]>;
};

export type Agent<TContext, TEvents extends EventObject> = ActorRefFrom<
  AgentLogic<TEvents>
> & {
  /**
   * The name of the agent. All agents with the same name are related and
   * able to share experiences (observations, feedback) with each other.
   */
  name?: string;
  /**
   * The unique identifier for the agent.
   */
  id?: string;
  description?: string;
  events: ZodEventMapping;
  types: {
    events: TEvents;
    context: Compute<TContext>;
  };
  model: LanguageModel;
  defaultOptions: GenerateTextOptions;
  memory: AgentLongTermMemory | undefined;
  /**
   * The adapter used to perform LLM actions such as
   * `.generateText(…)` and `.streamText(…)`.
   *
   * Defaults to the Vercel AI SDK.
   */
  adapter: AIAdapter;

  /**
   * Resolves with an `AgentPlan` based on the information provided in the `options`, including:
   *
   * - The `goal` for the agent to achieve
   * - The observed current `state`
   * - The `machine` (e.g. a state machine) that specifies what can happen next
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

  addObservation: (
    observationInput: AgentObservationInput
  ) => AgentObservation<any>; // TODO
  addMessage: (messageInput: AgentMessageInput) => AgentMessage;
  addFeedback: (feedbackInput: AgentFeedbackInput) => AgentFeedback;
  addPlan: (plan: AgentPlan<TEvents>) => void;
  /**
   * Called whenever the agent (LLM assistant) receives or sends a message.
   */
  onMessage: (callback: (message: AgentMessage) => void) => void;
  /**
   * Selects agent data from its context.
   *
   * @deprecated Select from `agent.getSnapshot().context` directly or:
   * - `agent.getMessages()`
   * - `agent.getObservations()`
   * - `agent.getFeedback()`
   * - `agent.getPlans()`
   */
  select: <T>(selector: (context: AgentMemoryContext) => T) => T;

  /**
   * Retrieves messages from the agent's short-term (local) memory.
   */
  getMessages: () => AgentMessage[];

  /**
   * Retrieves observations from the agent's short-term (local) memory.
   */
  getObservations: () => AgentObservation<Agent<TContext, TEvents>>[];

  /**
   * Retrieves feedback from the agent's short-term (local) memory.
   */
  getFeedback: () => AgentFeedback[];

  /**
   * Retrieves strategies from the agent's short-term (local) memory.
   */
  getPlans: () => AgentPlan<TEvents>[];

  /**
   * Interacts with this state machine actor by inspecting state transitions and storing them as observations.
   *
   * Observations contain the `prevState`, `event`, and current `state` of this
   * actor, as well as other properties that are useful when recalled.
   * These observations are stored in the `agent`'s short-term (local) memory
   * and can be retrieved via `agent.getObservations()`.
   *
   * @example
   * ```ts
   * // Only observes the actor's state transitions
   * agent.interact(actor);
   *
   * actor.start();
   * ```
   */
  interact<TActor extends AnyActorRef>(actorRef: TActor): Subscription;
  /**
   * Interacts with this state machine actor by:
   * 1. Inspecting state transitions and storing them as observations
   * 2. Deciding what to do next (which event to send the actor) based on
   * the agent input returned from `getInput(observation)`, if `getInput(…)` is provided as the 2nd argument.
   *
   * Observations contain the `prevState`, `event`, and current `state` of this
   * actor, as well as other properties that are useful when recalled.
   * These observations are stored in the `agent`'s short-term (local) memory
   * and can be retrieved via `agent.getObservations()`.
   *
   * @example
   * ```ts
   * // Observes the actor's state transitions and
   * // makes a decision if on the "summarize" state
   * agent.interact(actor, observed => {
   *   if (observed.state.matches('summarize')) {
   *     return {
   *       context: observed.state.context,
   *       goal: 'Summarize the message'
   *     }
   *   }
   * });
   *
   * actor.start();
   * ```
   */
  interact<TActor extends AnyActorRef>(
    actorRef: TActor,
    getInput: (
      observation: AgentObservation<TActor>
    ) => AgentDecisionInput | undefined
  ): Subscription;
};

export type AnyAgent = Agent<any, any>;

export type FromAgent<T> = T | ((self: AnyAgent) => T | Promise<T>);

export interface CommonTextOptions {
  prompt: FromAgent<string>;
  model?: LanguageModel;
  context?: Record<string, any>;
  messages?: FromAgent<CoreMessage[]>;
  template?: PromptTemplate<any>;
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

export type ObservedStateFrom<TActor extends AnyActorRef> = Pick<
  SnapshotFrom<TActor>,
  'value' | 'context'
>;

export type AgentMemoryContext = {
  observations: AgentObservation<any>[]; // TODO
  messages: AgentMessage[];
  plans: AgentPlan<any>[];
  feedback: AgentFeedback[];
};

export type AgentMemory = AppendOnlyStorage<AgentMemoryContext>;

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
  get<K extends keyof AgentMemoryContext>(
    key: K
  ): Promise<AgentMemoryContext[K]>;
  append<K extends keyof AgentMemoryContext>(
    key: K,
    item: AgentMemoryContext[K][0]
  ): Promise<void>;
  set<K extends keyof AgentMemoryContext>(
    key: K,
    items: AgentMemoryContext[K]
  ): Promise<void>;
}

export interface AIAdapter {
  generateText: typeof generateText;
  streamText: typeof streamText;
}

export type Compute<A extends any> = { [K in keyof A]: A[K] } & unknown;
