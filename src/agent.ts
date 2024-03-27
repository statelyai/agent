import { inspect } from 'util';
import {
  ActorOptions,
  AnyActorLogic,
  AnyActorRef,
  AnyEventObject,
  AnyStateMachine,
  EventObject,
  InputFrom,
  createActor,
} from 'xstate';

export type AgentExperiences<T, R> = Record<
  string,
  Record<
    string,
    {
      state: T;
      reward: R;
    }
  >
>;

export type AgentPlan<T> = Array<{
  /**
   * The current state
   */
  state: T;
  /**
   * The event to execute
   */
  event: AnyEventObject;
}>;

export interface AgentModel<T, R> {
  experiences: AgentExperiences<T, any>;
  getMachine: () => AnyStateMachine;
  policy: (state: T, goal: T) => Promise<AgentPlan<T>>;
  getNextEvents: (state: T) => Promise<AnyEventObject[]>;
  getPlans: (state: T, goal: T) => Promise<Array<AgentPlan<T>>>;
  getReward: (state: T, goal: T, action: EventObject) => Promise<R>;
}

export interface AgentLogic<T> {
  /**
   * The next possible actions (represented by events) that the agent can take
   * based on the current state of the environment
   */
  getActions(state: T): Promise<AnyEventObject[]>;
  getPlan(state: T, goal: any): Promise<Array<[T, EventObject]>>;
}

export interface Agent<T extends AnyActorRef> {
  experiences: Array<{
    currentState: T;
    event: AnyEventObject;
    nextState: T;
    // plan (event array)
    // reason (string)
  }>;
  act(environment: T): Promise<any>;
}

export function createAgent<TLogic extends AnyActorLogic>(
  goal: string,
  logic: TLogic,
  input: InputFrom<TLogic>
) {
  const experiences: Agent<any>['experiences'] = [];

  const actor = createActor(logic, {
    input,
    inspect: (inspEv) => {
      if (inspEv.type === '@xstate.snapshot') {
        experiences.push({
          nextState: inspEv.state.value,
          event: inspEv.event,
        });
      }
    },
  });

  return {
    experiences,
    ...actor,
  };
}
