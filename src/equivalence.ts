/**
 * Verified equivalence — prove a port behaves like the code it replaces.
 *
 * A port is equivalent when, given the same model answers and the same tool
 * results, it produces the same OBSERVABLE EFFECTS: the same number of model
 * calls, the same tool calls with the same arguments, and the same output.
 * Prompts, internal steps, and states are free to differ.
 *
 * 1. Record the original: wrap its model (`recorder.model`, an AI SDK
 *    `LanguageModelV3`, or `recorder.openai`, an `openai` client) and its tools
 *    (`recorder.tool` / `recorder.tools`), run a scenario, call
 *    `recorder.output(result)`, and save `recorder.recording`.
 * 2. Replay it on the port: `createRecorder({ replay: recording })` answers
 *    every model call and tool call from the recording, with no API key and no
 *    side effects, and records what the port did.
 * 3. `compareRecordings(original, port)` reports the first effect that differs.
 *
 * A port that changes how it calls the model on purpose (a model-picked action
 * that became `agent.decide`, a stream that became `doGenerate`) still replays:
 * `translate` turns the recorded answer into one that fits, `fallback` answers
 * the calls the original never made, and `compareRecordings(…, { kinds })`
 * compares only tool calls and output.
 *
 * Any other client (`@anthropic-ai/sdk`, `@google/genai`, a framework's own
 * model client) records through `recorder.client` or `recorder.fn`: each call
 * is a `call` effect, answered in replay by name and order.
 *
 * Provider-free: every seam is wrapped structurally, so this module imports
 * neither `ai` nor `openai`.
 * @module
 */
import { isAsyncIterable } from "./internal/effects.js";

/** An error as recorded: JSON-safe. */
export interface RecordedError {
  name: string;
  message: string;
  code?: unknown;
  /** The error's own number and boolean fields, such as `statusCode` and
   * `isRetryable`; replay restores them. */
  data?: Record<string, number | boolean>;
  /** `Symbol.for` keys set to `true` on the error, such as the AI SDK's
   * `vercel.ai.error.AI_APICallError`; replay restores them, so checks like
   * `APICallError.isInstance` still pass. */
  markers?: string[];
  /** `name` was an own enumerable field, as the AI SDK's errors set it; replay keeps it so. */
  ownName?: true;
}

/** One model call. `call` is its 0-based position among model calls. */
export interface RecordedModelCall {
  kind: "model";
  /** Which wrapper saw it. */
  seam: "ai-sdk" | "openai";
  /** `doGenerate`/`doStream`/`doDecide`, or `chat.completions.create`/`responses.create`. */
  method: string;
  call: number;
  /** The call options or params, JSON-safe (abort signals and headers dropped). */
  request: unknown;
  /** The non-streaming result. */
  response?: unknown;
  /** The stream's parts or chunks, in order. */
  stream?: unknown[];
  error?: RecordedError;
  /** In replay, the recorded call (its `call`) whose answer served this one. */
  replayed?: number;
  /** In replay, `translate` adapted the recorded answer to this call. */
  translated?: true;
  /** In replay, no recorded call fit, so `fallback` answered it. */
  unrecorded?: true;
}

/** One tool call. `step` is the number of model calls made before it. */
export interface RecordedToolCall {
  kind: "tool";
  name: string;
  step: number;
  input: unknown;
  output?: unknown;
  error?: RecordedError;
  /** The tool returned without a Promise; replay answers synchronously too. */
  sync?: true;
  /** Started while an earlier tool call was still running. Concurrent calls
   * may finish in either order; sequential ones must keep theirs. */
  concurrent?: true;
  /** In replay, no recorded call matched, so `fallback.tools` ran the tool. */
  unrecorded?: true;
}

/**
 * One call to a function wrapped with `recorder.fn` or `recorder.client`.
 * `call` is its 0-based position among calls with the same `name`.
 */
export interface RecordedCall {
  kind: "call";
  /** The `fn` name, or the client name and method path: `anthropic.messages.create`. */
  name: string;
  call: number;
  /** The arguments, JSON-safe (trailing `undefined` dropped), or what `redact` returned. */
  args: unknown;
  /** The resolved value, JSON-safe, or what `serialize` returned. */
  result?: unknown;
  /** The chunks of a resolved async iterable, in order. */
  stream?: unknown[];
  error?: RecordedError;
}

/** Options for `recorder.fn` and `recorder.client`. */
export interface RecordCallOptions {
  /**
   * What to record of the arguments, instead of all of them: drop a secret,
   * or keep only the fields that must match in {@link compareRecordings}.
   */
  redact?: (args: unknown[]) => unknown;
  /**
   * What to record of a result that is not JSON (a class instance, a
   * `Response`). For an async iterable it maps each chunk.
   */
  serialize?: (value: unknown) => unknown;
  /**
   * In replay, builds the returned value from the recorded result, or from
   * the recorded chunks of a stream. Default: the result as recorded, or an
   * async iterable of the chunks.
   */
  revive?: (recorded: unknown) => unknown;
}

/** Options for `recorder.client`. */
export interface RecordClientOptions extends RecordCallOptions {
  /** Dot paths of the async methods to record: `["messages.create"]`. */
  methods: readonly string[];
}

