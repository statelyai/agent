import {
  AnyEventObject,
  AnyMachineSnapshot,
  AnyStateMachine,
  fromObservable,
  fromPromise,
  InspectionEvent,
  ObservableActorLogic,
  Observer,
  PromiseActorLogic,
  toObserver,
  Values,
} from 'xstate';
import { getAllTransitions, getToolCalls, TransitionData } from './utils';
import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';
import { ZodEventTypes, EventSchemas } from './schemas';
import { createZodEventSchemas } from './utils';
import { TypeOf, z } from 'zod';
import {
  generateText,
  GenerateTextResult,
  LanguageModel,
  streamText,
  tool,
} from 'ai';
import { AgentHistory } from './history';

export type AgentLogic<TEventSchemas extends ZodEventTypes> = PromiseActorLogic<
  void,
  | ({
      goal: string;
      model?: ChatCompletionCreateParamsBase['model'];
      /**
       * Context to include
       */
      context?: any;
    } & Omit<Parameters<typeof generateText>[0], 'model' | 'tools' | 'prompt'>)
  | string
> & {
  eventTypes: Values<{
    [K in keyof TEventSchemas]: {
      type: K;
    } & TypeOf<TEventSchemas[K]>;
  }>;
  eventSchemas: EventSchemas<keyof TEventSchemas & string>;
  fromText: () => PromiseActorLogic<
    GenerateTextResult<never>,
    AgentTextStreamLogicInput
  >;
  fromTextStream: () => ObservableActorLogic<
    { textDelta: string },
    AgentTextStreamLogicInput
  >;
  observe: (inspectionEvent: InspectionEvent) => Observer<any>;
};

export type AgentTextStreamLogicInput = Omit<
  Parameters<typeof streamText>[0],
  'model'
> & {
  context?: any;
};

export function createAgent<const TEventSchemas extends ZodEventTypes>({
  model,
  events,
  stringify = JSON.stringify,
  history,
  ...generateTextOptions
}: {
  model: LanguageModel;
  events?: TEventSchemas;
  stringify?: typeof JSON.stringify;
  history?: AgentHistory;
} & Omit<
  Parameters<typeof generateText>[0],
  'model' | 'tools' | 'prompt'
>): AgentLogic<TEventSchemas> {
  const eventSchemas = events ? createZodEventSchemas(events) : undefined;

  const agentLogic: Omit<
    AgentLogic<TEventSchemas>,
    'eventTypes' | 'eventSchemas' | 'fromText' | 'fromTextStream' | 'observe'
  > = fromPromise(async ({ input, self }) => {
    const parentRef = self._parent;
    if (!parentRef) {
      return;
    }
    const resolvedInput = typeof input === 'string' ? { goal: input } : input;
    const state = parentRef.getSnapshot() as AnyMachineSnapshot;
    const contextToInclude =
      resolvedInput.context === true
        ? // include entire context
          parentRef.getSnapshot().context
        : resolvedInput.context
        ? stringify(resolvedInput.context, null, 2)
        : 'No context provided';

    const toolCalls = await getToolCalls(
      state,
      (eventType) => Object.keys(events ?? {}).includes(eventType),
      eventSchemas ?? (state.machine.schemas as any)?.events
    );

    const toolMap: Record<string, any> = {};

    for (const toolCall of toolCalls) {
      toolMap[toolCall.function.name] = tool({
        description: toolCall.function.description,
        parameters: events?.[toolCall.eventType] ?? z.object({}),
        execute: async (params) => {
          const event = {
            type: toolCall.eventType,
            ...params,
          };

          parentRef.send(event);
        },
      });
    }

    const prompt = [
      `<context>\n${stringify(contextToInclude, null, 2)}\n</context>`,
      resolvedInput.goal,
      'Only make a single tool call.',
    ].join('\n\n');

    console.log(
      '>>',
      await decide({
        model,
        goal: resolvedInput.goal,
        events: events ?? {}, // TODO: events should be required
        logic: parentRef.src as any,
        state,
      })
    );

    const event = await decide({
      model,
      goal: resolvedInput.goal,
      events: events ?? {}, // TODO: events should be required
      logic: parentRef.src as any,
      state,
    });

    if (event) {
      // TODO: validate event
      parentRef.send(event);
    }

    return;
  });

  (agentLogic as any).eventSchemas = eventSchemas;

  function fromText() {
    return fromPromise(
      async ({ input }: { input: AgentTextStreamLogicInput }) => {
        const prompt = [
          input.context &&
            `<context>\n${stringify(input.context, null, 2)}\n</context>`,
          input.prompt,
        ]
          .filter(Boolean)
          .join('\n\n');

        const result = await generateText({
          model,
          ...input,
          prompt,
        });

        return result;
      }
    );
  }

  function fromTextStream() {
    return fromObservable(({ input }: { input: AgentTextStreamLogicInput }) => {
      const observers = new Set<Observer<{ textDelta: string }>>();

      const prompt = [
        input.context &&
          `<context>\n${stringify(input.context, null, 2)}\n</context>`,
        input.prompt,
      ]
        .filter(Boolean)
        .join('\n\n');

      (async () => {
        const result = await streamText({
          model,
          ...input,
          prompt,
        });

        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            observers.forEach((observer) => {
              observer.next?.(part);
            });
          }
        }
      })();

      return {
        subscribe: (...args) => {
          const observer = toObserver(...(args as any));
          observers.add(observer);

          return {
            unsubscribe: () => {
              observers.delete(observer);
            },
          };
        },
      };
    });
  }

  (agentLogic as any).fromText = fromText;
  (agentLogic as any).fromTextStream = fromTextStream;
  (agentLogic as any).observe = (inspectionEvent: InspectionEvent) => {
    if (inspectionEvent.type === '@xstate.snapshot') {
      history?.add(inspectionEvent);
    }
  };

  return agentLogic as AgentLogic<TEventSchemas>;
}

