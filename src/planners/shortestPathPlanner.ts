import { Agent, AgentPlan, AgentPlanInput } from '../types';
import { getShortestPaths } from '@xstate/graph';

export async function simplePlanner<T extends Agent<any>>(
  agent: T,
  input: AgentPlanInput<any>
): Promise<AgentPlan<any> | undefined> {
  // 1. Determine goal state criteria
  // e.g. a state where the agent has won a game
  void 0;

  // 2. Determine possible events that can occur
  void 0;

  // 3. Get shortest paths from current state to
  // a state matching the criteria, using
  // possible events
  void 0;

  // 4. Return shortest path as a plan
  return null as any;
}