/** The run's final result. */
export interface RecordedOutput {
  kind: "output";
  value: unknown;
}

export type RecordedEffect = RecordedModelCall | RecordedToolCall | RecordedCall | RecordedOutput;

/** A run's effects, in order. JSON-serializable: save it as a golden file. */
export interface Recording {
  version: 1;
  effects: RecordedEffect[];
}

/** Options for {@link createRecorder}. Omit for record mode. */
export interface CreateRecorderOptions {
  /** Answer model and tool calls from this recording instead of running them. */
  replay?: Recording;
  /**
   * In replay, `"replay"` (default) returns each tool's recorded result
   * without running it; `"live"` runs the wrapped tool (your stub) and records
   * what it returned.
   */
  tools?: "replay" | "live";
  /**
   * In replay, which model calls a recorded answer may serve. `"shape"`
   * (default) refuses a call whose offered tools or response format changed,
   * since the recorded answer may not fit it; see {@link ModelCallMatch}.
   */
  modelCalls?: ModelCallMatch;
  /**
   * In replay, maps the recorded and the new tool call before matching them,
   * like {@link CompareRecordingsOptions.normalize}: redact a generated id in a
   * tool's input so the recorded result still answers it. A dropped
   * (`undefined`) effect matches as recorded.
   */
  normalize?: NormalizeEffect;
  /**
   * In replay, adapts a recorded answer to a model call you changed on
   * purpose. Called with each unused recorded call, in order, until it
   * returns an answer; that answer serves the call regardless of method and
   * shape, and {@link compareRecordings} counts the pair as the same call.
   * Return `undefined` to leave a recorded call to the usual matching.
   *
   * @example
   * ```ts
   * // The original streamed; the port generates.
   * translate: (recorded, actual) =>
   *   actual.method === "doGenerate" && recorded.method === "doStream"
   *     ? { response: toGenerateResult(recorded.stream) }
   *     : undefined,
   * ```
   */
  translate?: (recorded: RecordedModelCall, actual: RecordedModelCall) => ModelAnswer | undefined;
  /**
   * In replay, answers what the recording cannot, instead of throwing
   * {@link RecordingDivergenceError}: a model call no recorded call fits (the
   * port's retry or an added call) goes to `model` (AI SDK seam) or `openai`
   * (client seam), and with `tools: true` a tool call no recorded call matches
   * runs the wrapped tool. Such effects are marked `unrecorded` and still
   * count as extra in {@link compareRecordings}.
   */
  fallback?: {
    model?: RecordableModel;
    openai?: object;
    tools?: boolean;
  };
}

/** A model call's answer: the result, the stream's parts, or an error. */
export interface ModelAnswer {
  response?: unknown;
  stream?: unknown[];
  error?: RecordedError;
}

/**
 * Maps an effect before matching or comparing; `undefined` drops it.
 * `index` and `effects` are its position in the whole recording, so a repeat
 * of an earlier effect (an idempotent write made again) can be dropped.
 */
export type NormalizeEffect = (
  effect: RecordedEffect,
  index: number,
  effects: readonly RecordedEffect[],
) => RecordedEffect | undefined;

/**
 * When two model calls count as the same: `"shape"` compares offered tool
 * names and response format, `"none"` only that a call happened, and a
 * function decides per call (allow the changes you made on purpose and fall
 * back to {@link sameModelCallShape}).
 */
export type ModelCallMatch =
  | "shape"
  | "none"
  | ((expected: RecordedModelCall, actual: RecordedModelCall) => boolean);

/** The structural slice of an AI SDK `LanguageModelV3` the recorder wraps. */
export interface RecordableLanguageModel {
  doGenerate(options: never): PromiseLike<unknown>;
  doStream(options: never): PromiseLike<{ stream: ReadableStream<unknown> }>;
}

/** The structural slice of an AI SDK decision model (`experimental_decide`). */
export interface RecordableDecisionModel {
  doDecide(options: never): PromiseLike<unknown>;
}

/** An AI SDK model the recorder can wrap. */
export type RecordableModel = RecordableLanguageModel | RecordableDecisionModel;

type AnyFunction = (...args: never[]) => unknown;

/** The slice of the `openai` SDK's `APIPromise` the recorder keeps. */
type APIPromiseLike = PromiseLike<unknown> & {
  withResponse?: () => Promise<{ response: Response; request_id: string | null }>;
};

