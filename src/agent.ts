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
import { AgentHistoryItem, getAllTransitions, PromptTemplate } from './utils';
import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';
import { ZodEventTypes, EventSchemas } from './schemas';
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
    model: LanguageModel;
    goal: string;
    state: ObservedState;
    events: ZodEventTypes;
    logic: AnyStateMachine;
  }) => void;
};

export type AgentTextStreamLogicInput = Omit<
  Parameters<typeof streamText>[0],
  'model'
> & {
  context?: any;
};

export const defaultPromptTemplate: PromptTemplate = (data) => {
  return `
<context>
${JSON.stringify(data.context, null, 2)}
</context>

${data.goal}

Only make a single tool call to achieve the goal.
  `.trim();
};

type GenerateTextOptions = Omit<
  Parameters<typeof generateText>[0],
  'model' | 'tools' | 'prompt'
>;

export interface AgentState {
  state: ObservedState;
  history: Array<AgentHistoryItem>;
}

const getTransitions = (state: ObservedState, logic: AnyStateMachine) => {
  if (!logic) {
    return [];
  }

  const resolvedState = logic.resolveState(state);
  return getAllTransitions(resolvedState);
};
export function createAgent<const TEventSchemas extends ZodEventTypes>({
  model,
  events,
  stringify = JSON.stringify,
  promptTemplate = defaultPromptTemplate,
  ...generateTextOptions
}: {
  model: LanguageModel;
  events?: TEventSchemas;
  stringify?: typeof JSON.stringify;
  promptTemplate?: PromptTemplate;
} & GenerateTextOptions): AgentLogic<TEventSchemas> {
  const eventSchemas = events ? createZodEventSchemas(events) : undefined;
  let agentState: AgentState | undefined;

  const observe: AgentLogic<any>['observe'] = ({
    state,
    event,
    timestamp,
    eventOrigin: eventOrigin,
  }) => {
    agentState = agentState ?? {
      state,
      history: [],
    };

    agentState.history.push({
      state: agentState.state,
      event: event,
      timestamp: timestamp,
      eventOrigin: eventOrigin,
    });
  };

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

      const event = await decideFromMachine({
        model,
        goal: resolvedInput.goal,
        events: events ?? {}, // TODO: events should be required
        state,
        logic: parentRef.src as any,
        promptTemplate,
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

  return agentLogic as AgentLogic<TEventSchemas>;
}

export interface ObservedState {
  value: string;
  context: Record<string, unknown>;
}

export async function decideFromMachine({
  model,
  goal,
  events,
  state,
  logic,
  promptTemplate,
  ...generateTextOptions
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
  logic: AnyStateMachine;
  // transitions: TransitionData[];
  promptTemplate: PromptTemplate;
} & GenerateTextOptions): Promise<AnyEventObject | undefined> {
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
  const prompt = promptTemplate({
    goal,
    context: state.context,
    logic,
    transitions,
    plan: undefined,
  });

  const result = await generateText({
    model,
    tools: toolMap,
    prompt,
    ...generateTextOptions,
  });

  return result.toolResults[0]?.result;
}
