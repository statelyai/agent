import {
  Actor,
  ActorRefLike,
  createMachine,
  enqueueActions,
  EventObject,
  fromPromise,
  fromTransition,
  initialTransition,
  MachineConfig,
  SnapshotFrom,
  Subscription,
  transition,
} from 'xstate';
import { ZodContextMapping, ZodEventMapping } from './schemas';
import {
  ExpertLogic,
  ExpertMessage,
  ExpertPolicy,
  GenerateTextOptions,
  ObservedState,
  ExpertObservationInput,
  ExpertMemoryContext,
  ExpertObservation,
  ExpertFeedback,
  ExpertMessageInput,
  ExpertFeedbackInput,
  ExpertDecision,
  AnyExpert,
  ExpertInteractInput,
  ExpertDecideInput,
  EventFromExpert,
  ExpertInsightInput,
  ExpertInsight,
  ExpertDecisionInput,
  ContextFromZodContextMapping,
  EventsFromZodEventMapping,
  ExpertFlow,
} from './types';
import { toolPolicy } from './policies/toolPolicy';
import { isActorRef, isMachineActor, randomId } from './utils';
import {
  CoreMessage,
  wrapLanguageModel,
  LanguageModel,
  LanguageModelV1,
} from 'ai';
import { createExpertMiddleware } from './middleware';

export const expertLogic: ExpertLogic<any> = fromTransition(
  (state, event, { emit }) => {
    switch (event.type) {
      case 'expert.feedback': {
        state.feedback.push(event.feedback);
        emit({
          type: 'feedback',
          feedback: event.feedback,
        });
        break;
      }
      case 'expert.observe': {
        state.observations.push(event.observation);
        emit({
          type: 'observation',
          observation: event.observation,
        });
        break;
      }
      case 'expert.message': {
        state.messages.push(event.message);
        emit({
          type: 'message',
          message: event.message,
        });
        break;
      }
      case 'expert.decision': {
        state.decisions.push(event.decision);
        emit({
          type: 'decision',
          decision: event.decision,
        });
        break;
      }
      case 'expert.insight': {
        state.insights.push(event.insight);
        emit({
          type: 'insight',
          insight: event.insight,
        });
        break;
      }
      default: {
        console.warn('Unrecognized event', event);
        break;
      }
    }
    return state;
  },
  () =>
    ({
      feedback: [],
      messages: [],
      observations: [],
      decisions: [],
      insights: [],
    } as ExpertMemoryContext<any>)
);

export function createExpert<
  const TContextSchema extends ZodContextMapping,
  const TEventSchemas extends ZodEventMapping,
  TExpert extends AnyExpert = Expert<TContextSchema, TEventSchemas>
>({
  id,
  description,
  model,
  events,
  context,
  episodeId,
  policy = toolPolicy,
  logic = expertLogic,
}: {
  /**
   * The unique identifier for the expert.
   *
   * This should be the same across all episodes of a specific expert, as it can be
   * used to retrieve memory for previous episodes of this expert.
   *
   * @example
   * ```ts
   * const expert = createExpert({
   *  id: 'recipe-assistant',
   *  // ...
   * });
   * ```
   */
  id?: string;
  /**
   * A description of the role of the expert.
   */
  description?: string;
  /**
   * Event schemas for events that the expert can trigger in an environment.
   */
  events: TEventSchemas;
  /**
   * The state context schema for the states that the expert can observe.
   */
  context?: TContextSchema;
  /**
   * The default policy to use for `expert.decide(…)`.
   *
   * A policy is a strategy that the expert uses to decide which event to trigger next.
   */
  policy?: ExpertPolicy<Expert<TContextSchema, TEventSchemas>>;
  /**
   * Custom expert logic, which receives events for handling feedback,
   * observations, messages, decisions, and insights.
   */
  logic?: ExpertLogic<TExpert>;
  /**
   * The default language model for the expert to use in `expert.decide(…)`.
   */
  model: LanguageModel;
  /**
   * The unique episode ID that this expert will run on.
   *
   * An episode is an instance of an expert interacting with an environment.
   */
  episodeId?: string;
}): Expert<TContextSchema, TEventSchemas> {
  return new Expert({
    id,
    context,
    events,
    description,
    policy: policy,
    model,
    logic,
    episodeId,
  }) as any;
}

