import {
  ActorLogic,
  ActorRefLike,
  AnyEventObject,
  AnyStateMachine,
  EventFrom,
  EventObject,
  SnapshotFrom,
  StateValue,
  TransitionSnapshot,
  Values,
} from 'xstate';
import {
  CoreMessage,
  generateText,
  GenerateTextResult,
  LanguageModel,
  streamText,
} from 'ai';
import { ZodContextMapping, ZodEventMapping } from './schemas';
import { TypeOf } from 'zod';
import { Expert } from './expert';

export type GenerateTextOptions = Parameters<typeof generateText>[0];

export type StreamTextOptions = Parameters<typeof streamText>[0];

export type CostFunction<TExpert extends AnyExpert> = (
  path: ExpertPath<TExpert>
) => number;

export type ExpertDecideInput<TExpert extends AnyExpert> = Omit<
  ExpertGenerateTextOptions,
  'model' | 'prompt' | 'tools' | 'toolChoice'
> & {
  /**
   * The parent decision that this decision is a part of.
   */
  decisionId?: string;
  /**
   * The currently observed state.
   */
  state: ObservedState<TExpert>;
  /**
   * The context to provide in the prompt to the expert. This overrides the `state.context`.
   */
  context?: Record<string, any>;
  /**
   * The goal for the expert to accomplish.
   * The expert will make a decision based on this goal.
   */
  goal: string;
  /**
   * The events that the expert can trigger. This is a mapping of
   * event types to Zod event schemas.
   */
  events?: ZodEventMapping;
  allowedEvents?: Array<EventFromExpert<TExpert>['type']>;
  /**
   * The state machine that represents the environment the expert
   * is interacting with.
   */
  machine?: AnyStateMachine;

  /**
   * A function that calculates the total cost of the path to the goal state.
   */
  costFunction?: CostFunction<TExpert>;

  /**
   * The maximum number of attempts to make a decision.
   * Defaults to 2.
   */
  maxAttempts?: number;
  /**
   * The policy to use for making a decision.
   */
  policy?: ExpertPolicy<TExpert>;
  model?: LanguageModel;
  /**
   * The previous relevant feedback from the expert.
   */
  feedback?: ExpertFeedback[];
  /**
   * The previous relevant observations from the expert.
   */
  observations?: ExpertObservation<any>[];
  /**
   * The previous relevant decisions from the expert.
   */
  decisions?: ExpertDecision<TExpert>[];
  /**
   * The previous relevant insights from the expert.
   */
  insights?: ExpertInsight[];
  toolChoice?: 'auto' | 'none' | 'required';
} & BaseInput;

export type ExpertStep<TExpert extends AnyExpert> = {
  /** The event to take */
  event: EventFromExpert<TExpert>;
  /** The next expected state after taking the event */
  state: ObservedState<TExpert> | null;
};

export type ExpertPath<TExpert extends AnyExpert> = {
  /** The expected ending state of the path */
  state: ObservedState<TExpert> | null;
  /** The steps to reach the ending state */
  steps: Array<ExpertStep<TExpert>>;
  weight?: number;
};

export interface ExpertDecisionInput<TExpert extends AnyExpert>
  extends BaseInput {
  goal: string;
  decisionId?: string | null;
  policy?: string | null;
  goalState?: ObservedState<TExpert> | null;
  nextEvent?: EventFromExpert<TExpert> | null;
  paths?: ExpertPath<TExpert>[];
}

export interface ExpertDecision<TExpert extends AnyExpert = AnyExpert>
  extends BaseProperties {
  /**
   * The parent decision that this decision is a part of.
   */
  decisionId: string | null;
  /**
   * The policy used to generate the decision
   */
  policy: string | null;
  goal: string;
  /**
   * The ending state of the decision.
   */
  goalState: ObservedState<TExpert> | null;
  /**
   * The next event that the expert decided needs to occur to achieve the `goal`.
   *
   * This next event is chosen from the
   */
  nextEvent: EventFromExpert<TExpert> | null;
  /**
   * The paths that the expert can take to achieve the goal.
   */
  paths: ExpertPath<TExpert>[];
}

export interface TransitionData {
  eventType: string;
  description?: string;
  guard?: { type: string };
  target?: any;
}

export type PromptTemplate<TExpert extends AnyExpert> = (data: {
  goal: string;
  /**
   * The observed state
   */
  stateValue?: any;
  context?: Record<string, any>;
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
   * Relevant past observations
   */
  observations?: ExpertObservation<any>[]; // TODO
  /**
   * Relevant feedback
   */
  feedback?: ExpertFeedback[];
  /**
   * Relevant messages
   */
  messages?: ExpertMessage[];
  /**
   * Relevant past decisions
   */
  decisions?: ExpertDecision<TExpert>[];
  /**
   * Relevant past insights
   */
  insights?: ExpertInsight[];
}) => string;