export interface ObservedState {
  value: string;
  context: Record<string, unknown>;
}

export async function decide({
  model,
  goal,
  events,
  state,
  logic,
  getTransitions = (state, logic) => {
    if (!logic) {
      return [];
    }

    const resolvedState = logic.resolveState(state);
    return getAllTransitions(resolvedState);
  },
}: {
  model: LanguageModel;
  goal: string;
  state: ObservedState;
  events: ZodEventTypes;
  sessionId?: string;
  history?: Array<{
    snapshot: any;
    event: AnyEventObject;
    reward?: number;
  }>;
  logic?: AnyStateMachine;
  getTransitions?: (
    state: ObservedState,
    logic?: AnyStateMachine
  ) => TransitionData[];
}): Promise<AnyEventObject> {
  const transitions = getTransitions(state, logic);
  const eventSchemas = createZodEventSchemas(events ?? {});
  const filter = (eventType: string) =>
    Object.keys(events ?? {}).includes(eventType);

  const functionNameMapping: Record<string, string> = {};
  const tools = transitions
    .filter((t) => {
      return filter(t.eventType);
    })
    .map((t) => {
      const name = t.eventType.replace(/\./g, '_');
      functionNameMapping[name] = t.eventType;
      const eventSchema = eventSchemas?.[t.eventType];
      const {
        description,
        properties: { type, ...properties },
      } = eventSchema ?? ({} as any);

      return {
        type: 'function',
        eventType: t.eventType,
        function: {
          name,
          description: t.description ?? description,
          parameters: {
            type: 'object',
            properties: properties ?? {},
          },
        },
      } as const;
    });

  const toolMap: Record<string, any> = {};

  for (const toolCall of tools) {
    toolMap[toolCall.function.name] = tool({
      description: toolCall.function.description,
      parameters: events?.[toolCall.eventType] ?? z.object({}),
      execute: async (params) => {
        const event = {
          type: toolCall.eventType,
          ...params,
        };

        return event;
      },
    });
  }

  const prompt = [
    `<context>\n${JSON.stringify(state.context, null, 2)}\n</context>`,
    goal,
    'Only make a single tool call.',
  ].join('\n\n');

  const result = await generateText({
    model,
    tools: toolMap,
    prompt,
  });

  return result.toolResults[0]!.result;
}
