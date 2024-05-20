import { AnyStateMachine } from 'xstate';
import { Agent, ObservedState } from './agent';
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
import { z } from 'zod';

export type GenerateTextOptions = Parameters<typeof generateText>[0];

export type StreamTextOptions = Parameters<typeof streamText>[0];

export type AgentStrategyGenerateTextOptions = GenerateTextOptions & {
  agent?: Agent<any>;
};

export type AgentStrategyStreamTextOptions = GenerateTextOptions & {
  agent?: Agent<any>;
};

export type AgentStrategyPlanOptions = {
  model: LanguageModel;
  state: ObservedState;
  goal: string;
  events: ZodEventMapping;
  logic?: AnyStateMachine;
  agent?: Agent<any>;
};

export type AgentStrategy = {
  generatePlan?: (
    options: AgentStrategyPlanOptions
  ) => Promise<AgentPlan | undefined>;
  generateText?: (
    options: AgentStrategyGenerateTextOptions
  ) => Promise<GenerateTextResult<Record<string, CoreTool<any, any>>>>;
  streamText?: (
    options: StreamTextOptions
  ) => Promise<StreamTextResult<Record<string, CoreTool<any, any>>>>;
};
