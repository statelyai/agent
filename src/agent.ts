import {
  Actor,
  AnyActorRef,
  AnyEventObject,
  AnyStateMachine,
  EventObject,
  fromTransition,
  Subscription,
} from 'xstate';
import { ZodContextMapping, ZodEventMapping } from './schemas';
import {
  AgentLogic,
  AgentMessage,
  AgentPlanner,
  EventsFromZodEventMapping,
  GenerateTextOptions,
  AgentLongTermMemory,
  ObservedState,
  AgentObservationInput,
  AgentMemoryContext,
  AgentObservation,
  ContextFromZodContextMapping,
  AgentFeedback,
  AgentMessageInput,
  AgentFeedbackInput,
  AgentPlan,
  AnyAgent,
  Compute,
  AgentDecisionInput,
  AgentDecideOptions,
} from './types';
import { simplePlanner } from './planners/simplePlanner';
import { agentDecide } from './decision';
import { getMachineHash, randomId } from './utils';
import {
  experimental_wrapLanguageModel,
  LanguageModel,
  LanguageModelV1,
} from 'ai';
import { createAgentMiddleware } from './middleware';

export const agentLogic: AgentLogic<AnyEventObject> = fromTransition(
  (state, event, { emit }) => {
    switch (event.type) {
      case 'agent.feedback': {
        state.feedback.push(event.feedback);
        emit({
          type: 'feedback',
          // @ts-ignore TODO: fix types in XState
          feedback: event.feedback,
        });
        break;
      }
      case 'agent.observe': {
        state.observations.push(event.observation);
        emit({
          type: 'observation',
          // @ts-ignore TODO: fix types in XState
          observation: event.observation,
        });
        break;
      }
      case 'agent.message': {
        state.messages.push(event.message);
        emit({
          type: 'message',
          // @ts-ignore TODO: fix types in XState
          message: event.message,
        });
        break;
      }
      case 'agent.plan': {
        state.plans.push(event.plan);
        emit({
          type: 'plan',
          // @ts-ignore TODO: fix types in XState
          plan: event.plan,
        });
        break;
      }
      default:
        break;
    }
    return state;
  },
  () =>
    ({
      feedback: [],
      messages: [],
      observations: [],
      plans: [],
    } as AgentMemoryContext)
);

export function createAgent<
  const TContextSchema extends ZodContextMapping,
  const TEventSchemas extends ZodEventMapping,
  TEvents extends EventObject = EventsFromZodEventMapping<TEventSchemas>,
  TContext = ContextFromZodContextMapping<TContextSchema>
