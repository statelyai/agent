import { AnyMachineSnapshot, fromPromise, PromiseActorLogic } from 'xstate';
import OpenAI from 'openai';
import { getToolCalls } from './adapters/openai';
import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';

export function createAgent(
  openai: OpenAI,
  {
    model,
  }: {
    model: ChatCompletionCreateParamsBase['model'];
  }
): PromiseActorLogic<
  void,
  {
    goal: string;
    model?: ChatCompletionCreateParamsBase['model'];
  }
> {
  return fromPromise(async ({ input, self }) => {
    const parentRef = self._parent;
    if (!parentRef) {
      return;
    }
    const state = parentRef.getSnapshot() as AnyMachineSnapshot;

    const toolEvents = await getToolCalls(
      openai,
      input.goal + '\nOnly make a single tool call.',
      state,
      input.model ?? model,
      (eventType) => eventType.startsWith('agent.'),
      (state.machine.schemas as any)?.events
    );

    if (toolEvents.length > 0) {
      parentRef.send(toolEvents[0]);
    }

    return;
  });
}