export type ExpertPolicy<TExpert extends AnyExpert = AnyExpert> = (
  expert: TExpert,
  input: ExpertDecideInput<TExpert>
) => Promise<ExpertDecision<TExpert> | undefined>;

export type ExpertInteractInput<T extends AnyExpert> = Omit<
  ExpertDecideInput<T>,
  'state'
> & {
  state?: never;
};

export interface ExpertFeedback extends BaseProperties {
  decisionId: string;
  reward: number;
  comment: string | undefined;
  attributes: Record<string, any>;
}

interface BaseProperties {
  id: string;
  episodeId: string;
  timestamp: number;
}

type BaseInput = Partial<BaseProperties>;

export interface ExpertFeedbackInput extends BaseInput {
  /**
   * The decision ID that this feedback is relevant for.
   */
  decisionId: string;
  reward: number;
  comment?: string;
  attributes?: Record<string, any>;
}

export type ExpertMessage = BaseProperties &
  CoreMessage & {
    /**
     * The parent decision that this message is a part of.
     */
    decisionId?: string;
    /**
     * The response ID of the message, which references
     * which message this message is responding to, if any.
     */
    responseId?: string;
    result?: GenerateTextResult<any, any>;
  };

type JSONObject = {
  [key: string]: JSONValue;
};
type JSONArray = JSONValue[];
type JSONValue = null | string | number | boolean | JSONObject | JSONArray;

type LanguageModelV1ProviderMetadata = Record<
  string,
  Record<string, JSONValue>
>;

export interface LanguageModelV1TextPart {
  type: 'text';
  /**
The text content.
   */
  text: string;
  /**
   * Additional provider-specific metadata. They are passed through
   * to the provider from the AI SDK and enable provider-specific
   * functionality that can be fully encapsulated in the provider.
   */
  providerMetadata?: LanguageModelV1ProviderMetadata;
}

export interface LanguageModelV1ToolCallPart {
  type: 'tool-call';
  /**
ID of the tool call. This ID is used to match the tool call with the tool result.
 */
  toolCallId: string;
  /**
Name of the tool that is being called.
 */
  toolName: string;
  /**
Arguments of the tool call. This is a JSON-serializable object that matches the tool's input schema.
   */
  args: unknown;
  /**
   * Additional provider-specific metadata. They are passed through
   * to the provider from the AI SDK and enable provider-specific
   * functionality that can be fully encapsulated in the provider.
   */
  providerMetadata?: LanguageModelV1ProviderMetadata;
}

export type ExpertMessageInput = CoreMessage & {
  timestamp?: number;
  id?: string;
  /**
   * The response ID of the message, which references
   * which message this message is responding to, if any.
   */
  responseId?: string;
  result?: GenerateTextResult<any, any>;
};

export interface ExpertObservation<TActor extends ActorRefLike> {
  id: string;
  episodeId: string;
  /**
   * The decision that this observation is relevant for
   */
  decisionId?: string | undefined;
  goal?: string;
  prevState: SnapshotFrom<TActor> | undefined;
  event: EventFrom<TActor> | undefined;
  state: SnapshotFrom<TActor>;
  // machineHash: string | undefined;
  timestamp: number;
}

export interface ExpertObservationInput<TExpert extends AnyExpert>
  extends BaseInput {
  state: ObservedState<TExpert>;
  /**
   * The expert decision that the observation is relevant for
   */
  decisionId?: string | undefined;
  prevState?: ObservedState<TExpert>;
  event?: AnyEventObject;
  goal?: string | undefined;
}

export type ExpertEmittedEvent<TExpert extends AnyExpert> =
  | {
      type: 'feedback';
      feedback: ExpertFeedback;
    }
  | {
      type: 'observation';
      observation: ExpertObservation<any>; // TODO
    }
  | {
      type: 'message';
      message: ExpertMessage;
    }
  | {
      type: 'decision';
      decision: ExpertDecision<TExpert>;
    }
  | {
      type: 'insight';
      insight: ExpertInsight;
    };

export type ExpertLogic<TExpert extends AnyExpert> = ActorLogic<
  TransitionSnapshot<ExpertMemoryContext<TExpert>>,
  | {
      type: 'expert.feedback';
      feedback: ExpertFeedback;
    }
  | {
      type: 'expert.observe';
      observation: ExpertObservation<any>; // TODO
    }
  | {
      type: 'expert.message';
      message: ExpertMessage;
    }
  | {
      type: 'expert.decision';
      decision: ExpertDecision<TExpert>;
    }
  | {
      type: 'expert.insight';
      insight: ExpertInsight;
    },
  any, // TODO: input
  any,
  ExpertEmittedEvent<TExpert>
