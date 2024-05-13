import { AnyStateMachine } from 'xstate';
import { ObservedState } from './agent';
import { AgentPlan } from './utils';
import { CoreTool, generateText, LanguageModel } from 'ai';

export type AgentTemplate = (stuff: {
  model: LanguageModel;
  state: ObservedState;
  goal: string;
  // eventTools: {
  //   readonly type: 'function';
  //   readonly eventType: string;
  //   readonly function: {
  //     readonly name: string;
  //     readonly description: any;
  //     readonly parameters: {
  //       readonly type: 'object';
  //       readonly properties: any;
  //     };
  //   };
  // }[];
  toolMap: Record<string, CoreTool>;
  logic?: AnyStateMachine;
}) => Promise<AgentPlan | undefined>;

export type GenerateTextOptions = Omit<
  Parameters<typeof generateText>[0],
  'model' | 'tools' | 'prompt'
>;
