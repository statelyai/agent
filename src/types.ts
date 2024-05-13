import { AnyStateMachine, IsNever } from 'xstate';
import { ObservedState } from './agent';
import { AgentPlan } from './utils';
import {
  CoreTool,
  generateText,
  GenerateTextResult,
  LanguageModel,
  streamText,
  StreamTextResult,
} from 'ai';
import { ZodEventMapping } from './schemas';

export type AgentTemplateGenerateTextOptions = GenerateTextOptions;

export type AgentTemplateStreamTextOptions = GenerateTextOptions;

export type AgentTemplatePlanOptions = {
  model: LanguageModel;
  state: ObservedState;
  goal: string;
  events: ZodEventMapping;
  logic?: AnyStateMachine;
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
  streamText?: (
    options: StreamTextOptions
  ) => Promise<StreamTextResult<Record<string, CoreTool<any, any>>>>;
};

export type GenerateTextOptions = Parameters<typeof generateText>[0];

export type StreamTextOptions = Parameters<typeof streamText>[0];
