import { AnyStateMachine, IsNever } from 'xstate';
import { Agent, ObservedState } from './agent';
import { AgentPlan } from './utils';
import {
  CoreTool,
  generateObject,
  GenerateObjectResult,
  generateText,
  GenerateTextResult,
  LanguageModel,
  streamText,
  StreamTextResult,
} from 'ai';
import { ZodEventMapping } from './schemas';
import { z } from 'zod';

export type GenerateTextOptions = Parameters<typeof generateText>[0];

export type StreamTextOptions = Parameters<typeof streamText>[0];

export type GenerateObjectOptions<T> = Parameters<typeof generateObject>[0] & {
  schema: z.Schema<T>;
};

export type AgentTemplateGenerateTextOptions = GenerateTextOptions & {
  agent?: Agent<any>;
};

export type AgentTemplateStreamTextOptions = GenerateTextOptions & {
  agent?: Agent<any>;
};

export type AgentTemplateGenerateObjectOptions<T> = GenerateObjectOptions<T> & {
  agent?: Agent<any>;
};

export type AgentTemplatePlanOptions = {
  model: LanguageModel;
  state: ObservedState;
  goal: string;
  events: ZodEventMapping;
  logic?: AnyStateMachine;
  agent?: Agent<any>;
};

export type AgentTemplate = {
  plan?: ({
    model,
    state,
    goal,
    events,
    logic,
  }: AgentTemplatePlanOptions) => Promise<AgentPlan | undefined>;
  generateText?: (
    options: AgentTemplateGenerateTextOptions
  ) => Promise<GenerateTextResult<Record<string, CoreTool<any, any>>>>;
  generateObject?: <T>(
    options: AgentTemplateGenerateObjectOptions<T>
  ) => Promise<GenerateObjectResult<T>>;
  streamText?: (
    options: StreamTextOptions
  ) => Promise<StreamTextResult<Record<string, CoreTool<any, any>>>>;
};
