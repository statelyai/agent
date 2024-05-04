import type OpenAI from 'openai';
import { fromPromise } from 'xstate';
import { ChatCompletionCreateParamsNonStreaming } from 'openai/resources';
import { StatelyAgentAdapter, Tool } from '../types';

/**
 * Creates [promise actor logic](https://stately.ai/docs/promise-actors) that passes the next possible transitions as functions to [OpenAI tool calls](https://platform.openai.com/docs/guides/function-calling) and returns an array of potential next events.
 *
 * @param openai The OpenAI instance to use.
 * @param inputFn A function that maps arbitrary input to OpenAI chat completion input.
 */
export function fromTool<TInput>(
  openai: OpenAI,
  agentSettings: StatelyAgentAdapter,
  tools: {
    [key: string]: Tool<any, any>;
  },
  inputFn: (
    input: TInput
  ) => string | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
) {
  return fromPromise<
    | {
        result: any;
        tool: string;
        toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
      }
    | undefined,
    TInput
  >(async ({ input }) => {
    const resolvedTools = Object.entries(tools).map(([key, value]) => {
      return {
        type: 'function',
        function: {
          name: key,
          description: value.description,
          parameters: value.inputSchema,
        },
      } as const;
    });

    const openAiInput = inputFn(input);
    const completionParams: ChatCompletionCreateParamsNonStreaming =
      typeof openAiInput === 'string'
        ? {
            model: agentSettings.model,
            messages: [
              {
                role: 'user',
                content: openAiInput,
              },
            ],
          }
        : openAiInput;
    const completion = await openai.chat.completions.create({
      ...completionParams,
      tools: resolvedTools,
    });

    const toolCalls = completion.choices[0]?.message.tool_calls;

    if (toolCalls?.length) {
      const toolCall = toolCalls[0]!;
      const tool = tools[toolCall.function.name];
      const args = JSON.parse(toolCall.function.arguments);

      if (tool) {
        const result = await tool.run(args);

        return {
          toolCall,
          tool: toolCall.function.name,
          result,
        };
      }
    }

    return undefined;
  });
}
