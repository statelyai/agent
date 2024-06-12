import {
  AnyEventObject,
  AnyStateMachine,
  createActor,
  EventObject,
  fromTransition,
  Observer,
  toObserver,
} from 'xstate';
import { ZodEventMapping } from './schemas';
import {
  Agent,
  AgentContext,
  AgentLogic,
  AgentMessageHistory,
  AgentPlanner,
  EventsFromZodEventMapping,
  GenerateTextOptions,
  AgentLongTermMemory,
  AIAdapter,
  ObservedState,
  AgentObservationInput,
} from './types';
import { simplePlanner } from './planners/simplePlanner';
import { randomUUID } from 'crypto';
import { agentGenerateText, agentStreamText } from './text';
import { agentDecide } from './decision';
import { vercelAdapter } from './adapters/vercel';

export const agentLogic: AgentLogic<AnyEventObject> = fromTransition(
  (state, event, { emit }) => {
    switch (event.type) {
      case 'agent.feedback': {
        state.feedback.push(event.feedback);
        emit({
          type: 'feedback',
          // @ts-ignore TODO: fix types in XState
          feedback,
        });
        break;
      }
      case 'agent.observe': {
        state.observations.push(event.observation);
        emit({
          type: 'observation',
          // @ts-ignore TODO: fix types in XState
          observation,
        });
        break;
      }
      case 'agent.message': {
        state.messages.push(event.message);
        emit({
          type: 'message',
          // @ts-ignore TODO: fix types in XState
          message,
        });
        break;
      }
      case 'agent.plan': {
        state.plans.push(event.plan);
        emit({
          type: 'plan',
          // @ts-ignore TODO: fix types in XState
          plan,
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
  } as AgentContext
);

export function createAgent<
  const TEventSchemas extends ZodEventMapping,
  TEvents extends EventObject = EventsFromZodEventMapping<TEventSchemas>
>({
  name,
  description,
  model,
  events,
  planner = simplePlanner as AgentPlanner<Agent<TEvents>>,
  stringify = JSON.stringify,
  getMemory,
  logic = agentLogic as AgentLogic<TEvents>,
  adapter = vercelAdapter,
  ...generateTextOptions
}: {
  /**
   * The name of the agent
   */
  name: string;
  /**
   * A description of the role of the agent
   */
  description?: string;
  /**
   * Events that the agent can cause (send) in an environment
   * that the agent knows about.
   */
  events: TEventSchemas;
  planner?: AgentPlanner<Agent<TEvents>>;
  stringify?: typeof JSON.stringify;
  /**
   * A function that retrieves the agent's long term memory
   */
  getMemory?: (agent: Agent<any>) => AgentLongTermMemory;
  /**
   * Agent logic
   */
  logic?: AgentLogic<TEvents>;
  adapter?: AIAdapter;
} & GenerateTextOptions): Agent<TEvents> {
  const messageHistoryListeners: Observer<AgentMessageHistory>[] = [];

  const agent = createActor(logic) as unknown as Agent<TEvents>;
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

  agent.addHistory = (messageInput) => {
    const message = {
      ...messageInput,
      id: messageInput.id ?? randomUUID(),
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
    const observation = {
      ...observationInput,
      id: observationInput.id ?? randomUUID(),
      sessionId: agent.sessionId,
      timestamp: observationInput.timestamp ?? Date.now(),
    };

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

      console.log('input', input);

      if (input) {
        await agentDecide(agent, {
          machine: actorRef.src as AnyStateMachine,
          state: observation.nextState,
          execute: async (event) => {
            actorRef.send(event);
          },
          ...input,
        });
      }

      prevState = observationInput.nextState;
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
          state: prevState,
          nextState: inspEvent.snapshot as any,
        };

        await handleObservation(observationInput);
      },
    });

    // If actor already started, interact with current state
    if ((actorRef as any)._processingStatus === 1) {
      handleObservation({
        state: undefined,
        event: { type: '' }, // TODO: unknown events?
        nextState: actorRef.getSnapshot(),
      });
    }

    return {
      unsubscribe: () => {
        subscribed = false;
      }, // TODO: make this actually unsubscribe
    };
  };

  agent.start();

  return agent;
}
