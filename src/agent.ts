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
    }
  >(async ({ input, self }) => {
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
