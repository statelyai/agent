import {
  Experimental_LanguageModelV1Middleware as LanguageModelV1Middleware,
  LanguageModelV1StreamPart,
  experimental_wrapLanguageModel as wrapLanguageModel,
} from 'ai';
import {
  AgentMessageInput,
  AnyAgent,
  LanguageModelV1TextPart,
  LanguageModelV1ToolCallPart,
} from './types';
import { randomId } from './utils';

export function createAgentMiddleware(agent: AnyAgent) {
  const middleware: LanguageModelV1Middleware = {
    transformParams: async ({ params, type }) => {
      return params;
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const id = randomId();

      params.prompt.forEach((p) => {
        agent.addMessage({
          id,
          ...p,
          timestamp: Date.now(),
          correlationId: params.providerMetadata
            ?.correlationId as unknown as string,
          parentCorrelationId: params.providerMetadata
            ?.parentCorrelationId as unknown as string,
        });
      });

      const result = await doGenerate();

      const content: (LanguageModelV1TextPart | LanguageModelV1ToolCallPart)[] =
        [];

      if (result.text) {
        content.push({
          type: 'text',
          text: result.text,
        });
      }

      const msgsToAppend: AgentMessageInput[] = [];

      if (result.toolCalls) {
        // Omit tool calls for now
        // result.toolCalls.forEach((toolCall, i) => {
        //   content.push({
        //     type: 'tool-call',
        //     ...toolCall,
        //   });
        // });
      }

      agent.addMessage({
        id: randomId(),
        timestamp: Date.now(),
        role: 'assistant',
        content: content,
        responseId: id,
        correlationId: params.providerMetadata
          ?.correlationId as unknown as string,
        parentCorrelationId: params.providerMetadata
          ?.parentCorrelationId as unknown as string,
      });

      msgsToAppend.forEach((m) => {
        agent.addMessage(m);
      });

      return result;
    },

    wrapStream: async ({ doStream, params }) => {
      const id = randomId();

      params.prompt.forEach((message) => {
        message.content;
        agent.addMessage({
          id,
          ...message,
          timestamp: Date.now(),
          correlationId: params.providerMetadata
            ?.correlationId as unknown as string,
          parentCorrelationId: params.providerMetadata
            ?.parentCorrelationId as unknown as string,
        });
      });

      const { stream, ...rest } = await doStream();

      let generatedText = '';

      const transformStream = new TransformStream<
        LanguageModelV1StreamPart,
        LanguageModelV1StreamPart
      >({
        transform(chunk, controller) {
          if (chunk.type === 'text-delta') {
            generatedText += chunk.textDelta;
          }

          controller.enqueue(chunk);
        },

        flush() {
          const content: (
            | LanguageModelV1TextPart
            | LanguageModelV1ToolCallPart
          )[] = [];

          if (generatedText) {
            content.push({
              type: 'text',
              text: generatedText,
            });
          }

          agent.addMessage({
            id: randomId(),
            timestamp: Date.now(),
            role: 'assistant',
            content,
            responseId: id,
            correlationId: params.providerMetadata
              ?.correlationId as unknown as string,
            parentCorrelationId: params.providerMetadata
              ?.parentCorrelationId as unknown as string,
          });
        },
      });

      return {
        stream: stream.pipeThrough(transformStream),
        ...rest,
      };
    },
  };
  return middleware;
}