/** Records (or replays) the effects of one run. */
export interface Recorder {
  /**
   * Wraps an AI SDK `LanguageModelV3` (`openai("gpt-…")`, `anthropic(…)`) or
   * decision model (`doDecide`), keeping its type. In replay the model is
   * never called, so a provider model built with no API key works.
   */
  model<TModel extends RecordableModel>(model: TModel): TModel;
  /**
   * Wraps an `openai` client's `chat.completions.create` and
   * `responses.create`, keeping its type. A streamed result is an async
   * iterable only. In replay the client is never called, so
   * `new OpenAI({ apiKey: "replay" })` works.
   */
  openai<TClient extends object>(client: TClient): TClient;
  /** Wraps one tool function. Its arguments are the recorded input. */
  tool<TFn extends AnyFunction>(name: string, fn: TFn): TFn;
  /** Wraps every `execute` in an AI SDK tool set, named by key. */
  tools<TTools extends Record<string, { execute?: AnyFunction }>>(tools: TTools): TTools;
  /**
   * Wraps any async function, keeping its type. Each call is a
   * {@link RecordedCall}. In replay the function is never called: each call
   * gets the next unused recorded result for `name`, in order, whatever its
   * arguments; {@link compareRecordings} reports arguments that differ.
   */
  fn<TFn extends (...args: never[]) => PromiseLike<unknown>>(
    name: string,
    fn: TFn,
    options?: RecordCallOptions,
  ): TFn;
  /**
   * Wraps the async methods at `options.methods` of a client object, keeping
   * its type, as `fn` named `<name>.<path>`. Other members pass through. In
   * replay the client is never called, and missing objects on a method's path
   * are stood in for, so `{} as Anthropic` works.
   */
  client<TClient extends object>(
    name: string,
    client: TClient,
    options: RecordClientOptions,
  ): TClient;
  /** Records the run's final result. */
  output(value: unknown): void;
  /** What this run did so far. */
  readonly recording: Recording;
}

/**
 * Thrown in replay when the port asks for something the recording cannot
 * answer: a model call past the last recorded one, or a tool call the original
 * never made. The effect is still recorded, so {@link compareRecordings}
 * reports it.
 */
export class RecordingDivergenceError extends Error {
  override name = "RecordingDivergenceError";
}

function toRecordedError(error: unknown): RecordedError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const recorded: RecordedError = { name: error.name, message: error.message };
  if (Object.prototype.propertyIsEnumerable.call(error, "name")) recorded.ownName = true;
  const code = (error as { code?: unknown }).code;
  if (code !== undefined) recorded.code = toJson(code);
  // Only number and boolean fields: string and object fields (a URL with a
  // key in it, a response body, the request) can carry secrets or the prompt.
  const data = Object.fromEntries(
    Object.entries(error).filter(
      ([key, value]) => key !== "code" && (typeof value === "number" || typeof value === "boolean"),
    ),
  ) as Record<string, number | boolean>;
  if (Object.keys(data).length) recorded.data = data;
  const markers = new Set<string>();
  for (let holder: object | null = error; holder; holder = Object.getPrototypeOf(holder)) {
    for (const symbol of Object.getOwnPropertySymbols(holder)) {
      const key = Symbol.keyFor(symbol);
      if (key !== undefined && (error as unknown as Record<symbol, unknown>)[symbol] === true) {
        markers.add(key);
      }
    }
  }
  if (markers.size) recorded.markers = [...markers];
  return recorded;
}

function fromRecordedError({ data, markers, name, ownName, ...fields }: RecordedError): Error {
  const error = Object.assign(new Error(fields.message), fields, data);
  // Enumerable only when the original's was, so the revived one serializes alike.
  if (ownName || name !== "Error") {
    Object.defineProperty(error, "name", {
      value: name,
      writable: true,
      configurable: true,
      enumerable: ownName ?? false,
    });
  }
  for (const marker of markers ?? []) {
    (error as unknown as Record<symbol, boolean>)[Symbol.for(marker)] = true;
  }
  return error;
}

/** What two runs compare of an error: its data and markers may differ. */
function errorIdentity(error: RecordedError | undefined): unknown {
  return error && { name: error.name, message: error.message, code: error.code };
}

/** A JSON-safe copy: Dates become ISO strings, Errors become {@link RecordedError}. */
function toJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(value, function (key, item: unknown) {
      const raw = (this as Record<string, unknown>)[key];
      if (raw instanceof Date) return raw.toISOString();
      if (item instanceof Error) return toRecordedError(item);
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Uint8Array) return Array.from(item);
      return item;
    }),
  );
}

/** Restores the `Date` timestamps the AI SDK puts on responses. */
function reviveTimestamps<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const holder of [
      value as Record<string, unknown>,
      (value as { response?: Record<string, unknown> }).response,
    ]) {
      if (holder && typeof holder["timestamp"] === "string") {
        holder["timestamp"] = new Date(holder["timestamp"]);
      }
    }
  }
  return value;
}

