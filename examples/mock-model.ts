/**
 * Test-only model double for the examples, built on the Vercel AI SDK's own
 * `MockLanguageModelV3` (from `ai/test`) behind the real `createAiSdkExecutors`
 * adapter. It is repo-internal: not exported from the package, not part of any
 * public API. Tests that want a mock model write one; this is ours.
 *
 * Answers are keyed by REQUEST NAME (the `setupAgent({ requests })` key, or a
 * decision's `name`), never by prompt text or call order, so a run that takes
 * a different branch cannot land an answer on the wrong call. The adapter's
 * documented `settings` hook runs once per call and tags it with an id through
 * `providerOptions`; the mock model reads the id back to find the request.
 *
 * Entries for a name are consumed in order; the last one repeats. `"*"` is the
 * fallback name. A text entry is the request's output value (a string, or the
 * object a structured request declares); a decision entry is the chosen event.
 * For a closed choice (`request.options`) the mock answers `choose_option`
 * with the id of the option equal to that event, or with an id that is not
 * offered when none is, which the run retries.
 * Either may be a function of the agent request (and the AI SDK call options)
 * for answers that depend on the prompt or on a decision's prior attempts.
 */
import { isDeepStrictEqual } from "node:util";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { AgentDecisionRequest, AgentTextRequest } from "@statelyai/agent";
import { createAiSdkExecutors, type AiSdkExecutors } from "@statelyai/agent/ai-sdk";

// The SDK's call and stream types, read off the mock's own constructor so this
// file needs no direct dependency on `@ai-sdk/provider`.
type MockOptions = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>;
type DoGenerate = Extract<MockOptions["doGenerate"], (...args: never[]) => unknown>;
type DoStream = Extract<MockOptions["doStream"], (...args: never[]) => unknown>;
type CallOptions = Parameters<DoGenerate>[0];
type StreamPart =
  Awaited<ReturnType<DoStream>>["stream"] extends ReadableStream<infer TPart> ? TPart : never;

type MockRequest = AgentTextRequest | AgentDecisionRequest;
type Entry<T, TRequest> = T | ((request: TRequest, options: CallOptions) => T | Promise<T>);

/**
 * A text answer: the request's output value, or a function of the request.
 * The value side is spelled out rather than `unknown` so a function entry's
 * `request` parameter stays contextually typed.
 */
export type MockTextEntry = Entry<string | number | boolean | null | object, AgentTextRequest>;
/** A chosen event for a decision, or a function of the decision request. */
export type MockDecisionEntry = Entry<
  { type: string; [key: string]: unknown },
  AgentDecisionRequest
>;

export type MockModelScript = {
  /** Answers for text requests, keyed by request name. */
  text?: Record<string, MockTextEntry | MockTextEntry[]>;
  /** Chosen events for `agent.decide` requests, keyed by decision name. */
  decisions?: Record<string, MockDecisionEntry | MockDecisionEntry[]>;
};

/** One call the mock model answered. */
export type MockModelCall = {
  kind: "generateText" | "streamText" | "decide";
  name: string;
  request: MockRequest;
  input: unknown;
};

export type MockModelExecutors = AiSdkExecutors & {
  /** Every call the model saw, in order. */
  calls: MockModelCall[];
};

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** The adapter's one closed-choice tool. */
const OPTION_TOOL = "choose_option";

/** The option ids a `choose_option` tool offers: its `option` enum. */
function optionIdsOf(tool: NonNullable<CallOptions["tools"]>[number] | undefined): string[] {
  const schema = tool && "inputSchema" in tool ? tool.inputSchema : undefined;
  const option = schema?.properties?.["option"];
  return typeof option === "object" && Array.isArray(option.enum) ? (option.enum as string[]) : [];
}

/** Mirrors the adapter's event → tool-name mapping for the common case. */
function eventToolName(type: string): string {
  return `send_event_${type.replace(/[^a-zA-Z0-9_-]/g, "_") || "event"}`;
}

/**
 * Builds `{ generateText, streamText, decide }` over one mock model. Every
 * request name the run reaches must have an entry, or the mock throws naming
 * the missing request.
 */
