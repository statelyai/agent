import { AnyStateMachine } from 'xstate';
import { ObservedState } from './agent';
import { ZodEventMapping } from './schemas';
import { AgentPlan } from './utils';

export interface Planner {
  plan: (stuff: {
    goal: string;
    state: ObservedState;
    events: ZodEventMapping;
    logic: AnyStateMachine;
  }) => Promise<AgentPlan | undefined>;
}

// A planner returns a plan for how to achieve a goal.
