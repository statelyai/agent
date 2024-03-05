import {InputValues} from "@langchain/core/memory";
import {ChatPromptTemplate} from "@langchain/core/prompts";
import type {StatelyAgentAdapter} from '../types';
import {
    AnyEventObject,
    AnyTransitionDefinition,
    CallbackActorLogic,
    EventObject,
    fromCallback,
    fromObservable,
    isMachineSnapshot,
    ObservableActorLogic,
    type Observer,
    Subscribable,
    toObserver,
    TransitionDefinition,
    type Values
} from "xstate";
import {JSONSchema7, JSONSchema7Object} from "json-schema";
import {DynamicStructuredTool, StructuredToolInterface} from "@langchain/core/tools";
import z from "zod";
import {AgentExecutor, createOpenAIToolsAgent} from "langchain/agents";
import {pull} from "langchain/hub";
import {NonReducibleUnknown} from "xstate/dist/declarations/src/types";
import {InvokeCallback} from "xstate/dist/declarations/src/actors/callback";
import {FromSchema} from "json-schema-to-ts";
import {RunnableSequence} from "@langchain/core/runnables";
import {ConvertToJSONSchemas, EventSchemas, getAllTransitions} from "../utils";
import type {BaseChatModel} from "@langchain/core/language_models/chat_models";

export function fromEventChoiceStream<
    RunInput extends InputValues,
    TPrompt extends ChatPromptTemplate<RunInput>,
     TOutput extends AnyEventObject = AnyEventObject 
>({model}: LangChainAgentSettings ,
  promptTemplate: TPrompt
) {

    return fromObservable<TOutput, RunInput>(({input, system, self}) => {
        const observers = new Set<Observer<any>>();
        const parentSnapshot = self._parent?.getSnapshot();

        if (parentSnapshot || !isMachineSnapshot(parentSnapshot)) {

            const schemas = parentSnapshot.machine.schemas as any;
            const eventSchemaMap = schemas.events ?? {};
            const transitions = getAllTransitions(self._parent!.getSnapshot());


            const sendEvent = (event: any) => {
                observers.forEach((observer) => {
                    observer.next?.(event);
                });
                // @ts-ignore
                system._relay(self, self._parent, event);
            }

            (async () => {
                const tools = toTools(eventSchemaMap, transitions, sendEvent);

                let agent = await createOpenAIToolsAgent({
                    llm: model,
                    tools: tools,
                    prompt: ChatPromptTemplate.fromMessages([await pull<ChatPromptTemplate>("hwchase17/openai-tools-agent"), promptTemplate]),
                });

                const agentExecutor = new AgentExecutor({
                    agent: agent,
                    tools,
                    verbose: false,
                    returnIntermediateSteps: true,
                    handleParsingErrors: true,
                });

                const stream = await agentExecutor.stream({input: 'use the tools to accomplish the user request, you can use the multiple tools, dont stop until task accomplish', ...input});

                for await (const part of stream) {
                    observers.forEach((observer) => {
                        observer.next?.(part);
                    });
                }
            })();
        }

        return {
            subscribe: (...args: any) => {
                const observer = toObserver(...(args as any));
                observers.add(observer);

                return {
                    unsubscribe: () => {
                        observers.delete(observer);
                    },
                };
            },
        };

    })
}
 
export function fromCallbackChain<
    TEvents extends EventSchemas,
    TEvent extends AnyEventObject = AnyEventObject, //Partial<RunInput> & AnyEventObject= Partial<RunInput> & AnyEventObject// & TPrompt["partialVariables"],
    TSentEvent extends EventObject = FromSchema<Values<ConvertToJSONSchemas<TEvents>>> & AnyEventObject,
    TInput = NonReducibleUnknown,
    TPrompt extends ChatPromptTemplate<TEvent & TInput> = ChatPromptTemplate<TEvent & TInput>

