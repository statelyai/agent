import {
  AnyMachineSnapshot,
  fromPromise,
  PromiseActorLogic,
  Values,
} from 'xstate';
import OpenAI from 'openai';
import { getToolCalls } from './adapters/openai';
import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';
import { ZodEventTypes, EventSchemas } from './schemas';
import { createZodEventSchemas } from './utils';
import { TypeOf } from 'zod';

export function createAgent<const TEventSchemas extends ZodEventTypes>(
  openai: OpenAI,
  {
    model,
    events,
  }: {
    model: ChatCompletionCreateParamsBase['model'];
    events?: TEventSchemas;
  }
): PromiseActorLogic<
  void,
  {
    goal: string;
    model?: ChatCompletionCreateParamsBase['model'];
    /**
     * Context to include
     */
    context?: any;
  }
> & {
  eventTypes: Values<{
    [K in keyof TEventSchemas]: {
      type: K;
    } & TypeOf<TEventSchemas[K]>;
  }>;
  eventSchemas: EventSchemas<keyof TEventSchemas & string>;
} {
  const eventSchemas = events ? createZodEventSchemas(events) : undefined;

  const logic = fromPromise<
    void,
    {
      goal: string;
      model?: ChatCompletionCreateParamsBase['model'];
      context?: any;
    }
  >(async ({ input, self }) => {
    const parentRef = self._parent;
    if (!parentRef) {
      return;
    }
    const state = parentRef.getSnapshot() as AnyMachineSnapshot;
    const contextToInclude = input.context
      ? JSON.stringify(input.context, null, 2)
      : 'No context provided';

    const toolEvents = await getToolCalls(
      openai,
      [
        `<context>\n${JSON.stringify(contextToInclude, null, 2)}\n</context>`,
        input.goal,
        'Only make a single tool call.',
      ].join('\n\n'),
      state,
      input.model ?? model,
      (eventType) => eventType.startsWith('agent.'),
      eventSchemas ?? (state.machine.schemas as any)?.events
    );

    if (toolEvents.length > 0) {
      parentRef.send(toolEvents[0]);
    }

    return;
  });

  (logic as any).eventSchemas = eventSchemas;

  return logic as any;
}