function omit(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

/**
 * Key-order-independent JSON, for equality.
 * @internal
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(toJson(a)) === stableStringify(toJson(b));
}

function streamFrom(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(reviveTimestamps(structuredClone(part)));
      controller.close();
    },
  });
}

async function* iterate(chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield structuredClone(chunk);
}

/**
 * Creates a {@link Recorder}. With no options it records: every wrapped call
 * runs for real. With `replay` it answers from a recording instead.
 */
export function createRecorder(options: CreateRecorderOptions = {}): Recorder {
  const effects: RecordedEffect[] = [];
  const replay = options.replay?.effects;
  const replayedModels = replay?.filter(
    (effect): effect is RecordedModelCall => effect.kind === "model",
  );
  const usedModels = new Set<RecordedModelCall>();
  const usedTools = new Set<RecordedToolCall>();
  const usedCalls = new Set<RecordedCall>();
  const callCounts = new Map<string, number>();
  const normalizeEffect = (effect: RecordedEffect, list: readonly RecordedEffect[]) =>
    options.normalize?.(effect, list.indexOf(effect), list) ?? effect;
  let modelCalls = 0;
  let toolsInFlight = 0;

  /**
   * The earliest unused recorded call that fits this one: one `translate`
   * adapts, or one with the same method and shape. Not by position, so a call
   * the port added or dropped does not shift every answer after it.
   */
  function nextReplayedModel(
    effect: RecordedModelCall,
  ): { recorded: RecordedModelCall; answer: ModelAnswer } | undefined {
    for (const recorded of replayedModels!) {
      if (usedModels.has(recorded)) continue;
      const translated = options.translate?.(structuredClone(recorded), effect);
      if (translated) {
        effect.translated = true;
        return { recorded, answer: translated };
      }
      if (
        recorded.method === effect.method &&
        modelCallsMatch(options.modelCalls, recorded, effect)
      ) {
        return { recorded, answer: recorded };
      }
    }
    return undefined;
  }

  function noAnswerMessage(effect: RecordedModelCall): string {
    const unused = replayedModels!.filter((recorded) => !usedModels.has(recorded));
    return unused.length
      ? `Model call #${effect.call} (${effect.method}, ${JSON.stringify(modelCallShape(effect))}) fits no unused recorded call: ${unused.map((recorded) => `#${recorded.call} (${recorded.method}, ${JSON.stringify(modelCallShape(recorded))})`).join(", ")}. A recorded answer only fits a call of the same method and shape; pass \`translate\` to adapt one.`
      : `Model call #${effect.call} was never made by the recorded run (it made ${replayedModels!.length}).`;
  }

  /**
   * Records a model call around `run`, or answers it from the recording.
   * `fallback` runs it on the stand-in when the recording has no answer.
   */
  async function modelCall(
    seam: RecordedModelCall["seam"],
    method: string,
    request: unknown,
    streamed: boolean,
    run: () => Promise<unknown>,
    fallback?: () => Promise<unknown>,
  ): Promise<unknown> {
    const effect: RecordedModelCall = {
      kind: "model",
      seam,
      method,
      call: modelCalls++,
      request: toJson(omit(request, ["abortSignal", "headers", "signal"])),
    };
    effects.push(effect);
    if (replay) {
      const replayed = nextReplayedModel(effect);
      if (replayed) {
        const { recorded, answer } = replayed;
        usedModels.add(recorded);
        effect.replayed = recorded.call;
        if (answer.error) {
          effect.error = answer.error;
          throw fromRecordedError(answer.error);
        }
        effect.response = answer.response;
        effect.stream = answer.stream;
        if (seam === "openai") {
          return streamed ? iterate(answer.stream ?? []) : structuredClone(answer.response);
        }
        return streamed
          ? {
              ...reviveTimestamps(structuredClone(answer.response) ?? {}),
              stream: streamFrom(answer.stream ?? []),
            }
          : reviveTimestamps(structuredClone(answer.response));
      }
      if (!fallback) {
        const error = new RecordingDivergenceError(noAnswerMessage(effect));
        effect.error = toRecordedError(error);
        throw error;
      }
      effect.unrecorded = true;
      run = fallback;
    }
    let result: unknown;
    try {
      result = await run();
    } catch (error) {
      effect.error = toRecordedError(error);
      throw error;
    }
    if (!streamed) {
      effect.response = toJson(result);
      return result;
    }
    const parts: unknown[] = [];
    effect.stream = parts;
    if (seam === "openai") {
      const source = result as AsyncIterable<unknown>;
      return (async function* () {
        for await (const chunk of source) {
          parts.push(toJson(chunk));
          yield chunk;
        }
      })();
    }
    const { stream, ...rest } = result as { stream: ReadableStream<unknown> };
    effect.response = toJson(rest);
    return {
      ...rest,
      stream: stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            parts.push(toJson(part));
            controller.enqueue(part);
          },
        }),
      ),
    };
  }

  /** `inputOf` picks the recorded input from the call's arguments. */
  function tool<TFn extends AnyFunction>(
    name: string,
    fn: TFn,
    inputOf = (args: unknown[]) => (args.length === 1 ? args[0] : args),
  ): TFn {
    return ((...args: unknown[]) => {
      const input = toJson(inputOf(args));
      const effect: RecordedToolCall = {
        kind: "tool",
        name,
        step: modelCalls,
        input,
        ...(toolsInFlight > 0 ? { concurrent: true as const } : {}),
      };
      effects.push(effect);
      return track(call(effect, args));
    }) as unknown as TFn;

    function call(effect: RecordedToolCall, args: unknown[]): unknown {
      const { input } = effect;
      if (replay && options.tools !== "live") {
        const wanted = (normalizeEffect(effect, effects) as RecordedToolCall).input;
        const matches = (candidate: RecordedEffect): candidate is RecordedToolCall =>
          candidate.kind === "tool" &&
          !usedTools.has(candidate) &&
          candidate.name === name &&
          jsonEqual((normalizeEffect(candidate, replay) as RecordedToolCall).input, wanted);
        // The earliest unused call with the same name and input, at any step:
        // a port that makes more or fewer model calls still gets the recorded
        // results, in the order they were recorded (a polled status still
        // reads `pending` before `ready`).
        const recorded = replay.find(matches);
        if (!recorded && options.fallback?.tools) {
          effect.unrecorded = true;
          return runLive(effect, args);
        }
        // A tool the original ran synchronously stays synchronous.
        const settle = (value: () => unknown) => {
          if (recorded?.sync) return value();
          try {
            return Promise.resolve(value());
          } catch (error) {
            return Promise.reject(error);
          }
        };
        return settle(() => {
          if (!recorded) {
            const error = new RecordingDivergenceError(
              `Tool '${name}' was called with ${JSON.stringify(input)}; the recorded run made no such call.`,
            );
            effect.error = toRecordedError(error);
            throw error;
          }
          usedTools.add(recorded);
          if (recorded.sync) effect.sync = true;
          if (recorded.error) {
            effect.error = recorded.error;
            throw fromRecordedError(recorded.error);
          }
          effect.output = recorded.output;
          return structuredClone(recorded.output);
        });
      }
      return runLive(effect, args);
    }

    function runLive(effect: RecordedToolCall, args: unknown[]): unknown {
      let output: unknown;
      try {
        output = (fn as unknown as (...args: unknown[]) => unknown)(...args);
      } catch (error) {
        effect.sync = true;
        effect.error = toRecordedError(error);
        throw error;
      }
      if (!(output instanceof Promise)) {
        effect.sync = true;
        effect.output = toJson(output);
        return output;
      }
      return output.then(
        (value) => {
          effect.output = toJson(value);
          return value;
        },
        (error: unknown) => {
          effect.error = toRecordedError(error);
          throw error;
        },
      );
    }
  }

  function fn<TFn extends (...args: never[]) => PromiseLike<unknown>>(
    name: string,
    run: TFn,
    callOptions: RecordCallOptions = {},
  ): TFn {
    const { redact, serialize = toJson, revive } = callOptions;
    return (async (...args: unknown[]) => {
      const passed = [...args];
      while (passed.length && passed.at(-1) === undefined) passed.pop();
      const call = callCounts.get(name) ?? 0;
      callCounts.set(name, call + 1);
      const effect: RecordedCall = {
        kind: "call",
        name,
        call,
        args: toJson(redact ? redact(passed) : passed),
      };
      effects.push(effect);
      if (replay) {
        const recorded = replay.find(
          (candidate): candidate is RecordedCall =>
            candidate.kind === "call" && candidate.name === name && !usedCalls.has(candidate),
        );
        if (!recorded) {
          const error = new RecordingDivergenceError(
            `Call #${call} to '${name}' was never made by the recorded run.`,
          );
          effect.error = toRecordedError(error);
          throw error;
        }
        usedCalls.add(recorded);
        if (recorded.error) {
          effect.error = recorded.error;
          throw fromRecordedError(recorded.error);
        }
        if (recorded.stream) {
          effect.stream = recorded.stream;
          const chunks = structuredClone(recorded.stream);
          return revive ? revive(chunks) : iterate(chunks);
        }
        effect.result = recorded.result;
        const result = structuredClone(recorded.result);
        return revive ? revive(result) : result;
      }
      let result: unknown;
      try {
        result = await (run as unknown as (...args: unknown[]) => PromiseLike<unknown>)(...args);
      } catch (error) {
        effect.error = toRecordedError(error);
        throw error;
      }
      if (!isAsyncIterable(result)) {
        effect.result = toJson(serialize(result));
        return result;
      }
      const chunks: unknown[] = [];
      effect.stream = chunks;
      const source = result;
      return (async function* () {
        try {
          for await (const chunk of source) {
            chunks.push(toJson(serialize(chunk)));
            yield chunk;
          }
        } catch (error) {
          effect.error = toRecordedError(error);
          throw error;
        }
      })();
    }) as unknown as TFn;
  }

  /** Counts an async tool call as running until it settles. */
  function track(result: unknown): unknown {
    if (result instanceof Promise) {
      toolsInFlight++;
      const settled = () => {
        toolsInFlight--;
      };
      result.then(settled, settled);
    }
    return result;
  }

  return {
    model(model) {
      const base = model as unknown as Record<string, unknown>;
      const stand = options.fallback?.model as Record<string, unknown> | undefined;
      const wrapped = Object.create(base) as Record<string, unknown>;
      // Only the methods the model has: the AI SDK tells a decision model
      // (`doDecide`, or the deprecated `doEvaluate`) by which ones exist.
      for (const method of ["doGenerate", "doStream", "doDecide", "doEvaluate"]) {
        if (typeof base[method] !== "function") continue;
        const invoke = (target: Record<string, unknown>, callOptions: unknown) =>
          (target[method] as (o: unknown) => Promise<unknown>).call(target, callOptions);
        wrapped[method] = (callOptions: unknown) =>
          modelCall(
            "ai-sdk",
            method,
            callOptions,
            method === "doStream",
            () => invoke(base, callOptions),
            stand && typeof stand[method] === "function"
              ? () => invoke(stand, callOptions)
              : undefined,
          );
      }
      return wrapped as never;
    },
    openai(client) {
      // Proxies, not copies: the SDK's resources are class instances, so a
      // spread would drop prototype methods like `responses.parse`, which
      // reach `create` through `this` and so get recorded too.
      const wrapCreate = (resource: object, method: string) =>
        new Proxy(resource, {
          get(target, key, receiver) {
            if (key !== "create") return Reflect.get(target, key, receiver);
            return (params: { stream?: boolean }, requestOptions?: unknown) => {
              let api: APIPromiseLike | undefined;
              const create = (resource: object) => () => {
                api = (
                  Reflect.get(resource, "create") as (p: unknown, o?: unknown) => unknown
                ).call(resource, params, requestOptions) as APIPromiseLike;
                return Promise.resolve(api);
              };
              const stand = fallbackResource(method);
              const promise = modelCall(
                "openai",
                method,
                params,
                params?.stream === true,
                create(target),
                stand && create(stand),
              );
              // The SDK's `create` returns an `APIPromise`; keep its
              // `withResponse()`. In replay there is no HTTP response.
              return Object.assign(promise, {
                withResponse: async () => {
                  const data = await promise;
                  const meta = await api?.withResponse?.();
                  return {
                    data,
                    response: meta?.response ?? new Response(null),
                    request_id: meta?.request_id ?? null,
                  };
                },
              });
            };
          },
        });
      // The fallback client's resource for `method`, by the same path.
      const fallbackResource = (method: string): object | undefined => {
        let value: unknown = options.fallback?.openai;
        for (const key of method.split(".").slice(0, -1)) {
          value = (value as Record<string, unknown> | undefined)?.[key];
        }
        return value && typeof value === "object" ? value : undefined;
      };
      const wrapped = new Map<PropertyKey, object>();
      const wrap = (key: PropertyKey, make: () => object) => {
        if (!wrapped.has(key)) wrapped.set(key, make());
        return wrapped.get(key);
      };
      return new Proxy(client, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver) as Record<string, unknown> | undefined;
          if (key === "responses" && value)
            return wrap(key, () => wrapCreate(value, "responses.create"));
          if (key === "chat" && value) {
            return wrap(
              key,
              () =>
                new Proxy(value, {
                  get(chat, chatKey, chatReceiver) {
                    const inner = Reflect.get(chat, chatKey, chatReceiver) as object | undefined;
                    return chatKey === "completions" && inner
                      ? wrap("chat.completions", () => wrapCreate(inner, "chat.completions.create"))
                      : inner;
                  },
                }),
            );
          }
          return value;
        },
      });
    },
    tool: (name, fn) => tool(name, fn),
    fn,
    client(name, client, { methods, ...callOptions }) {
      const paths = methods.map((method) => method.split("."));
      const startsWith = (path: string[], prefix: string[]) =>
        prefix.every((key, index) => path[index] === key);
      const wrapAt = (target: object, prefix: string[]): object => {
        const wrapped = new Map<string, unknown>();
        return new Proxy(target, {
          get(object, key, receiver) {
            if (typeof key !== "string") return Reflect.get(object, key, receiver);
            const path = [...prefix, key];
            const method = paths.some((p) => p.length === path.length && startsWith(p, path));
            if (!method && !paths.some((p) => startsWith(p, path))) {
              return Reflect.get(object, key, receiver);
            }
            if (!wrapped.has(key)) {
              const value = Reflect.get(object, key, receiver) as unknown;
              wrapped.set(
                key,
                method
                  ? fn(
                      `${name}.${path.join(".")}`,
                      (...args: unknown[]) =>
                        (value as (...args: unknown[]) => PromiseLike<unknown>).apply(object, args),
                      callOptions,
                    )
                  : wrapAt(value && typeof value === "object" ? value : {}, path),
              );
            }
            return wrapped.get(key);
          },
        });
      };
      return wrapAt(client, []) as never;
    },
    tools(tools) {
      return Object.fromEntries(
        Object.entries(tools).map(([name, definition]) => [
          name,
          definition.execute // The AI SDK's second argument is call metadata (ids, messages, signal), not input.
            ? { ...definition, execute: tool(name, definition.execute, (args) => args[0]) }
            : definition,
        ]),
      ) as never;
    },
    output(value) {
      effects.push({ kind: "output", value: toJson(value) });
    },
    get recording() {
      return { version: 1 as const, effects: toJson(effects) as RecordedEffect[] };
    },
  };
}