>;

export type EventsFromZodEventMapping<TEventSchemas extends ZodEventMapping> =
  Compute<
    Values<{
      [K in keyof TEventSchemas & string]: {
        type: K;
      } & TypeOf<TEventSchemas[K]>;
    }>
  >;

export type ContextFromZodContextMapping<
  TContextSchema extends ZodContextMapping
> = {
  [K in keyof TContextSchema & string]: TypeOf<TContextSchema[K]>;
};

export type AnyExpert = Expert<any, any>;

export type FromExpert<T> = T | ((expert: AnyExpert) => T | Promise<T>);

export type CommonTextOptions = {
  prompt: FromExpert<string>;
  model?: LanguageModel;
  messages?: CoreMessage[];
  template?: PromptTemplate<any>;
  context?: Record<string, any>;
};

export type ExpertGenerateTextOptions = Omit<
  GenerateTextOptions,
  'model' | 'prompt' | 'messages'
> &
  CommonTextOptions;

export type ExpertStreamTextOptions = Omit<
  StreamTextOptions,
  'model' | 'prompt' | 'messages'
> &
  CommonTextOptions;

export interface ObservedState<TExpert extends AnyExpert> {
  /**
   * The current state value of the state machine, e.g.
   * `"loading"` or `"processing"` or `"ready"`
   */
  value: StateValue;
  /**
   * Additional contextual data related to the current state
   */
  context?: ContextFromExpert<TExpert>;
}

export type ObservedStateFrom<TActor extends ActorRefLike> = Pick<
  SnapshotFrom<TActor>,
  'value' | 'context'
>;

export type ExpertMemoryContext<TExpert extends AnyExpert> = {
  observations: ExpertObservation<any>[]; // TODO
  messages: ExpertMessage[];
  decisions: ExpertDecision<TExpert>[];
  feedback: ExpertFeedback[];
  insights: ExpertInsight[];
};

export type Compute<A extends any> = { [K in keyof A]: A[K] } & unknown;

export type MaybePromise<T> = T | Promise<T>;

export type EventFromExpert<T extends AnyExpert> = T extends Expert<
  infer _,
  infer TEventSchemas
>
  ? EventsFromZodEventMapping<TEventSchemas>
  : never;

export type TypesFromExpert<T extends AnyExpert> = T extends Expert<
  infer TContextSchema,
  infer TEventSchema
>
  ? {
      context: ContextFromZodContextMapping<TContextSchema>;
      events: EventsFromZodEventMapping<TEventSchema>;
    }
  : never;

export type ContextFromExpert<T extends AnyExpert> = T extends Expert<
  infer TContextSchema,
  infer _TEventSchema
>
  ? ContextFromZodContextMapping<TContextSchema>
  : never;

export interface StorageAdapter<TExpert extends AnyExpert, TQuery> {
  addObservation(
    observationInput: ExpertObservationInput<TExpert>
  ): Promise<ExpertObservation<any>>;
  getObservations(queryObject?: TQuery): Promise<ExpertObservation<any>[]>;
  addFeedback(feedbackInput: ExpertFeedbackInput): Promise<ExpertFeedback>;
  getFeedback(queryObject?: TQuery): Promise<ExpertFeedback[]>;
  addMessage(messageInput: ExpertMessageInput): Promise<ExpertMessage>;
  getMessages(queryObject?: TQuery): Promise<ExpertMessage[]>;
  addDecision(
    decisionInput: ExpertDecideInput<TExpert>
  ): Promise<ExpertDecision<TExpert>>;
  getDecisions(queryObject?: TQuery): Promise<ExpertDecision<TExpert>[]>;
}

export type StorageAdapterQuery<T extends StorageAdapter<any, any>> =
  T extends StorageAdapter<infer _, infer TQuery> ? TQuery : never;

export interface ExpertInsightInput extends BaseInput {
  observationId: string;
  attributes: Record<string, any>;
}

export interface ExpertInsight extends BaseProperties {
  observationId: string;
  attributes: Record<string, any>;
}

export type ExpertFlow<TExpert extends AnyExpert> = {
  transition: (
    state: ObservedState<TExpert>,
    event: EventFromExpert<TExpert>
  ) => [state: ObservedState<TExpert>, actions: any[]];
  initialTransition: (
    input: any
  ) => [state: ObservedState<TExpert>, actions: any[]];
  decide: (
    state: ObservedState<TExpert>
  ) => Promise<ExpertDecision<TExpert> | undefined>;
};
