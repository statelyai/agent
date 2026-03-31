import { generateText, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { StateValue } from 'xstate';
import { emailMachine } from './machine';
import { agentEvents } from './events';
import { getAllTransitions } from './utils';
import { z } from 'zod';

type ObservedState = {
  value: StateValue;
  context: Record<string, unknown>;
};

// States where agent makes decisions
export function requiresAgentDecision(stateValue: StateValue): boolean {
  return stateValue === 'checking';
}

// Build AI SDK tools from Zod events, filtered by available transitions
function buildTools(
  resolvedState: ReturnType<typeof emailMachine.resolveState>
) {
  const transitions = getAllTransitions(resolvedState);
  const availableEventTypes = new Set(transitions.map((t) => t.eventType));

  const tools: Record<string, ReturnType<typeof tool>> = {};

  for (const [eventType, schema] of Object.entries(agentEvents)) {
    if (!availableEventTypes.has(eventType)) continue;

    tools[eventType] = tool({
      description: schema.description!,
      inputSchema: schema,
      execute: async (params) => ({ type: eventType, ...params }),
    });
  }

  return tools;
}

export async function getAgentDecision(
  observedState: ObservedState,
  goal: string,
  apiKey: string
): Promise<{ type: string; [key: string]: unknown } | null> {
  // Rehydrate state from serialized form
  const resolvedState = emailMachine.resolveState(observedState);
  const tools = buildTools(resolvedState);

  console.log('tools', tools);

  if (Object.keys(tools).length === 0) {
    return null;
  }

  const context = observedState.context as {
    userRequest: string;
    clarifications: string[];
    questions: string[];
  };

  const systemPrompt = `You are an email assistant helping draft emails.

User's request: ${context.userRequest}

${
  context.clarifications.length > 0
    ? `Previous clarifications provided:\n${context.clarifications.join('\n')}`
    : ''
}

${goal}

If you need more information to write a proper email (recipient, tone, specific details), ask for clarification.
If you have enough information, submit the email with recipient, subject, and body.`;

  const openai = createOpenAI({ apiKey });
  const result = await generateText({
    model: openai.chat('gpt-5-mini'),
    system: systemPrompt,
    messages: [{ role: 'user', content: goal }],
    tools,
    toolChoice: 'required',
  });

  const toolResult = result.toolResults[0];
  return (
    (toolResult?.result as { type: string; [key: string]: unknown }) ?? null
  );
}