/** Why two effects differ. */
export type EffectDivergenceReason =
  | "missing-effect"
  | "extra-effect"
  | "kind"
  | "model-method"
  | "model-call-shape"
  | "model-error"
  | "tool-name"
  | "tool-input"
  | "tool-result"
  | "call-name"
  | "call-args"
  | "call-result"
  | "output";

/** The first effect where two recordings differ. */
export interface EffectDivergence {
  /** Position in the compared (tool-order-normalized) effect lists. */
  index: number;
  reason: EffectDivergenceReason;
  expected?: RecordedEffect;
  actual?: RecordedEffect;
  /** One sentence, for test failures. */
  message: string;
}

/** The result of {@link compareRecordings}. */
export interface EquivalenceReport {
  equivalent: boolean;
  /** The first divergence, by position in the original's effects. */
  divergence?: EffectDivergence;
  /** Every divergence, in order. Effects both runs made line up between them. */
  divergences: EffectDivergence[];
}

/** Options for {@link compareRecordings}. */
export interface CompareRecordingsOptions {
  /** When two model calls count as the same. Default `"shape"`. */
  modelCalls?: ModelCallMatch;
  /**
   * Maps each effect before comparing, on both sides: redact values that
   * differ on every run (generated ids, timestamps), project a tool's input
   * to the fields that matter, or return `undefined` to drop the effect.
   */
  normalize?: NormalizeEffect;
  /**
   * Which kinds of effect to compare. Default all. `["tool", "output"]`
   * compares a port that calls the model differently (another protocol, a
   * structured draft instead of a tool loop) by what it did, not how it asked.
   */
  kinds?: readonly RecordedEffect["kind"][];
}

