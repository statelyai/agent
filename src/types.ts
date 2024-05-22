import { AnyStateMachine } from 'xstate';
import { Agent, ObservedState } from './agent';
import { generateText, LanguageModel, streamText } from 'ai';
import { ZodEventMapping } from './schemas';

export type GenerateTextOptions = Parameters<typeof generateText>[0];

export type StreamTextOptions = Parameters<typeof streamText>[0];

export type AgentStrategyPlanOptions = {
  model: LanguageModel;
  state: ObservedState;
  goal: string;
  events: ZodEventMapping;
  logic?: AnyStateMachine;
  agent?: Agent<any>;
};
