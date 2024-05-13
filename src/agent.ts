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
import { getAllTransitions, PromptTemplate } from './utils';
import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';
import { ZodEventMapping, EventSchemas } from './schemas';
import { createZodEventSchemas } from './utils';
import { TypeOf, z } from 'zod';
import {
  CoreTool,
  generateText,
  GenerateTextResult,
  LanguageModel,
  streamText,
  tool,
} from 'ai';
import { AgentTemplate, GenerateTextOptions } from './types';
import { createDefaultTemplate } from './templates/simple';

export type AgentLogic<TEventSchemas extends ZodEventMapping> =
  PromiseActorLogic<
    void,
    | ({
        goal: string;
        model?: ChatCompletionCreateParamsBase['model'];
        /**
         * Context to include
         */
        context?: any;
      } & Omit<
        Parameters<typeof generateText>[0],
        'model' | 'tools' | 'prompt'
      >)
    | string
  > & {
    eventTypes: Values<{
      [K in keyof TEventSchemas]: {
        type: K;
      } & TypeOf<TEventSchemas[K]>;
    }>;
    eventSchemas: EventSchemas<keyof TEventSchemas & string>;
    fromText: () => PromiseActorLogic<
      GenerateTextResult<Record<string, CoreTool<any, any>>>,
      AgentTextStreamLogicInput
    >;
    fromTextStream: () => ObservableActorLogic<
      { textDelta: string },
      AgentTextStreamLogicInput
    >;
    inspect: (inspectionEvent: InspectionEvent) => void;
    observe: ({
      state,
      event,
    }: {
      state: ObservedState;
      event: AnyEventObject;
      timestamp: number;
      eventOrigin: 'environment' | 'agent';
    }) => void;
    reward: ({
      goal,
      reward,
      timestamp,
    }: {
      goal: string;
      reward: number;
      timestamp: number;
    }) => void;
    decide: ({}: {
      goal: string;
      state: ObservedState;
      events: ZodEventMapping;
      logic: AnyStateMachine;
      promptTemplate?: PromptTemplate;
    }) => Promise<AnyEventObject | undefined>;
  };

export type AgentTextStreamLogicInput = Omit<
  Parameters<typeof streamText>[0],
  'model'
> & {
  context?: any;
};

export interface AgentState {
  state: ObservedState;
}

const getTransitions = (state: ObservedState, logic: AnyStateMachine) => {
  if (!logic) {
    return [];
  }

  const resolvedState = logic.resolveState(state);
  return getAllTransitions(resolvedState);
};
export function createAgent<const TEventSchemas extends ZodEventMapping>({
  model,
  events,
  stringify = JSON.stringify,
  template,
  ...generateTextOptions
}: {
  model: LanguageModel;
  events?: TEventSchemas;
  stringify?: typeof JSON.stringify;
  template?: AgentTemplate;
} & GenerateTextOptions): AgentLogic<TEventSchemas> {
  const resolvedTemplate =
    template ?? createDefaultTemplate(generateTextOptions);
  const eventSchemas = events ? createZodEventSchemas(events) : undefined;

  const observe: AgentLogic<any>['observe'] = ({
    state,
    event,
    timestamp,
    eventOrigin: eventOrigin,
  }) => {};

  const agentLogic: AgentLogic<TEventSchemas> = fromPromise(
    async ({ input, self }) => {
      const parentRef = self._parent;
      if (!parentRef) {
        return;
      }
      const resolvedInput = typeof input === 'string' ? { goal: input } : input;
      const snapshot = parentRef.getSnapshot() as AnyMachineSnapshot;
      const contextToInclude =
        resolvedInput.context === true
          ? // include entire context
            parentRef.getSnapshot().context
          : resolvedInput.context;
      const state = {
        value: snapshot.value,
        context: contextToInclude,
      };

      const event = await decide({
        model,
        goal: resolvedInput.goal,
        events: events ?? {}, // TODO: events should be required
        state,
        logic: parentRef.src as any,
        template: resolvedTemplate,
        ...generateTextOptions,
      });

      if (event) {
        // TODO: validate event
        parentRef.send(event);
      }

      return;
    }
  ) as AgentLogic<TEventSchemas>;

  agentLogic.eventSchemas = eventSchemas ?? ({} as any);

  function fromText(): PromiseActorLogic<
    GenerateTextResult<Record<string, CoreTool<any, any>>>,
    AgentTextStreamLogicInput
  > {
    return fromPromise(async ({ input }) => {
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
    });
  }

  function fromTextStream(): ObservableActorLogic<
    { textDelta: string },
    AgentTextStreamLogicInput
  > {
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
        subscribe: (...args: any[]) => {
          const observer = toObserver(...args);
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

  agentLogic.fromText = fromText;
  agentLogic.fromTextStream = fromTextStream;
  agentLogic.inspect = (inspectionEvent) => {};
  agentLogic.observe = observe;
  agentLogic.decide = (stuff) =>
    decide({
      template: resolvedTemplate,
      model,
      ...stuff,
    });

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
  template = createDefaultTemplate(),
}: {
  model: LanguageModel;
  goal: string;
  state: ObservedState;
  events: ZodEventMapping;
  sessionId?: string;
  history?: Array<{
    snapshot: any;
    event: AnyEventObject;
    reward?: number;
  }>;
  logic: AnyStateMachine;
  template: AgentTemplate | undefined;
}): Promise<AnyEventObject | undefined> {
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
  const plan = await template({
    model,
    state,
    goal,
    logic,
    toolMap,
  });

  if (!plan?.nextEvent) {
    return undefined;
  }

  return plan.nextEvent;
}
