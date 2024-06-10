import { AnyMachineSnapshot, fromPromise } from 'xstate';
import {
  Agent,
  AgentDecideOptions,
  AgentDecisionLogic,
  AgentDecisionInput,
  AgentPlanner,
} from './types';
import { simplePlanner } from './planners/simplePlanner';

export async function agentDecide<T extends Agent<any>>(
  agent: T,
  options: AgentDecideOptions
) {
  const resolvedOptions = {
    ...agent.defaultOptions,
    ...options,
  };
  const {
    planner = simplePlanner as AgentPlanner<any>,
    goal,
    events = agent.events,
    state,
    machine,
    model = agent.model,
    ...otherPlanInput
  } = resolvedOptions;
  // const planner = opts.planner ?? simplePlanner;
  const plan = await planner(agent, {
    model,
    goal,
    events,
    state,
    machine,
    ...otherPlanInput,
  });

  if (plan?.nextEvent) {
    agent.addPlan(plan);
    await resolvedOptions.execute?.(plan.nextEvent);
  }

  return plan;
}

export function fromDecision(
  agent: Agent<any>,
  defaultInput?: AgentDecisionInput
) {
  return fromPromise(async ({ input, self }) => {
    const parentRef = self._parent;
    if (!parentRef) {
      return;
    }

    const snapshot = parentRef.getSnapshot() as AnyMachineSnapshot;
    const inputObject = typeof input === 'string' ? { goal: input } : input;
    const resolvedInput = {
      ...defaultInput,
      ...inputObject,
    };
    const contextToInclude =
      resolvedInput.context === true
        ? // include entire context
          parentRef.getSnapshot().context
        : resolvedInput.context;
    const state = {
      value: snapshot.value,
      context: contextToInclude,
    };

    const plan = await agentDecide(agent, {
      machine: parentRef.src as any,
      state,
      execute: async (event) => {
        parentRef.send(event);
      },
      ...resolvedInput,
    });

    return plan;
  }) as AgentDecisionLogic<any>;
}
