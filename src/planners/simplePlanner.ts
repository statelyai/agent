import { CoreTool, tool } from 'ai';
import {
  Agent,
  AgentPlan,
  AgentPlanInput,
  ObservedState,
  PromptTemplate,
  TransitionData,
} from '../types';
import { getAllTransitions } from '../utils';
import { AnyStateMachine } from 'xstate';
import { defaultTextTemplate } from '../templates/defaultText';

function getTransitions(
  state: ObservedState,
  machine: AnyStateMachine
): TransitionData[] {
  if (!machine) {
    return [];
  }

  const resolvedState = machine.resolveState(state);
  return getAllTransitions(resolvedState);
}

const simplePlannerPromptTemplate: PromptTemplate<any> = (data) => {
  return `
${defaultTextTemplate(data)}

Only make a single tool call to achieve the above goal.
  `.trim();
};

export async function simplePlanner<T extends Agent<any>>(
  agent: T,
  input: AgentPlanInput<any>
): Promise<AgentPlan<any> | undefined> {
  // Get all of the possible next transitions
  const transitions: TransitionData[] = input.machine
    ? getTransitions(input.state, input.machine)
    : Object.entries(input.events).map(([eventType, { description }]) => ({
        eventType,
        description,
      }));

  // Only keep the transitions that match the event types that are in the event mapping
  // TODO: allow for custom filters
  const filter = (eventType: string) =>
    Object.keys(input.events).includes(eventType);

  // Mapping of each event type (e.g. "mouse.click")
  // to a valid function name (e.g. "mouse_click")
  const functionNameMapping: Record<string, string> = {};

  const toolTransitions = transitions
    .filter((t) => {
      return filter(t.eventType);
    })
    .map((t) => {
      const name = t.eventType.replace(/\./g, '_');
      functionNameMapping[name] = t.eventType;

      return {
        type: 'function',
        eventType: t.eventType,
        description: t.description,
        name,
      } as const;
    });

  // Convert the transition data to a tool map that the
  // Vercel AI SDK can use
  const toolMap: Record<string, CoreTool<any, any>> = {};
  for (const toolTransitionData of toolTransitions) {
    const toolZodType = input.events?.[toolTransitionData.eventType];

    if (!toolZodType) {
      continue;
    }

    toolMap[toolTransitionData.name] = tool({
      description: toolZodType?.description ?? toolTransitionData.description,
      parameters: toolZodType,
      execute: async (params) => {
        const event = {
          type: toolTransitionData.eventType,
          ...params,
        };

        return event;
      },
    });
  }

  if (!Object.keys(toolMap).length) {
    // No valid transitions for the specified tools
    return undefined;
  }

  // Create a prompt with the given context and goal.
  // The template is used to ensure that a single tool call is made.
  const prompt = simplePlannerPromptTemplate({
    context: input.state.context,
    goal: input.goal,
  });

  const result = await agent.generateText({
    ...input,
    prompt,
    tools: toolMap,
    toolChoice: 'required',
  });

  const singleResult = result.toolResults[0];

  if (!singleResult) {
    console.log(toolMap);
    // TODO: retries?
    console.warn('No tool call results returned');
    return undefined;
  }

  return {
    goal: input.goal,
    state: input.state,
    steps: [
      {
        event: singleResult.result,
      },
    ],
    nextEvent: singleResult.result,
    sessionId: agent.sessionId,
    timestamp: Date.now(),
  };
}
