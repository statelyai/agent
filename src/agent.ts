import {
  AnyEventObject,
  AnyStateMachine,
  createActor,
  EventObject,
  fromTransition,
  Observer,
  toObserver,
} from 'xstate';
import { ZodContextMapping, ZodEventMapping } from './schemas';
import {
  Agent,
  AgentLogic,
  AgentMessageHistory,
  AgentPlanner,
  EventsFromZodEventMapping,
  GenerateTextOptions,
  AgentLongTermMemory,
  AIAdapter,
  ObservedState,
  AgentObservationInput,
  AgentMemoryContext,
  AgentObservation,
  ContextFromZodContextMapping,
} from './types';
import { simplePlanner } from './planners/simplePlanner';
import { agentGenerateText, agentStreamText } from './text';
import { agentDecide } from './decision';
import { vercelAdapter } from './adapters/vercel';
import { getMachineHash, randomId } from './utils';
import { SomeZodObject, TypeOf } from 'zod';

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
  {
    feedback: [],
    messages: [],
    observations: [],
    plans: [],
  } as AgentMemoryContext
);

export function createAgent<
  const TContextSchema extends ZodContextMapping,
  const TEventSchemas extends ZodEventMapping,
  TEvents extends EventObject = EventsFromZodEventMapping<TEventSchemas>,
  TContext = ContextFromZodContextMapping<TContextSchema>
>({
  name,
  description,
  model,
  events,
  context,
  planner = simplePlanner as AgentPlanner<Agent<TContext, TEvents>>,
  stringify = JSON.stringify,
  getMemory,
  logic = agentLogic as AgentLogic<TEvents>,
  adapter = vercelAdapter,
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
  planner?: AgentPlanner<Agent<TContext, TEvents>>;
  stringify?: typeof JSON.stringify;
  /**
   * A function that retrieves the agent's long term memory
   */
  getMemory?: (agent: Agent<TContext, TEvents>) => AgentLongTermMemory;
  /**
   * Agent logic
   */
  logic?: AgentLogic<TEvents>;
  adapter?: AIAdapter;
} & GenerateTextOptions): Agent<TContext, TEvents> {
  const messageHistoryListeners: Observer<AgentMessageHistory>[] = [];

  const agent = createActor(logic) as unknown as Agent<TContext, TEvents>;
  agent.events = events;
  agent.model = model;
  agent.name = name;
  agent.description = description;
  agent.adapter = adapter;
  agent.defaultOptions = { ...generateTextOptions, model };
  agent.select = (selector) => {
    return selector(agent.getSnapshot().context);
  };
  agent.memory = getMemory ? getMemory(agent) : undefined;

  agent.onMessage = (callback) => {
    messageHistoryListeners.push(toObserver(callback));
  };

  agent.decide = (opts) => {
    return agentDecide(agent, opts);
  };

  agent.addMessage = (messageInput) => {
    const message = {
      ...messageInput,
      id: messageInput.id ?? randomId(),
      timestamp: messageInput.timestamp ?? Date.now(),
      sessionId: agent.sessionId,
    };
    agent.send({
      type: 'agent.message',
      message,
    });

    return message;
  };

  agent.generateText = (opts) => agentGenerateText(agent, opts);

  agent.streamText = (opts) => agentStreamText(agent, opts);

  agent.addFeedback = (feedbackInput) => {
    const feedback = {
      ...feedbackInput,
      timestamp: feedbackInput.timestamp ?? Date.now(),
      sessionId: agent.sessionId,
    };
    agent.send({
      type: 'agent.feedback',
      feedback,
    });
    return feedback;
  };

  agent.addObservation = (observationInput) => {
    const { prevState, event, state } = observationInput;
    const observation = {
      prevState,
      event,
      state,
      id: observationInput.id ?? randomId(),
      sessionId: agent.sessionId,
      timestamp: observationInput.timestamp ?? Date.now(),
      machineHash: observationInput.machine
        ? getMachineHash(observationInput.machine)
        : undefined,
    } satisfies AgentObservation<any>;

    agent.send({
      type: 'agent.observe',
      observation,
    });

    return observation;
  };

  agent.addPlan = (plan) => {
    agent.send({
      type: 'agent.plan',
      plan,
    });
  };

  agent.interact = (actorRef, getInput) => {
    let prevState: ObservedState | undefined = undefined;
    let subscribed = true;

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
    actorRef.system.inspect({
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
        subscribed = false;
      }, // TODO: make this actually unsubscribe
    };
  };

  agent.types = {} as any;

  agent.start();

  return agent;
}
