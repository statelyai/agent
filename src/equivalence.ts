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
 * Provider-free: both seams are wrapped structurally, so this module imports
 * neither `ai` nor `openai`.
 * @module
 */

/** An error as recorded: JSON-safe. */
export interface RecordedError {
  name: string;
  message: string;
  code?: unknown;
}

/** One model call. `call` is its 0-based position among model calls. */
export interface RecordedModelCall {
  kind: "model";
  /** Which wrapper saw it. */
  seam: "ai-sdk" | "openai";
  /** `doGenerate`/`doStream`, or `chat.completions.create`/`responses.create`. */
  method: string;
  call: number;
  /** The call options or params, JSON-safe (abort signals and headers dropped). */
  request: unknown;
  /** The non-streaming result. */
  response?: unknown;
  /** The stream's parts or chunks, in order. */
  stream?: unknown[];
  error?: RecordedError;
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
}

/** The run's final result. */
export interface RecordedOutput {
  kind: "output";
  value: unknown;
}

export type RecordedEffect = RecordedModelCall | RecordedToolCall | RecordedOutput;

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
}

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

type AnyFunction = (...args: never[]) => unknown;

/** Records (or replays) the effects of one run. */
export interface Recorder {
  /**
   * Wraps an AI SDK `LanguageModelV3` (`openai("gpt-…")`, `anthropic(…)`),
   * keeping its type. In replay the model is never called, so a provider
   * model built with no API key works.
   */
  model<TModel extends RecordableLanguageModel>(model: TModel): TModel;
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
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return code === undefined
      ? { name: error.name, message: error.message }
      : { name: error.name, message: error.message, code: toJson(code) };
  }
  return { name: "Error", message: String(error) };
}

function fromRecordedError(error: RecordedError): Error {
  return Object.assign(new Error(error.message), error);
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

/** Key-order-independent JSON, for equality. */
function stableStringify(value: unknown): string {
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
  const usedTools = new Set<RecordedToolCall>();
  let modelCalls = 0;

  function nextReplayedModel(effect: RecordedModelCall): RecordedModelCall {
    const recorded = replayedModels![effect.call];
    if (!recorded) {
      throw new RecordingDivergenceError(
        `Model call #${effect.call} was never made by the recorded run (it made ${replayedModels!.length}).`,
      );
    }
    if (recorded.method !== effect.method) {
      throw new RecordingDivergenceError(
        `Model call #${effect.call} uses ${effect.method}; the recorded run used ${recorded.method}.`,
      );
    }
    if (!modelCallsMatch(options.modelCalls, recorded, effect)) {
      throw new RecordingDivergenceError(shapeMessage(recorded, effect));
    }
    return recorded;
  }

  /** Records a model call around `run`, or answers it from the recording. */
  async function modelCall(
    seam: RecordedModelCall["seam"],
    method: string,
    request: unknown,
    streamed: boolean,
    run: () => Promise<unknown>,
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
      let recorded: RecordedModelCall;
      try {
        recorded = nextReplayedModel(effect);
      } catch (error) {
        effect.error = toRecordedError(error);
        throw error;
      }
      if (recorded.error) {
        effect.error = recorded.error;
        throw fromRecordedError(recorded.error);
      }
      effect.response = recorded.response;
      effect.stream = recorded.stream;
      if (seam === "openai") {
        return streamed ? iterate(recorded.stream ?? []) : structuredClone(recorded.response);
      }
      return streamed
        ? {
            ...reviveTimestamps(structuredClone(recorded.response) ?? {}),
            stream: streamFrom(recorded.stream ?? []),
          }
        : reviveTimestamps(structuredClone(recorded.response));
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
      const effect: RecordedToolCall = { kind: "tool", name, step: modelCalls, input };
      effects.push(effect);
      if (replay && options.tools !== "live") {
        const recorded = replay.find(
          (candidate): candidate is RecordedToolCall =>
            candidate.kind === "tool" &&
            !usedTools.has(candidate) &&
            candidate.step === effect.step &&
            candidate.name === name &&
            jsonEqual(candidate.input, input),
        );
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
              `Tool '${name}' was called with ${JSON.stringify(input)} ${effect.step === 0 ? "before any model call" : `after model call #${effect.step - 1}`}; the recorded run made no such call.`,
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
    }) as unknown as TFn;
  }

  return {
    model(model) {
      const base = model as unknown as Record<string, unknown>;
      const wrapped = Object.create(base) as Record<string, unknown>;
      wrapped["doGenerate"] = (callOptions: unknown) =>
        modelCall("ai-sdk", "doGenerate", callOptions, false, () =>
          (base["doGenerate"] as (o: unknown) => Promise<unknown>).call(base, callOptions),
        );
      wrapped["doStream"] = (callOptions: unknown) =>
        modelCall("ai-sdk", "doStream", callOptions, true, () =>
          (base["doStream"] as (o: unknown) => Promise<unknown>).call(base, callOptions),
        );
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
            return (params: { stream?: boolean }, requestOptions?: unknown) =>
              modelCall("openai", method, params, params?.stream === true, async () =>
                (Reflect.get(target, "create") as (p: unknown, o?: unknown) => unknown).call(
                  target,
                  params,
                  requestOptions,
                ),
              );
          },
        });
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
  | "model-call-shape"
  | "tool-name"
  | "tool-input"
  | "tool-result"
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
   * differ on every run (generated ids, timestamps) or project a tool's input
   * to the fields that matter.
   */
  normalize?: (effect: RecordedEffect) => RecordedEffect;
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

/** Offered tool names and the response format: what a recorded answer depends on. */
function modelCallShape(effect: RecordedModelCall): unknown {
  const request = (effect.request ?? {}) as Record<string, unknown>;
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
 * Puts each run of tool calls between two model calls in a stable order, so
 * parallel tool calls that finished in a different order still compare equal.
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
    if (effect.kind === "tool") {
      batch.push(effect);
    } else {
      flush();
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
    return modelCallsMatch(options.modelCalls, left, right)
      ? undefined
      : { reason: "model-call-shape", message: shapeMessage(left, right) };
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
    if (!jsonEqual(left.output, right.output) || !jsonEqual(left.error, right.error)) {
      return { reason: "tool-result", message: `Tool '${left.name}' returned a different result.` };
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
  const map = options.normalize ?? ((effect: RecordedEffect) => effect);
  const a = normalize(expected.effects.map(map));
  const b = normalize(actual.effects.map(map));
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
          reason: "missing-effect",
          expected: left,
          message: `The port never made ${describe(left)}.`,
        });
        continue;
      }
      const right = b[unpairedRights.splice(k, 1)[0]!]!;
      const difference = differ(left, right, options);
      if (difference) changed.push({ index, expected: left, actual: right, ...difference });
    }
    // An extra effect comes first: it is usually the cause of what follows.
    for (const j of unpairedRights) {
      divergences.push({
        index: lefts[0] ?? at,
        reason: "extra-effect",
        actual: b[j],
        message: `The port made ${describe(b[j]!)}, which the original never made.`,
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
