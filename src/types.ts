import OpenAI from 'openai';
import {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources';
import {
  AnyActorLogic,
  AnyActorRef,
  AnyEventObject,
  ObservableActorLogic,
  PromiseActorLogic,
} from 'xstate';

export interface StatelyAgentAdapter {
  model: string;
  fromEventChoice: <TInput>(
    inputFn: (input: TInput) => string | ChatCompletionCreateParamsNonStreaming,
    options?: {
      /**
       * Immediately execute sending the event to the parent actor.
       * @default true
       */
      execute?: boolean;
    }
  ) => PromiseActorLogic<AnyEventObject[] | undefined, TInput>;
  /**
   * Creates promise actor logic that resolves with a chat completion.
   */
  fromChat: <TInput>(
    inputFn: (input: TInput) => string | ChatCompletionCreateParamsNonStreaming
  ) => PromiseActorLogic<OpenAI.Chat.Completions.ChatCompletion, TInput>;
  /**
   * Creates observable actor logic that emits a chat completion stream.
   */
  fromChatStream: <TInput>(
    inputFn: (input: TInput) => string | ChatCompletionCreateParamsStreaming
  ) => ObservableActorLogic<
    OpenAI.Chat.Completions.ChatCompletionChunk,
    TInput
  >;

  fromToolChoice: <TInput>(
    inputFn: (input: TInput) => string | ChatCompletionCreateParamsNonStreaming,
    tools: {
      [key: string]: Tool<any, any>;
    },
    options?: {
      /**
       * Immediately execute sending the event to the parent actor.
       * @default true
       */
      execute?: boolean;
    }
  ) => PromiseActorLogic<
    | {
        result: any;
        tool: string;
        toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
      }
    | undefined,
    TInput
  >;
}

export interface Tool<TInput, TOutput> {
  description: string;
  inputSchema: any;
  run: (input: TInput) => TOutput;
}
