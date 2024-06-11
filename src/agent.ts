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
  EventsFromZodEventMapping,
  GenerateTextOptions,
  AgentLongTermMemory,
  AIAdapter,
} from './types';
import { simplePlanner } from './planners/simplePlanner';
import { randomUUID } from 'crypto';
import { agentGenerateText, agentStreamText } from './text';
import { agentDecide } from './decision';
import { vercelAdapter } from './adapters/vercel';

export const agentLogic: AgentLogic<AnyEventObject> = fromTransition(
  (state, event, { sessionId }) => {
    switch (event.type) {
      case 'agent.feedback': {
        const feedback = {
          ...event.feedback,
          timestamp: event.feedback.timestamp ?? Date.now(),
          sessionId,
        };
        state.feedback.push(feedback);
        break;
      }
      case 'agent.observe': {
        state.observations.push({
          ...event.observation,
          id: event.observation.id ?? randomUUID(),
          sessionId,
          timestamp: event.observation.timestamp ?? Date.now(),
        });
        break;
      }
      case 'agent.history': {
        const message = {
          ...event.message,
          id: event.message.id ?? randomUUID(),
          timestamp: event.message.timestamp ?? Date.now(),
          sessionId,
        };
        state.history.push(message);
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

  agent.addHistory = (history) => {
    agent.send({
      type: 'agent.history',
      message: history,
    });
  };

  agent.generateText = (opts) => agentGenerateText(agent, opts);

  agent.streamText = (opts) => agentStreamText(agent, opts);

  agent.addFeedback = (feedback) => {
    agent.send({
      type: 'agent.feedback',
      feedback,
    });
  };

  agent.addObservation = (observation) => {
    agent.send({
      type: 'agent.observe',
      observation,
    });
  };

  agent.addPlan = (plan) => {
    agent.send({
      type: 'agent.plan',
      plan,
    });
  };

  agent.start();

  return agent;
}
