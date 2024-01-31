import {ActorRef, ActorSystem, AnyActorRef, AnyEventObject, TransitionDefinition, Transitions} from "xstate";
import {OpenAIClient} from "@langchain/openai";
import {AgentExecutor, createOpenAIToolsAgent, CreateOpenAIToolsAgentParams} from "langchain/agents";
import {DynamicStructuredTool, StructuredToolInterface} from "@langchain/core/tools";
import {jsonSchemaToZod} from "json-schema-to-zod";
import {pull} from "langchain/hub";
import type {ChatPromptTemplate} from "@langchain/core/prompts";
import {BaseChatModel, BaseChatModelCallOptions} from "@langchain/core/dist/language_models/chat_models";
import {CreateAgentOutput} from "./langchain";

export async function getToolsAgent({transitions, functionNameMapping, execute, system, self, agentSettings, openai}:{transitions: Transitions<any, any>, functionNameMapping: Record<string, string>, execute?:boolean, system: ActorSystem<any>, self: AnyActorRef, agentSettings: CreateAgentOutput<any>, openai: BaseChatModel} ) {
    const tools: CreateOpenAIToolsAgentParams["tools"] = transitions
        .filter((t) => {
            return !t.eventType.startsWith('xstate.');
        })
        .map((t) => {
            const name = t.eventType.replace(/\./g, '_');
            functionNameMapping[name] = t.eventType;

            return new DynamicStructuredTool({
                metadata: {
                    eventType: t.eventType
                },
                name,
                func: async (input: any) => {
                    if (execute) {
                        // @ts-ignore
                        system._relay(self, self._parent, {
                            type: t.eventType,
                            ...input,
                        });
                    }
                    return JSON.stringify((self._parent || self)?.getPersistedSnapshot());
                },
                description: t.description ??
                    agentSettings.schemas.events[t.eventType]?.description,
                schema: JSON.parse(jsonSchemaToZod({
                    type: 'object',
                    properties: agentSettings.schemas.events[t.eventType]?.properties ?? {},
                })),
            });
        })

    const agent = await createOpenAIToolsAgent({
        llm: openai,
        tools: tools,
        prompt: await pull<ChatPromptTemplate>("hwchase17/openai-tools-agent"),
    });

    return new AgentExecutor({
        agent,
        tools,
        verbose: true
    });
}