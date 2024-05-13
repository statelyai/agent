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
import { AgentPlan } from './utils';
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
import { AgentTemplate, GenerateTextOptions, StreamTextOptions } from './types';
import { simple } from './templates/simple';

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
      template?: AgentTemplate;
    }) => Promise<AgentPlan | undefined>;
  };

export type AgentTextStreamLogicInput = Omit<StreamTextOptions, 'model'> & {
  context?: any;
};

export interface AgentState {
  state: ObservedState;
}

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
    template ?? simple({ model, ...generateTextOptions });
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
  agentLogic.decide = async (stuff) => {
    const template = stuff.template ?? resolvedTemplate;

    return await template.decide?.({
      template: resolvedTemplate,
      model,
      ...stuff,
    });
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
  template = simple(),
}: {
  model: LanguageModel;
  goal: string;
  state: ObservedState;
  events: ZodEventMapping;
  sessionId?: string;
  logic: AnyStateMachine;
  template: AgentTemplate | undefined;
}): Promise<AnyEventObject | undefined> {
  if (!template.decide) {
    throw new Error('No decide template found');
  }

  const plan = await template.decide({
    model,
    state,
    goal,
    logic,
    events,
  });

  if (!plan?.nextEvent) {
    return undefined;
  }

  return plan.nextEvent;
}