export function createMockModelExecutors(script: MockModelScript): MockModelExecutors {
  const cursors = new Map<string, number>();
  const calls: MockModelCall[] = [];

  function take<TEntry>(
    table: Record<string, TEntry | TEntry[]> | undefined,
    name: string,
  ): TEntry {
    const entries = table?.[name] ?? table?.["*"];
    if (entries === undefined) {
      throw new Error(`mock model: no scripted answer for request "${name}"`);
    }
    const list = Array.isArray(entries) ? entries : [entries];
    const index = cursors.get(name) ?? 0;
    cursors.set(name, index + 1);
    return list[Math.min(index, list.length - 1)] as TEntry;
  }

  async function resolve<T, TRequest>(
    entry: Entry<T, TRequest>,
    request: TRequest,
    options: CallOptions,
  ): Promise<T> {
    return typeof entry === "function"
      ? await (entry as (request: TRequest, options: CallOptions) => T | Promise<T>)(
          request,
          options,
        )
      : entry;
  }

  // The adapter's `settings` hook runs once per call, right before the SDK is
  // invoked: it parks the agent request under a fresh id and tags the call
  // with that id, and the model looks the request up again.
  let sequence = 0;
  const pending = new Map<number, MockRequest>();

  function requestFor(options: CallOptions): MockRequest {
    const id = (options.providerOptions?.["mock"] as { id?: number } | undefined)?.id;
    const request = id === undefined ? undefined : pending.get(id);
    if (request === undefined || id === undefined) {
      throw new Error("mock model: call was not tagged by the adapter settings hook");
    }
    pending.delete(id);
    return request;
  }

  async function answer(options: CallOptions, mode: "generateText" | "streamText") {
    const request = requestFor(options);
    const name = request.name ?? "*";
    const decision = "kind" in request && request.kind === "decision";
    calls.push({ kind: decision ? "decide" : mode, name, request, input: request.input });

    if (decision) {
      const event = await resolve(
        take(script.decisions, name),
        request as AgentDecisionRequest,
        options,
      );
      const { type, ...payload } = event;
      const offered = (request as AgentDecisionRequest).options;
      let toolName: string;
      let input: unknown;
      if (offered) {
        // A closed choice offers one `choose_option` tool over an enum of
        // option ids, in `request.options` order. Pick the scripted event's id;
        // an event no option equals gets an id outside the enum, so the run
        // takes the retry path.
        const tool = (options.tools ?? []).find((candidate) => candidate.name === OPTION_TOOL);
        const ids = optionIdsOf(tool);
        const index = offered.findIndex((option) => isDeepStrictEqual(option.event, event));
        toolName = OPTION_TOOL;
        input = { option: ids[index] ?? `${JSON.stringify(event)} (not offered)` };
      } else {
        const wanted = eventToolName(type);
        toolName = (options.tools ?? []).find((tool) => tool.name === wanted)?.name ?? wanted;
        input = payload;
      }
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: `call-${calls.length}`,
            toolName,
            input: JSON.stringify(input),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
        usage,
        warnings: [],
      };
    }

    const value = await resolve(take(script.text, name), request as AgentTextRequest, options);
    // The adapter asks for JSON on every structured request and envelopes the
    // declared output as `{ result }`; a plain-text request gets the string.
    const structured = options.responseFormat?.type === "json";
    const text = structured
      ? JSON.stringify({ result: value })
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
    return {
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage,
      warnings: [],
    };
  }

  const model = new MockLanguageModelV3({
    doGenerate: (options) => answer(options, "generateText"),
    doStream: async (options) => {
      const generated = await answer(options, "streamText");
      const part = generated.content[0]!;
      const chunks: StreamPart[] =
        part.type === "text"
          ? [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              ...part.text
                .split(/(?<=\s)/)
                .map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: generated.finishReason, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              part,
              { type: "finish", finishReason: generated.finishReason, usage },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });

  const executors = createAiSdkExecutors({
    // One mock answers every model ref the machine declares.
    resolveModel: () => model,
    settings: (request) => {
      const id = ++sequence;
      pending.set(id, request);
      return { providerOptions: { mock: { id } } };
    },
  });

  return Object.assign(executors, { calls });
}
