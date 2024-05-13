import { AnyStateMachine } from 'xstate';
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

export type AgentTemplate = {
  decide?: ({
    model,
    state,
    goal,
    toolMap,
    logic,
  }: {
    model: LanguageModel;
    state: ObservedState;
    goal: string;
    toolMap: Record<string, CoreTool>;
    logic?: AnyStateMachine;
  }) => Promise<AgentPlan | undefined>;
  generateText?: (
    stuff: GenerateTextOptions
  ) => Promise<GenerateTextResult<Record<string, CoreTool<any, any>>>>;
  streamText?: (
    stuff: StreamTextOptions
  ) => Promise<StreamTextResult<Record<string, CoreTool<any, any>>>>;
};

export type GenerateTextOptions = Parameters<typeof generateText>[0];

export type StreamTextOptions = Parameters<typeof streamText>[0];