>({
  id,
  name,
  description,
  model,
  events,
  context,
  planner = simplePlanner as AgentPlanner<Agent<TContextSchema, TEventSchemas>>,
  stringify = JSON.stringify,
  getMemory,
  logic = agentLogic as AgentLogic<TEvents>,
  ...generateTextOptions
}: {
  /**
   * The unique identifier for the agent.
   *
   * This should be the same across all sessions of a specific agent, as it can be
   * used to retrieve memory for this agent.
   *
   * @example
   * ```ts
   * const agent = createAgent({
   *  id: 'recipe-assistant',
   *  // ...
   * });
   * ```
   */
  id?: string;
  /**
   * The name of the agent
   */
  name?: string;
  /**
   * A description of the role of the agent
   */
  description?: string;
  /**
   * Events that the agent can cause (send) in an environment
   * that the agent knows about.
   */
  events: TEventSchemas;
  context?: TContextSchema;
  planner?: AgentPlanner<Agent<TContextSchema, TEventSchemas>>;
  stringify?: typeof JSON.stringify;
  /**
   * A function that retrieves the agent's long term memory
   */
  getMemory?: (
    agent: Agent<TContextSchema, TEventSchemas>
  ) => AgentLongTermMemory;
  /**
   * Agent logic
   */
  logic?: AgentLogic<TEvents>;
} & GenerateTextOptions): Agent<TContextSchema, TEventSchemas> {
  return new Agent({
    id,
    context,
    events,
    name,
    description,
    planner,
    model,
    logic,
  }) as any;
  // const agent = createActor(logic) as unknown as Agent<TContext, TEvents>;
  // agent.events = events;
  // agent.model = model;
  // agent.name = name;
  // agent.description = description;
  // agent.defaultOptions = { ...generateTextOptions, model };
  // agent.memory = getMemory ? getMemory(agent) : undefined;

  // agent.onMessage = (callback) => {
  //   agent.on('message', (ev) => callback(ev.message));
  // };

  // agent.decide = (opts) => {
  //   return agentDecide(agent, opts);
  // };

  // agent.addMessage = (messageInput) => {
  //   const message = {
  //     ...messageInput,
  //     id: messageInput.id ?? randomId(),
  //     timestamp: messageInput.timestamp ?? Date.now(),
  //     sessionId: agent.sessionId,
  //   } satisfies AgentMessage;
  //   agent.send({
  //     type: 'agent.message',
  //     message,
  //   });

  //   return message;
  // };
  // agent.getMessages = () => agent.getSnapshot().context.messages;

  // agent.addFeedback = (feedbackInput) => {
  //   const feedback = {
  //     ...feedbackInput,
  //     attributes: { ...feedbackInput.attributes },
  //     reward: feedbackInput.reward ?? 0,
  //     timestamp: feedbackInput.timestamp ?? Date.now(),
  //     sessionId: agent.sessionId,
  //   } satisfies AgentFeedback;
  //   agent.send({
  //     type: 'agent.feedback',
  //     feedback,
  //   });
  //   return feedback;
  // };
  // agent.getFeedback = () => agent.getSnapshot().context.feedback;

  // agent.addObservation = (observationInput) => {
  //   const { prevState, event, state } = observationInput;
  //   const observedState = { context: state.context, value: state.value };
  //   const observedPrevState = prevState
  //     ? {
  //         context: prevState.context,
  //         value: prevState.value,
  //       }
  //     : undefined;
  //   const observation = {
  //     prevState: observedPrevState,
  //     event,
  //     state: observedState,
  //     id: observationInput.id ?? randomId(),
  //     sessionId: agent.sessionId,
  //     timestamp: observationInput.timestamp ?? Date.now(),
  //     machineHash: observationInput.machine
  //       ? getMachineHash(observationInput.machine)
  //       : undefined,
  //   } satisfies AgentObservation<any>;

  //   agent.send({
  //     type: 'agent.observe',
  //     observation,
  //   });

  //   return observation;
  // };
  // agent.getObservations = () => agent.getSnapshot().context.observations;

  // agent.addPlan = (plan) => {
  //   agent.send({
  //     type: 'agent.plan',
  //     plan,
  //   });
  // };
  // agent.getPlans = () => agent.getSnapshot().context.plans;

  // agent.interact = ((actorRef, getInput) => {
  //   let prevState: ObservedState | undefined = undefined;
  //   let subscribed = true;

  //   async function handleObservation(observationInput: AgentObservationInput) {
  //     const observation = agent.addObservation(observationInput);

  //     const input = getInput?.(observation);

  //     if (input) {
  //       await agentDecide(agent, {
  //         machine: actorRef.src as AnyStateMachine,
  //         state: observation.state,
  //         execute: async (event) => {
  //           actorRef.send(event);
  //         },
  //         ...input,
  //       });
  //     }

  //     prevState = observationInput.state;
  //   }

  //   // Inspect system, but only observe specified actor
  //   const sub = actorRef.system.inspect({
  //     next: async (inspEvent) => {
  //       if (
  //         !subscribed ||
  //         inspEvent.actorRef !== actorRef ||
  //         inspEvent.type !== '@xstate.snapshot'
  //       ) {
  //         return;
  //       }

  //       const observationInput = {
  //         event: inspEvent.event,
  //         prevState,
  //         state: inspEvent.snapshot as any,
  //         machine: (actorRef as any).src,
  //       } satisfies AgentObservationInput;

  //       await handleObservation(observationInput);
  //     },
  //   });

  //   // If actor already started, interact with current state
  //   if ((actorRef as any)._processingStatus === 1) {
  //     handleObservation({
  //       prevState: undefined,
  //       event: { type: '' }, // TODO: unknown events?
  //       state: actorRef.getSnapshot(),
  //       machine: (actorRef as any).src,
  //     });
  //   }

  //   return {
  //     unsubscribe: () => {
  //       sub.unsubscribe();
  //       subscribed = false;
  //     },
  //   };
  // }) as typeof agent.interact;

  // agent.observe = (actorRef) => {
  //   let prevState: ObservedState = actorRef.getSnapshot();

  //   const sub = actorRef.system.inspect({
  //     next: async (inspEvent) => {
  //       if (
  //         inspEvent.actorRef !== actorRef ||
  //         inspEvent.type !== '@xstate.snapshot'
  //       ) {
  //         return;
  //       }

  //       const observationInput = {
  //         event: inspEvent.event,
  //         prevState,
  //         state: inspEvent.snapshot as any,
  //         machine: (actorRef as any).src,
  //       } satisfies AgentObservationInput;

  //       prevState = observationInput.state;

  //       agent.addObservation(observationInput);
  //     },
  //   });

  //   return sub;
  // };

  // agent.types = {} as any;

  // agent.wrap = (modelToWrap) =>
  //   experimental_wrapLanguageModel({
  //     model: modelToWrap,
  //     middleware: createAgentMiddleware(agent),
  //   });

  // agent.model = experimental_wrapLanguageModel({
  //   model,
  //   middleware: createAgentMiddleware(agent),
  // });

  // agent.start();

  // return agent;
}