export class Expert<
  const TContextSchema extends ZodContextMapping,
  const TEventSchemas extends ZodEventMapping
> extends Actor<ExpertLogic<any>> {
  /**
   * The name of the expert. All experts with the same name are related and
   * able to share experiences (observations, feedback) with each other.
   */
  public name?: string;
  /**
   * The unique identifier for the expert.
   */
  public episodeId: string;
  public description?: string;
  public events: TEventSchemas;
  public context?: TContextSchema;
  public policy: ExpertPolicy<Expert<TContextSchema, TEventSchemas>>;
  public model: LanguageModel;

  constructor({
    logic = expertLogic as ExpertLogic<any>,
    id,
    name,
    description,
    model,
    events,
    context,
    episodeId,
    policy = toolPolicy,
  }: {
    logic: ExpertLogic<any>;
    id?: string;
    name?: string;
    description?: string;
    model: GenerateTextOptions['model'];
    events: TEventSchemas;
    context?: TContextSchema;
    policy?: ExpertPolicy<Expert<TContextSchema, TEventSchemas>>;
    episodeId?: string;
  }) {
    super(logic);
    this.model = model;
    this.episodeId = episodeId ?? randomId('episode-');
    this.name = name;
    this.description = description;
    this.events = events;
    this.context = context;
    this.policy = policy;
    this.id = id ?? randomId();

    this.start();
  }

  /**
   * Called whenever the expert detects that a message was sent from the human, assistant, or system.
   */
  public onMessage(fn: (message: ExpertMessage) => void) {
    return this.on('message', (ev) => fn(ev.message));
  }

  /**
   * Called whenever the expert receives some feedback.
   */
  public onFeedback(fn: (feedback: ExpertFeedback) => void) {
    return this.on('feedback', (ev) => fn(ev.feedback));
  }

  /**
   * Called whenever the expert receives an observation.
   */
  public onObservation(fn: (observation: ExpertObservation<this>) => void) {
    return this.on('observation', (ev) => fn(ev.observation));
  }

  /**
   * Called whenever the expert makes a decision.
   */
  public onDecision(fn: (decision: ExpertDecision<this>) => void) {
    return this.on('decision', (ev) => fn(ev.decision));
  }

  /**
   * Adds a message to the expert's short-term (local) memory.
   */
  public addMessage(messageInput: ExpertMessageInput): ExpertMessage {
    const message = {
      ...messageInput,
      id: messageInput.id ?? randomId(),
      timestamp: messageInput.timestamp ?? Date.now(),
      episodeId: this.episodeId,
    } satisfies ExpertMessage;
    this.send({
      type: 'expert.message',
      message,
    });

    return message;
  }

  public getMessages() {
    return this.getSnapshot().context.messages;
  }

  public addFeedback(feedbackInput: ExpertFeedbackInput) {
    const feedback = {
      ...feedbackInput,
      id: feedbackInput.id ?? randomId(),
      comment: feedbackInput.comment ?? undefined,
      attributes: { ...feedbackInput.attributes },
      timestamp: feedbackInput.timestamp ?? Date.now(),
      episodeId: feedbackInput.episodeId ?? this.episodeId,
    } satisfies ExpertFeedback;
    this.send({
      type: 'expert.feedback',
      feedback,
    });
    return feedback;
  }

  /**
   * Retrieves feedback from the expert's short-term (local) memory.
   */
  public getFeedback() {
    return this.getSnapshot().context.feedback;
  }

  public addObservation(
    observationInput: ExpertObservationInput<this>
  ): ExpertObservation<any> {
    const { prevState, event, state } = observationInput;
    const observation = {
      prevState,
      event,
      state,
      id: observationInput.id ?? randomId(),
      episodeId: observationInput.episodeId ?? this.episodeId,
      timestamp: observationInput.timestamp ?? Date.now(),
      decisionId: observationInput.decisionId,
      // machineHash: observationInput.machine
      //   ? getMachineHash(observationInput.machine)
      //   : undefined,
    } satisfies ExpertObservation<any>;

    this.send({
      type: 'expert.observe',
      observation,
    });

    return observation;
  }

  /**
   * Retrieves observations from the expert's short-term (local) memory.
   */
  public getObservations() {
    return this.getSnapshot().context.observations;
  }

  public addInsight(insightInput: ExpertInsightInput): ExpertInsight {
    const insight = {
      ...insightInput,
      episodeId: insightInput.episodeId ?? this.episodeId,
      id: insightInput.id ?? randomId(),
      timestamp: insightInput.timestamp ?? Date.now(),
    } satisfies ExpertInsight;

    this.send({
      type: 'expert.insight',
      insight,
    });

    return insight;
  }

  public getInsights() {
    return this.getSnapshot().context.insights;
  }

  public addDecision(input: ExpertDecisionInput<this>) {
    this.send({
      type: 'expert.decision',
      decision: {
        id: input.id ?? randomId(),
        episodeId: input.episodeId ?? this.episodeId,
        timestamp: input.timestamp ?? Date.now(),
        decisionId: input.decisionId ?? null,
        policy: input.policy ?? null,
        goalState: input.goalState ?? null,
        nextEvent: input.nextEvent ?? null,
        paths: input.paths ?? [],
        ...input,
      },
    });
  }
  /**
   * Retrieves strategies from the expert's short-term (local) memory.
   */
  public getDecisions() {
    return this.getSnapshot().context.decisions;
  }

  /**
   * Interacts with this state machine actor by inspecting state transitions and storing them as observations.
   *
   * Observations contain the `prevState`, `event`, and current `state` of this
   * actor, as well as other properties that are useful when recalled.
   * These observations are stored in the `expert`'s short-term (local) memory
   * and can be retrieved via `expert.getObservations()`.
   *
   * @example
   * ```ts
   * // Only observes the actor's state transitions
   * expert.interact(actor);
   *
   * actor.start();
   * ```
   */
  public interact<TActor extends ActorRefLike>(actorRef: TActor): Subscription;
  /**
   * Interacts with this state machine actor by:
   * 1. Inspecting state transitions and storing them as observations
   * 2. Deciding what to do next (which event to send the actor) based on
   * the expert input returned from `getInput(observation)`, if `getInput(…)` is provided as the 2nd argument.
   *
   * Observations contain the `prevState`, `event`, and current `state` of this
   * actor, as well as other properties that are useful when recalled.
   * These observations are stored in the `expert`'s short-term (local) memory
   * and can be retrieved via `expert.getObservations()`.
   *
   * @example
   * ```ts
   * // Observes the actor's state transitions and
   * // makes a decision if on the "summarize" state
   * expert.interact(actor, observed => {
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
  public interact<TActor extends ActorRefLike>(
    actorRef: TActor,
    getInput: (
      observation: ExpertObservation<TActor>
    ) => ExpertInteractInput<this> | void
  ): Subscription;
  public interact<TActor extends ActorRefLike>(
    actorRef: TActor,
    getInput?: (
      observation: ExpertObservation<TActor>
    ) => ExpertInteractInput<this> | void
  ): Subscription {
    const actorRefCheck = isActorRef(actorRef) && actorRef.src;
    const machine = isMachineActor(actorRef) ? actorRef.src : undefined;

    let prevState: ObservedState<this> | undefined = undefined;
    let subscribed = true;

    const expert = this;

    const handleObservation = async (
      observationInput: ExpertObservationInput<any>
    ) => {
      const observation = expert.addObservation(observationInput);

      const interactInput = getInput?.(observation);

      if (interactInput) {
        const decision = await this.decide({
          machine,
          state: observation.state,
          ...interactInput,
        });

        if (decision?.nextEvent) {
          // @ts-ignore
          decision.nextEvent['_decision'] = decision.id;
          actorRef.send(decision.nextEvent);
        }
      }

      prevState = observationInput.state;
    };

    // Inspect system, but only observe specified actor
    const sub = actorRefCheck
      ? actorRef.system.inspect({
          next: async (inspEvent) => {
            if (
              !subscribed ||
              inspEvent.actorRef !== actorRef ||
              inspEvent.type !== '@xstate.snapshot'
            ) {
              return;
            }

            const decisionId = inspEvent.event['_decision'] as
              | string
              | undefined;

            const decisions = expert.getDecisions();

            const decision = decisionId
              ? decisions.find((d) => d.id === decisionId)
              : undefined;

            const observationInput = {
              event: inspEvent.event,
              prevState,
              state: inspEvent.snapshot as SnapshotFrom<TActor>,
              goal: decision?.goal,
              decisionId,
            } satisfies ExpertObservationInput<any>;

            await handleObservation(observationInput);
          },
        })
      : undefined;

    // If actor already started, interact with current state
    if ((actorRef as any)._processingStatus === 1) {
      handleObservation({
        decisionId: undefined,
        prevState: undefined,
        event: undefined,
        state: actorRef.getSnapshot(),
      });
    }

    return {
      unsubscribe: () => {
        sub?.unsubscribe();
        subscribed = false;
      },
    };
  }

  public observe<TActor extends ActorRefLike>(actorRef: TActor): Subscription {
    let prevState: ObservedState<this> = actorRef.getSnapshot();
    const actorRefCheck = isActorRef(actorRef);

    const sub = actorRefCheck
      ? actorRef.system.inspect({
          next: async (inspEvent) => {
            if (
              inspEvent.actorRef !== actorRef ||
              inspEvent.type !== '@xstate.snapshot'
            ) {
              return;
            }

            const decisionId = inspEvent.event['_decision'] as
              | string
              | undefined;

            const decisions = this.getDecisions();

            const decision = decisionId
              ? decisions.find((d) => d.id === decisionId)
              : undefined;

            const observationInput = {
              decisionId,
              event: inspEvent.event,
              prevState,
              state: inspEvent.snapshot as SnapshotFrom<TActor>,
              goal: decision?.goal,
            } satisfies ExpertObservationInput<this>;

            prevState = observationInput.state;

            this.addObservation(observationInput);
          },
        })
      : undefined;

    return sub ?? { unsubscribe: () => {} };
  }

  public wrap(modelToWrap: LanguageModelV1) {
    return wrapLanguageModel({
      model: modelToWrap,
      middleware: createExpertMiddleware(this),
    });
  }

  /**
   * Resolves with an `ExpertDecision` based on the information provided in the `options`, including:
   *
   * - The `goal` for the expert to achieve
   * - The observed current `state`
   * - The `machine` (e.g. a state machine) that specifies what can happen next
   * - Additional `context`
   */
  public async decide(
    input: ExpertDecideInput<this>
  ): Promise<ExpertDecision<this> | undefined> {
    const resolvedOptions = input;
    const {
      policy = this.policy,
      goal,
      allowedEvents,
      events = this.events,
      state,
      machine,
      model = this.model,
      messages,
      episodeId = this.episodeId,
      maxAttempts = 2,
      ...otherDecideInput
    } = resolvedOptions;

    const filteredEventSchemas = allowedEvents
      ? Object.fromEntries(
          Object.entries(events).filter(([key]) => {
            return allowedEvents.includes(key as EventFromExpert<this>['type']);
          })
        )
      : events;

    let attempts = 0;

    let decision: ExpertDecision<this> | undefined;

    const minimalState = {
      value: state.value,
      context: state.context,
    };

    while (attempts++ < maxAttempts) {
      decision = await policy(this, {
        episodeId,
        model,
        goal,
        events: filteredEventSchemas,
        state: minimalState,
        machine,
        messages: messages as CoreMessage[], // TODO: fix UIMessage thing
        ...otherDecideInput,
      });

      if (decision?.nextEvent) {
        this.addDecision(decision);
        break;
      }
    }

    return decision;
  }

  public createFlow<T extends Record<string, any>>(flowConfig: {
    initial: string;
    context: (input: any) => ContextFromZodContextMapping<TContextSchema>;
    states: {
      [K in keyof T]: {
        type?: 'final';
        goal?: string;
        on?: {
          [K in keyof TEventSchemas]?: TransitionOutput<
            ContextFromZodContextMapping<TContextSchema>,
            EventsFromZodEventMapping<TEventSchemas> & { type: K }
          >;
        };
        invoke?: {
          src: (input: {
            context: ContextFromZodContextMapping<TContextSchema>;
            event: EventsFromZodEventMapping<TEventSchemas>;
          }) => Promise<T[K]>;
          onDone?: TransitionOutput<
            ContextFromZodContextMapping<TContextSchema>,
            { type: 'done'; output: T[K] }
          >;
        };
        entry?: FlowAction<
          ContextFromZodContextMapping<TContextSchema>,
          EventsFromZodEventMapping<TEventSchemas>
        >;
        exit?: FlowAction<
          ContextFromZodContextMapping<TContextSchema>,
          EventsFromZodEventMapping<TEventSchemas>
        >;
      };
    };
    on?: {
      [K in keyof TEventSchemas]?: TransitionOutput<
        ContextFromZodContextMapping<TContextSchema>,
        EventsFromZodEventMapping<TEventSchemas> & { type: K }
      >;
    };
    invoke?: {
      src: () => Promise<any>;
      onDone?: FlowAction<ContextFromZodContextMapping<TContextSchema>, any>;
    };
    entry?: FlowAction<
      ContextFromZodContextMapping<TContextSchema>,
      EventsFromZodEventMapping<TEventSchemas>
    >;
    exit?: FlowAction<
      ContextFromZodContextMapping<TContextSchema>,
      EventsFromZodEventMapping<TEventSchemas>
    >;
  }): ExpertFlow<this> {
    const machineConfig: MachineConfig<any, any, any, any, any> = {
      initial: flowConfig.initial,
      context: flowConfig.context,
      states: {},
      entry: flowConfig.entry,
      exit: flowConfig.exit,
      on: {},
    };

    for (const event of Object.keys(flowConfig.on ?? {})) {
      const transition = flowConfig.on![event]!;
      machineConfig.on![event] = transitionOutputToObject(transition);
    }

    for (const state of Object.keys(flowConfig.states)) {
      const stateConfig = flowConfig.states[state]!;
      machineConfig.states![state] = {
        type: stateConfig.type,
        entry: stateConfig.entry,
        exit: stateConfig.exit,
        on: {},
      };

      machineConfig.on![`_nav.${state}`] = {
        target: `.${state}`,
      };

      for (const event of Object.keys(flowConfig.states[state]!.on ?? {})) {
        const transition = flowConfig.states[state]!.on![event]!;
        machineConfig.states![state]!.on![event] =
          transitionOutputToObject(transition);
      }

      const invoked: any[] = [];

      if (stateConfig.invoke) {
        invoked.push({
          src: fromPromise(({ input }) =>
            stateConfig.invoke!.src(input as any)
          ),
          input: ({ context, event }: any) => ({ context, event }),
          onDone: stateConfig.invoke.onDone
            ? transitionOutputToObject(stateConfig.invoke.onDone)
            : undefined,
        });
      }

      if (stateConfig.goal) {
        machineConfig.states![state]!.meta = {
          goal: stateConfig.goal,
        };
      }

      machineConfig.states![state]!.invoke = invoked;

      machineConfig.states![state]!.entry = stateConfig.entry;
      machineConfig.states![state]!.exit = stateConfig.exit;
    }

    const machine = createMachine(machineConfig);

    return {
      initialTransition: (input) => {
        return initialTransition(machine, input);
      },
      transition: (state, event) => {
        return transition(
          machine,
          machine.resolveState({ context: {}, ...state }),
          event
        );
      },
      decide: (s) => {
        const state = machine.resolveState(s as any);
        const goals = Object.values(state.getMeta()).map((m) => m?.goal);
        console.log({ goals });

        return this.decide({
          state,
          goal: goals[0],
          machine,
        });
      },
    };
  }
}

type FlowAction<TContext, TEvent extends EventObject> = ({
  context,
  event,
}: {
  context: TContext;
  event: TEvent;
}) => void;

type TransitionOutput<TContext, TEvent extends EventObject> =
  | (({ context, event }: { context: TContext; event: TEvent }) => {
      target?: string;
      context?: TContext;
    })
  | {
      target?: string;
      context?: TContext;
    };

function transitionOutputToObject(transition: TransitionOutput<any, any>) {
  if (typeof transition === 'function') {
    return {
      actions: enqueueActions(({ context, event, enqueue }) => {
        const res = transition({ context, event } as any);

        if (res.context) {
          enqueue.assign(res.context);
        }

        if (res.target) {
          enqueue.raise({
            type: `_nav.${res.target}`,
          });
        }
      }),
    };
  } else {
    return transition;
  }
}
