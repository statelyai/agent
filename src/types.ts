import type OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources';
import {
  AnyEventObject,
  ObservableActorLogic,
  PromiseActorLogic,
} from 'xstate';
import { FromToolResult } from './adapters/openai';

export interface StatelyAgentAdapter {
  model: string;
  /**
   * Creates actor logic that chooses an event from all of the
   * possible next events of the parent state machine
   * and sends it to the parent actor.
   */
  fromEvent: <TInput>(
    inputFn: (input: TInput) => string | ChatCompletionCreateParamsNonStreaming
  ) => PromiseActorLogic<AnyEventObject[] | undefined, TInput>;
  /**
   * Creates actor logic that resolves with a chat completion.
   */
  fromChat: <TInput>(
    inputFn: (input: TInput) => string | ChatCompletionCreateParamsNonStreaming
  ) => PromiseActorLogic<OpenAI.Chat.Completions.ChatCompletion, TInput>;
  /**
   * Creates actor logic that emits a chat completion stream.
   */
  fromChatStream: <TInput>(
    inputFn: (input: TInput) => string | ChatCompletionCreateParamsStreaming
  ) => ObservableActorLogic<
    OpenAI.Chat.Completions.ChatCompletionChunk,
    TInput
  >;
  /**
   * Creates actor logic that chooses a tool from the provided
   * tools and runs that tool.
   */
  fromTool: <TInput>(
    inputFn: (input: TInput) => string | ChatCompletionCreateParamsNonStreaming,
    tools: {
      [key: string]: Tool<any, any>;
    }
  ) => PromiseActorLogic<FromToolResult | undefined, TInput>;
}

export interface Tool<TInput, TOutput> {
  description: string;
  inputSchema: any;
  run: (input: TInput) => TOutput;
}
