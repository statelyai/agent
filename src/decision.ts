import { AnyActor, AnyMachineSnapshot, fromPromise } from 'xstate';
import {
  AnyAgent,
  AgentDecideOptions,
  AgentDecisionLogic,
  AgentDecisionInput,
  AgentPlanner,
  AgentPlan,
  EventsFromZodEventMapping,
} from './types';
import { simplePlanner } from './planners/simplePlanner';

export async function agentDecide<T extends AnyAgent>(
  agent: T,
  options: AgentDecideOptions
): Promise<AgentPlan<EventsFromZodEventMapping<T['events']>> | undefined> {
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
  agent: AnyAgent,
  defaultInput?: AgentDecisionInput
): AgentDecisionLogic<any> {
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
      machine: (parentRef as AnyActor).logic,
      state,
      execute: async (event) => {
        parentRef.send(event);
      },
      ...resolvedInput,
    });

    return plan;
  }) as AgentDecisionLogic<any>;
}
