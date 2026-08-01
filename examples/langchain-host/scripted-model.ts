/**
 * A real LangChain `BaseChatModel` that replays a scripted queue instead of
 * calling a provider. Reads no env vars and opens no sockets, so both
 * directions of this example run end to end — and are tested — with no API key.
 *
 * It is a genuine LangChain model, not a stub around the executors: the same
 * `createLangChainExecutors` code path runs against it, and LangChain's own
 * `createAgent` loop drives it in `./bridge.ts`.
 *
 * Compare `createScriptedExecutors` (a root export of `@statelyai/agent`),
 * which scripts the *executor* layer; this scripts the *model* layer, one
 * level below, so the LangChain mapping code stays under test.
 */
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import { ChatGenerationChunk as GenerationChunk } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";

/** One scripted turn. */
export type ScriptedResponse =
  | { text: string }
  /** Answers a `withStructuredOutput(...).invoke(...)` call with this value. */
  | { structured: unknown }
  /** Answers with an assistant tool call — decisions and agent-loop tool use. */
  | { toolCall: { name: string; args?: Record<string, unknown> }; text?: string };

/**
 * A script entry: a fixed response, or a function of the conversation so far.
 * The function form is what lets a scripted agent loop read a value out of the
 * previous tool result (e.g. the workflow handle) instead of guessing it.
 */
export type ScriptedEntry = ScriptedResponse | ((messages: BaseMessage[]) => ScriptedResponse);

export interface ScriptedChatModelFields extends BaseChatModelParams {
  responses: ScriptedEntry[];
}

export class ScriptedChatModel extends BaseChatModel {
  private queue: ScriptedEntry[];
  private callCount = 0;

  constructor(fields: ScriptedChatModelFields) {
    const { responses, ...rest } = fields;
    super(rest);
    // Copied, so one script array can seed many models.
    this.queue = [...responses];
  }

  _llmType() {
    return "scripted";
  }

  _combineLLMOutput() {
    return [];
  }

  /** Model calls made so far — lets tests assert the machine drove the model. */
  get calls() {
    return this.callCount;
  }

  private next(messages: BaseMessage[] = []): ScriptedResponse {
    const entry = this.queue.shift();
    if (!entry) {
      throw new Error("ScriptedChatModel: script exhausted — add another response.");
    }
    this.callCount += 1;
    return typeof entry === "function" ? entry(messages) : entry;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const response = this.next(messages);
    if ("toolCall" in response) {
      const message = new AIMessage({
        content: response.text ?? "",
        tool_calls: [
          {
            id: `call_${this.callCount}`,
            name: response.toolCall.name,
            args: response.toolCall.args ?? {},
            type: "tool_call",
          },
        ],
      });
      return { generations: [{ text: message.text, message }], llmOutput: {} };
    }
    if ("structured" in response) {
      throw new Error(
        "ScriptedChatModel: next scripted response is `structured`, which only answers " +
          "withStructuredOutput(); the caller asked for a plain generation.",
      );
    }
    const message = new AIMessage(response.text);
    return { generations: [{ text: response.text, message }], llmOutput: {} };
  }

  async *_streamResponseChunks(messages: BaseMessage[]): AsyncGenerator<ChatGenerationChunk> {
    const response = this.next(messages);
    if (!("text" in response) || typeof response.text !== "string") {
      throw new Error("ScriptedChatModel: next scripted response has no `text` to stream.");
    }
    // Word-at-a-time so `onChunk` consumers see more than one chunk.
    for (const [index, word] of response.text.split(" ").entries()) {
      const text = index === 0 ? word : ` ${word}`;
      yield new GenerationChunk({ text, message: new AIMessageChunk({ content: text }) });
    }
  }

  /** The script, not the tool list, decides what comes back. */
  override bindTools() {
    return this;
  }

  override withStructuredOutput<RunOutput extends Record<string, unknown>>() {
    return RunnableLambda.from(async () => {
      const response = this.next();
      if (!("structured" in response)) {
        throw new Error(
          "ScriptedChatModel: withStructuredOutput() called but the next scripted response " +
            "is not `structured`.",
        );
      }
      return response.structured as RunOutput;
    });
  }
}