/** True when two model calls offer the same tool names and response format. */
export function sameModelCallShape(
  expected: RecordedModelCall,
  actual: RecordedModelCall,
): boolean {
  return jsonEqual(modelCallShape(expected), modelCallShape(actual));
}

function modelCallsMatch(
  match: ModelCallMatch | undefined,
  expected: RecordedModelCall,
  actual: RecordedModelCall,
): boolean {
  if (match === "none") return true;
  if (typeof match === "function") return match(expected, actual);
  return sameModelCallShape(expected, actual);
}

function shapeMessage(expected: RecordedModelCall, actual: RecordedModelCall): string {
  return `Model call #${expected.call} changed shape: ${JSON.stringify(modelCallShape(expected))} → ${JSON.stringify(modelCallShape(actual))}. A recorded answer only fits a call of the same shape.`;
}

/**
 * Offered tool names and the response format, or a decision's questions and
 * their options: what a recorded answer depends on.
 */
function modelCallShape(effect: RecordedModelCall): unknown {
  const request = (effect.request ?? {}) as Record<string, unknown>;
  const questions = request["questions"];
  if (questions && typeof questions === "object") {
    return {
      questions: Object.entries(questions as Record<string, Record<string, unknown>>)
        .map(([name, question]) => {
          const criteria = question["criteria"];
          // A choice answers by option name, a score by level index.
          if (question["type"] === "choice" && criteria && typeof criteria === "object") {
            return [name, question["type"], Object.keys(criteria).sort()];
          }
          if (question["type"] === "score" && Array.isArray(criteria)) {
            return [name, question["type"], criteria.length];
          }
          return [name, question["type"]];
        })
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    };
  }
  const tools = Array.isArray(request["tools"])
    ? (request["tools"] as Record<string, unknown>[])
    : [];
  const names = tools
    .map(
      (tool) => tool["name"] ?? (tool["function"] as Record<string, unknown> | undefined)?.["name"],
    )
    .sort();
  const format =
    (request["responseFormat"] as Record<string, unknown> | undefined)?.["type"] ??
    (request["response_format"] as Record<string, unknown> | undefined)?.["type"] ??
    (
      (request["text"] as Record<string, unknown> | undefined)?.["format"] as
        | Record<string, unknown>
        | undefined
    )?.["type"] ??
    "text";
  return { tools: names, format };
}