export class Agent<
  const TContextSchema extends ZodContextMapping,
  const TEventSchemas extends ZodEventMapping,
  TEvents extends EventObject = EventsFromZodEventMapping<TEventSchemas>,
  TContext = ContextFromZodContextMapping<TContextSchema>
> extends Actor<AgentLogic<TEvents>> {
  /**
   * The name of the agent. All agents with the same name are related and
   * able to share experiences (observations, feedback) with each other.
   */
  public name?: string;
  /**
   * The unique identifier for the agent.
   */
  public id: string;
  public description?: string;
  public events: TEventSchemas;
  public context?: TContextSchema;
  public planner?: AgentPlanner<Agent<TContextSchema, TEventSchemas>>;
  public types: {
    events: TEvents;
    context: Compute<TContext>;
  };
  public model: LanguageModel;
  public memory: AgentLongTermMemory | undefined;
  public defaultOptions: any; // todo

  constructor({
    logic = agentLogic as AgentLogic<TEvents>,
    id,
    name,
    description,
    model,
    events,
    context,
    planner = simplePlanner,
  }: {
    logic: AgentLogic<TEvents>;
    id?: string;
    name?: string;
    description?: string;
    model: GenerateTextOptions['model'];
    events: TEventSchemas;
    context?: TContextSchema;
    planner?: AgentPlanner<Agent<TContextSchema, TEventSchemas>>;
  }) {
    super(logic);
    this.model = model;
    this.id = id ?? '';
    this.name = name;
    this.description = description;
    this.events = events;
    this.context = context;
    this.planner = planner;
    this.types = {} as any;

    this.start();
  }

  /**
   * Called whenever the agent (LLM assistant) receives or sends a message.
   */
  public onMessage(fn: (message: AgentMessage) => void) {
    return this.on('message', (ev) => fn(ev.message));
  }

  /**
   * Retrieves messages from the agent's short-term (local) memory.
   */
  public addMessage(messageInput: AgentMessageInput) {
    const message = {
      ...messageInput,
      id: messageInput.id ?? randomId(),
      timestamp: messageInput.timestamp ?? Date.now(),
      sessionId: this.sessionId,
    } satisfies AgentMessage;
    this.send({
      type: 'agent.message',
      message,
    });

    return message;
  }

  public getMessages() {
    return this.getSnapshot().context.messages;
  }

  public addFeedback(feedbackInput: AgentFeedbackInput) {
    const feedback = {
      ...feedbackInput,
      attributes: { ...feedbackInput.attributes },
      reward: feedbackInput.reward ?? 0,
      timestamp: feedbackInput.timestamp ?? Date.now(),
      sessionId: this.sessionId,
    } satisfies AgentFeedback;
    this.send({
      type: 'agent.feedback',
      feedback,
    });
    return feedback;
  }

  /**
   * Retrieves feedback from the agent's short-term (local) memory.
   */
  public getFeedback() {
    return this.getSnapshot().context.feedback;
  }

  public addObservation(
    observationInput: AgentObservationInput
  ): AgentObservation<any> {
    const { prevState, event, state } = observationInput;
    const observation = {
      prevState,
      event,
      state,
      id: observationInput.id ?? randomId(),
      sessionId: this.sessionId,
      timestamp: observationInput.timestamp ?? Date.now(),
      machineHash: observationInput.machine
        ? getMachineHash(observationInput.machine)
        : undefined,
    } satisfies AgentObservation<any>;

    this.send({
      type: 'agent.observe',
      observation,
    });

    return observation;
  }

  /**
   * Retrieves observations from the agent's short-term (local) memory.
   */
  public getObservations() {
    return this.getSnapshot().context.observations;
  }

  public addPlan(plan: AgentPlan<TEvents>) {
    this.send({
      type: 'agent.plan',
      plan,
    });
  }
  /**
   * Retrieves strategies from the agent's short-term (local) memory.
   */
  public getPlans() {
    return this.getSnapshot().context.plans;
  }

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
  public interact<TActor extends AnyActorRef>(actorRef: TActor): Subscription;
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
  public interact<TActor extends AnyActorRef>(
    actorRef: TActor,
    getInput: (
      observation: AgentObservation<TActor>
    ) => AgentDecisionInput | undefined
  ): Subscription;
  public interact<TActor extends AnyActorRef>(
    actorRef: TActor,
    getInput?: (
      observation: AgentObservation<TActor>
    ) => AgentDecisionInput | undefined
  ): Subscription {
    let prevState: ObservedState | undefined = undefined;
    let subscribed = true;

    const agent = this;

    async function handleObservation(observationInput: AgentObservationInput) {
      const observation = agent.addObservation(observationInput);

      const input = getInput?.(observation);

      if (input) {
        await agentDecide(agent, {
          machine: actorRef.src as AnyStateMachine,
          state: observation.state,
          execute: async (event) => {
            actorRef.send(event);
          },
          ...input,
        });
      }

      prevState = observationInput.state;
    }

    // Inspect system, but only observe specified actor
    const sub = actorRef.system.inspect({
      next: async (inspEvent) => {
        if (
          !subscribed ||
          inspEvent.actorRef !== actorRef ||
          inspEvent.type !== '@xstate.snapshot'
        ) {
          return;
        }

        const observationInput = {
          event: inspEvent.event,
          prevState,
          state: inspEvent.snapshot as any,
          machine: (actorRef as any).src,
        } satisfies AgentObservationInput;

        await handleObservation(observationInput);
      },
    });

    // If actor already started, interact with current state
    if ((actorRef as any)._processingStatus === 1) {
      handleObservation({
        prevState: undefined,
        event: { type: '' }, // TODO: unknown events?
        state: actorRef.getSnapshot(),
        machine: (actorRef as any).src,
      });
    }

    return {
      unsubscribe: () => {
        sub.unsubscribe();
        subscribed = false;
      },
    };
  }

  public observe<TActor extends AnyActorRef>(actorRef: TActor) {
    let prevState: ObservedState = actorRef.getSnapshot();

    const sub = actorRef.system.inspect({
      next: async (inspEvent) => {
        if (
          inspEvent.actorRef !== actorRef ||
          inspEvent.type !== '@xstate.snapshot'
        ) {
          return;
        }

        const observationInput = {
          event: inspEvent.event,
          prevState,
          state: inspEvent.snapshot as any,
          machine: (actorRef as any).src,
        } satisfies AgentObservationInput;

        prevState = observationInput.state;

        this.addObservation(observationInput);
      },
    });

    return sub;
  }

  public wrap(modelToWrap: LanguageModelV1) {
    return experimental_wrapLanguageModel({
      model: modelToWrap,
      middleware: createAgentMiddleware(this),
    });
  }

  /**
   * Resolves with an `AgentPlan` based on the information provided in the `options`, including:
   *
   * - The `goal` for the agent to achieve
   * - The observed current `state`
   * - The `machine` (e.g. a state machine) that specifies what can happen next
   * - Additional `context`
   */
  public decide(opts: AgentDecideOptions) {
    return agentDecide(this, opts);
  }
}