>({model}: LangChainAgentSettings, prompt: TPrompt): CallbackActorLogic<TEvent, TInput> {

    return fromCallback(function ({input, system, self, sendBack, receive}) {
        const parentSnapshot = self._parent?.getSnapshot();

        if (parentSnapshot || !isMachineSnapshot(parentSnapshot)) {

            const schemas = parentSnapshot.machine.schemas as any;
            const eventSchemaMap = schemas.events ?? {};
            const transitions = getAllTransitions(self._parent!.getSnapshot());

            receive(e => {
                const tools = toTools(eventSchemaMap, transitions, sendBack)

                async function agent() {
                    const agent = await createOpenAIToolsAgent({
                        llm: model,
                        tools: tools,
                        prompt: ChatPromptTemplate.fromMessages([await pull<ChatPromptTemplate>("hwchase17/openai-tools-agent"), prompt]),
                    });

                    return new AgentExecutor({
                        agent: agent,
                        tools,
                        verbose: false,
                        returnIntermediateSteps: true,
                        handleParsingErrors: true,
                    });
                }

                (async () => {
                    const agentExecutor = await agent();
                    const stream = await agentExecutor.stream({input: 'use the tools to accomplish the user request, you can use the multiple tools, dont stop until task accomplish', ...input, ...e});

                    for await (const part of stream) {
                        self.send({
                            type: "@agent.next",
                            ...part
                        } as TEvent);
                    }
                })();
            })
        }

    } satisfies
        InvokeCallback<TEvent, TSentEvent, TInput>);
}

 

function fromObservableChain<TInput, TOutput>(runnable: RunnableSequence<TInput, TOutput>): ObservableActorLogic<TOutput, TInput> {
    return fromObservable(function ({input, system, self}): Subscribable<TOutput> {
        const observers = new Set<Observer<any>>();

        (async () => {
            const stream = await runnable.stream(input);

            for await (const part of stream) {
                observers.forEach((observer) => {
                    observer.next?.(part);
                });
            }
        })();

        return {
            subscribe: (...args: any) => {
                const observer = toObserver(...(args as any));
                observers.add(observer);

                return {
                    unsubscribe: () => {
                        observers.delete(observer);
                    },
                };
            },
        };
    }) satisfies ObservableActorLogic<TOutput, TInput>
}
function toTools<TSentEvent extends AnyEventObject = AnyEventObject>(
    events: EventSchemas,
    transitions: TransitionDefinition<any, TSentEvent>[],
    action: (event: TSentEvent) => void) {

    return transitions
        .filter(transitionFilter)
        .map(transitionDetails)
        .map(toAgentTool)

    function transitionFilter({eventType}: AnyTransitionDefinition) {
        return eventType in events;
    }

    function transitionDetails({eventType, description}: TransitionDefinition<any, TSentEvent>) {
        const schema = events[eventType] as JSONSchema7;
        return {
            name: eventType.replace(/\./g, '_'),
            description: description ?? schema?.description ?? `use this to send an event with the type ${eventType}`,
            eventType: eventType,
            schema: schema
        }
    }


    function toAgentTool({name, description, eventType, schema}: {
        name: string,
        description: string,
        eventType: TSentEvent["type"],
        schema: JSONSchema7
    }): StructuredToolInterface {

        //maybe worth defining a zod schema from the first place
        const zodSchema = mapSchemaToZod(schema);
        return new DynamicStructuredTool({
            func(input: z.infer<typeof zodSchema>): Promise<string> {
                return new Promise((resolve, reject) => {
                    action({type: eventType, ...input});
                    resolve("success");
                })
            },
            name: name,
            description: description,
            schema: zodSchema as any,

        })
    }

    function mapSchemaToZod(value: JSONSchema7): z.ZodSchema {
        const {type, items, properties} = value;

        if (type === "string") {
            return z.string();
        }
        if (type === "number") {
            return z.number();
        }
        if (type === "boolean") {
            return z.boolean();
        }
        if (type === "array") {
            return z.array(mapSchemaToZod(items as JSONSchema7));
        }
        if (type === "object") {
            return mapObjectSchemaToZod(value as JSONSchema7Object);
        }
        else {
            return z.unknown()
        }
        function mapObjectSchemaToZod(value: JSONSchema7Object) {
            const {properties} = value;
            if (!properties) {
                return z.object({});
            }

            return z.object(Object.entries(properties).reduce((acc, [key, value]) => {
                acc[key] = mapSchemaToZod(value).optional();
                return acc;
            }, {} as z.ZodRawShape))
        }
    }



}


 
export interface LangChainAgentSettings  {
    model: BaseChatModel;
}
export function createLangchainAdapter<
    T extends LangChainAgentSettings
>( settings: T) {
    settings.model
    return {
        fromEvent: fromEventChoiceStream.bind(null, settings),
        fromChat: fromCallbackChain.bind(null, settings),
        fromChatStream: fromObservableChain,
        fromCallback: fromCallbackChain.bind(null, settings)

    }
}