/**
 * Puts each group of concurrent tool calls in a stable order, so parallel tool
 * calls that finished in a different order still compare equal. A tool call
 * that started after the previous one settled begins a new group, so
 * sequential calls keep their order.
 */
function normalize(effects: RecordedEffect[]): RecordedEffect[] {
  const result: RecordedEffect[] = [];
  let batch: RecordedToolCall[] = [];
  const flush = () => {
    result.push(
      ...batch.sort((a, b) =>
        stableStringify([a.name, a.input]).localeCompare(stableStringify([b.name, b.input])),
      ),
    );
    batch = [];
  };
  for (const effect of effects) {
    if (effect.kind !== "tool" || !effect.concurrent) flush();
    if (effect.kind === "tool") {
      batch.push(effect);
    } else {
      result.push(effect);
    }
  }
  flush();
  return result;
}

function describe(effect: RecordedEffect): string {
  switch (effect.kind) {
    case "model":
      return `model call #${effect.call} (${effect.method})`;
    case "tool":
      return `tool '${effect.name}' with ${JSON.stringify(effect.input)}`;
    case "call":
      return `call #${effect.call} to '${effect.name}' with ${JSON.stringify(effect.args)}`;
    case "output":
      return `output ${JSON.stringify(effect.value)}`;
  }
}

