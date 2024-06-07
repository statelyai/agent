import {
  AnyEventObject,
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
  AgentMemory,
  EventsFromZodEventMapping,
  GenerateTextOptions,
} from './types';
import { simplePlanner } from './planners/simplePlanner';
import { randomUUID } from 'crypto';
import { createMemoryStorage } from './storage';
import { agentGenerateText } from './text';
import { agentDecide } from './decision';

export const agentLogic: AgentLogic<AnyEventObject> = fromTransition(
  (state, event) => {
    switch (event.type) {
      case 'agent.feedback': {
        state.feedback.push(event.feedback);
        break;
      }
      case 'agent.observe': {
        state.observations.push({
          id: randomUUID(),
          ...event.observation,
        });
        break;
      }
      case 'agent.history': {
        state.history.push(event.message);
        break;
      }
      case 'agent.plan': {
        state.plans.push(event.plan);
        break;
      }
      default:
        break;
    }
    return state;
  },
  {
    feedback: [],
    history: [],
    observations: [],
    plans: [],
  } as AgentContext
);

export function createAgent<
  const TEventSchemas extends ZodEventMapping,
  TEvents extends EventObject = EventsFromZodEventMapping<TEventSchemas>
>({
  name,
  model,
  events,
  planner = simplePlanner as AgentPlanner<Agent<TEvents>>,
  stringify = JSON.stringify,
  memory = createMemoryStorage(),
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
   * Agent long-term memory
   */
  memory?: AgentMemory;
} & GenerateTextOptions): Agent<TEvents> {
  const messageHistoryListeners: Observer<AgentMessageHistory>[] = [];

  const agent = createActor(agentLogic) as unknown as Agent<TEvents>;
  agent.events = events;
  agent.model = model;
  agent.name = name;
  agent.defaultOptions = { ...generateTextOptions, model };
  agent.select = (selector) => {
    return selector(agent.getSnapshot().context);
  };

  agent.onMessage = (callback) => {
    messageHistoryListeners.push(toObserver(callback));
  };

  agent.decide = (opts) => {
    return agentDecide(agent, opts);
  };

  agent.addHistory = (history) => {
    agent.send({
      type: 'agent.history',
      message: history,
    });
  };

  agent.getHistory = async () => {
    return await memory.getAll(agent.sessionId, 'history');
  };

  agent.generateText = (opts) => agentGenerateText(agent, opts);

  agent.addObservation = (observation) => {
    agent.send({
      type: 'agent.observe',
      observation,
    });
  };

  agent.getObservations = async () => {
    return await memory.getAll(agent.sessionId, 'observations');
  };

  agent.addPlan = (plan) => {
    agent.send({
      type: 'agent.plan',
      plan,
    });
  };

  agent.getPlans = async () => {
    return await memory.getAll(agent.sessionId, 'plans');
  };

  agent.start();

  return agent;
}