/** Why two effects differ, or `undefined` when they are the same. */
function differ(
  left: RecordedEffect,
  right: RecordedEffect,
  options: CompareRecordingsOptions,
): { reason: EffectDivergenceReason; message: string } | undefined {
  if (left.kind !== right.kind) {
    return {
      reason: "kind",
      message: `Expected ${describe(left)}; the port made ${describe(right)}.`,
    };
  }
  if (left.kind === "model" && right.kind === "model") {
    // `translate` adapted this recorded call's answer: the change is intended.
    if (right.translated && right.replayed === left.call) return undefined;
    if (left.method !== right.method) {
      return {
        reason: "model-method",
        message: `Model call #${left.call} used ${left.method}; the port used ${right.method}.`,
      };
    }
    if (!modelCallsMatch(options.modelCalls, left, right)) {
      return { reason: "model-call-shape", message: shapeMessage(left, right) };
    }
    if (!jsonEqual(errorIdentity(left.error), errorIdentity(right.error))) {
      const outcome = (error?: RecordedError) =>
        error ? `failed with ${error.name}: ${error.message}` : "succeeded";
      return {
        reason: "model-error",
        message: `Model call #${left.call} ${outcome(left.error)}; in the port it ${outcome(right.error)}.`,
      };
    }
    return undefined;
  }
  if (left.kind === "tool" && right.kind === "tool") {
    if (left.name !== right.name) {
      return {
        reason: "tool-name",
        message: `Expected ${describe(left)}; the port made ${describe(right)}.`,
      };
    }
    if (!jsonEqual(left.input, right.input)) {
      return {
        reason: "tool-input",
        message: `Expected ${describe(left)}; the port passed ${JSON.stringify(right.input)}.`,
      };
    }
    if (
      !jsonEqual(left.output, right.output) ||
      !jsonEqual(errorIdentity(left.error), errorIdentity(right.error))
    ) {
      return { reason: "tool-result", message: `Tool '${left.name}' returned a different result.` };
    }
    return undefined;
  }
  if (left.kind === "call" && right.kind === "call") {
    if (left.name !== right.name) {
      return {
        reason: "call-name",
        message: `Expected ${describe(left)}; the port made ${describe(right)}.`,
      };
    }
    if (!jsonEqual(left.args, right.args)) {
      return {
        reason: "call-args",
        message: `Expected ${describe(left)}; the port passed ${JSON.stringify(right.args)}.`,
      };
    }
    if (
      !jsonEqual(left.result, right.result) ||
      !jsonEqual(left.stream, right.stream) ||
      !jsonEqual(errorIdentity(left.error), errorIdentity(right.error))
    ) {
      return {
        reason: "call-result",
        message: `Call #${left.call} to '${left.name}' returned a different result.`,
      };
    }
    return undefined;
  }
  if (left.kind === "output" && right.kind === "output" && !jsonEqual(left.value, right.value)) {
    return {
      reason: "output",
      message: `Expected ${describe(left)}; the port returned ${JSON.stringify(right.value)}.`,
    };
  }
  return undefined;
}

/**
 * Compares two recordings and reports every effect that differs. `expected`
 * is the original's recording, `actual` the port's. Effects that are the same
 * on both sides are lined up first (longest common subsequence), so one extra
 * call does not shift every effect after it; between them, effects of the same
 * kind pair up and report what changed, and the rest are missing or extra.
 */
export function compareRecordings(
  expected: Recording,
  actual: Recording,
  options: CompareRecordingsOptions = {},
): EquivalenceReport {
  const select = (effects: RecordedEffect[]) =>
    normalize(
      effects.flatMap((effect, index) => {
        if (options.kinds && !options.kinds.includes(effect.kind)) return [];
        const mapped = options.normalize ? options.normalize(effect, index, effects) : effect;
        return mapped ? [mapped] : [];
      }),
    );
  const a = select(expected.effects);
  const b = select(actual.effects);
  const same = a.map((left) => b.map((right) => !differ(left, right, options)));
  const lcs = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = same[i]![j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const divergences: EffectDivergence[] = [];
  let lefts: number[] = [];
  let rights: number[] = [];
  // `at` is where the gap ends in the original: an extra effect sits there.
  const flushGap = (at: number) => {
    const unpairedRights = [...rights];
    const changed: EffectDivergence[] = [];
    for (const index of lefts) {
      const left = a[index]!;
      const k = unpairedRights.findIndex((j) => b[j]!.kind === left.kind);
      if (k === -1) {
        changed.push({
          index,
          // A missing output is a run that did not return: the outputs differ.
          reason: left.kind === "output" ? "output" : "missing-effect",
          expected: left,
          message:
            left.kind === "output"
              ? `The port never returned; the original returned ${JSON.stringify(left.value)}.`
              : `The port never made ${describe(left)}.`,
        });
        continue;
      }
      const right = b[unpairedRights.splice(k, 1)[0]!]!;
      const difference = differ(left, right, options);
      if (difference) changed.push({ index, expected: left, actual: right, ...difference });
    }
    // An extra effect comes first: it is usually the cause of what follows.
    for (const j of unpairedRights) {
      const extra = b[j]!;
      divergences.push({
        index: lefts[0] ?? at,
        reason: extra.kind === "output" ? "output" : "extra-effect",
        actual: extra,
        message:
          extra.kind === "output"
            ? `The original never returned; the port returned ${JSON.stringify(extra.value)}.`
            : `The port made ${describe(extra)}, which the original never made.`,
      });
    }
    divergences.push(...changed);
    lefts = [];
    rights = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && same[i]![j]) {
      flushGap(i);
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      rights.push(j++);
    } else {
      lefts.push(i++);
    }
  }
  flushGap(i);
  divergences.sort((x, y) => x.index - y.index);
  return divergences.length
    ? { equivalent: false, divergence: divergences[0], divergences }
    : { equivalent: true, divergences };
}
