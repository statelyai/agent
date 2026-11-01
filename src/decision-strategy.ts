import type {
  AgentDecisionExecutor,
  AgentDecisionOption,
  AgentDecisionRequest,
  AgentExecutorDecisionRequest,
} from "./decision.js";
import { AgentError } from "./errors.js";
import { sanitizeEventToolName, type AgentEventDescriptor } from "./events.js";
import { isRecord } from "./internal/is-record.js";
import type { AgentRequestExecutor, AgentRequestExecutorInfo } from "./text-logic.js";
import type { ChosenEvent } from "./types.js";
import { getJsonSchemaSync, userMessage } from "./utils.js";

/**
 * How a decision is split into model calls:
 * - `'direct'`: one decide call over every candidate event.
 * - `'pick-then-fill'`: pick the event type first (a closed choice over bare
 *   `{ type }` options), then fill its payload: nothing to fill, a second
 *   closed choice over the enumerated payloads when every field is finite,
 *   else a structured `generateText` call with `fillModel`.
 * - `'grouped'`: pick a group of event types, then decide within it.
 * - `'auto'` (default): `'pick-then-fill'` with a `fillModel`; `'grouped'` over
 *   more than {@link GROUPED_EVENT_THRESHOLD} events in at least two groups;
 *   else `'direct'`.
 */
export type DecisionStrategy = "direct" | "pick-then-fill" | "grouped" | "auto";

/** Above this many candidate events, `'auto'` groups them (when two groups or more exist). */
export const GROUPED_EVENT_THRESHOLD = 24;

/** The most payloads a finite payload schema may enumerate to be filled by a closed choice. */
export const MAX_FINITE_PAYLOADS = 32;

/** The strategy `'auto'` resolves to for this request. @internal */
export function resolveDecisionStrategy(
  request: Pick<AgentDecisionRequest, "strategy" | "fillModel" | "groups" | "events" | "options">,
): Exclude<DecisionStrategy, "auto"> {
  const strategy = request.strategy ?? "auto";
  if (strategy !== "auto") return strategy;
  if (request.fillModel !== undefined) return "pick-then-fill";
  if (
    candidateTypes(request).length > GROUPED_EVENT_THRESHOLD &&
    decisionGroups(request).length >= 2
  ) {
    return "grouped";
  }
  return "direct";
}

/**
 * Every payload a JSON Schema allows, when each required field is finite (an
 * `enum`, a `const`, a boolean, or a union of those) and they number at most
 * {@link MAX_FINITE_PAYLOADS}. Optional fields are left out when finite; an
 * optional open field makes the schema open. `undefined` when open. @internal
 */
export function enumerateFinitePayloads(
  jsonSchema: Record<string, unknown> | undefined,
): Record<string, unknown>[] | undefined {
  if (!jsonSchema) return undefined;
  const union = jsonSchema.anyOf ?? jsonSchema.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    const variants = union.map((variant) =>
      isRecord(variant) ? enumerateFinitePayloads(variant) : undefined,
    );
    if (variants.some((variant) => variant === undefined)) return undefined;
    const payloads = variants.flatMap((variant) => variant ?? []);
    return payloads.length <= MAX_FINITE_PAYLOADS ? payloads : undefined;
  }
  if (
    jsonSchema.allOf !== undefined ||
    (jsonSchema.type !== undefined && jsonSchema.type !== "object") ||
    (jsonSchema.type !== "object" && !isRecord(jsonSchema.properties))
  ) {
    return undefined;
  }
  const properties = isRecord(jsonSchema.properties) ? jsonSchema.properties : {};
  const required = new Set(Array.isArray(jsonSchema.required) ? jsonSchema.required : []);
  let payloads: Record<string, unknown>[] = [{}];
  for (const [key, property] of Object.entries(properties)) {
    const values = finiteValues(property);
    if (values === undefined) return undefined;
    if (!required.has(key)) continue;
    if (payloads.length * values.length > MAX_FINITE_PAYLOADS) return undefined;
    payloads = payloads.flatMap((payload) => values.map((value) => ({ ...payload, [key]: value })));
  }
  return payloads;
}

function finiteValues(schema: unknown): unknown[] | undefined {
  if (!isRecord(schema)) return undefined;
  if ("const" in schema) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum;
  if (schema.type === "boolean") return [true, false];
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    const values = union.map(finiteValues);
    return values.every((value) => value !== undefined) ? values.flat() : undefined;
  }
  return undefined;
}

/**
 * Whether an event's payload needs an open fill (a `fillModel`): it has a
 * schema with fields, and they are not finite. @internal
 */
export function payloadNeedsFillModel(jsonSchema: Record<string, unknown> | undefined): boolean {
  if (!jsonSchema) return false;
  return enumerateFinitePayloads(jsonSchema) === undefined;
}

// Candidate event types in order: the closed choice's option types, else the events.
function candidateTypes(request: Pick<AgentDecisionRequest, "events" | "options">): string[] {
  const types = request.options
    ? request.options.map((option) => option.event.type)
    : request.events.map((event) => event.type);
  return [...new Set(types)];
}

/**
 * The non-empty groups over the request's candidate types: the explicit
 * `groups` (members not among the candidates dropped), then every remaining
 * type grouped by its prefix before the first `.`. @internal
 */
export function decisionGroups(
  request: Pick<AgentDecisionRequest, "groups" | "events" | "options">,
): Array<{ name: string; types: string[] }> {
  const types = candidateTypes(request);
  const groups = new Map<string, string[]>();
  const grouped = new Set<string>();
  for (const [name, members] of Object.entries(request.groups ?? {})) {
    const present = types.filter((type) => members.includes(type) && !grouped.has(type));
    for (const type of present) grouped.add(type);
    if (present.length) groups.set(name, present);
  }
  for (const type of types) {
    if (grouped.has(type)) continue;
    const name = type.includes(".") ? type.slice(0, type.indexOf(".")) : type;
    groups.set(name, [...(groups.get(name) ?? []), type]);
  }
  return [...groups].map(([name, members]) => ({ name, types: members }));
}

// Sub-call info: the attempt key suffixed with the sub-call's role.
function subInfo(
  info: AgentRequestExecutorInfo | undefined,
  role: "pick" | "group" | "fill",
): AgentRequestExecutorInfo {
  return {
    ...info,
    ...(info?.callKey !== undefined ? { callKey: `${info.callKey}.${role}` } : {}),
  };
}

// A closed choice over bare names. `events` are descriptors without schemas,
// so tool-mode adapters offer each as an empty-payload tool.
function choiceRequest(
  request: AgentExecutorDecisionRequest,
  choices: Array<{ name: string; description?: string }>,
): AgentExecutorDecisionRequest {
  const { withheld: _withheld, ...rest } = request;
  return {
    ...rest,
    events: choices.map(({ name }) => ({ type: name, toolName: sanitizeEventToolName(name) })),
    options: choices.map(({ name, description }) => ({
      event: { type: name },
      ...(description !== undefined ? { description } : {}),
    })),
  };
}

// The request narrowed to these event types (and their options).
function narrowRequest(
  request: AgentExecutorDecisionRequest,
  types: readonly string[],
): AgentExecutorDecisionRequest {
  return {
    ...request,
    events: request.events.filter((event) => types.includes(event.type)),
    ...(request.options
      ? { options: request.options.filter((option) => types.includes(option.event.type)) }
      : {}),
  };
}

type DecisionAnswer = Awaited<ReturnType<AgentDecisionExecutor>>;

/** Executors {@link withDecisionStrategy} composes: `generateText` fills open payloads. */
export interface DecisionStrategyExecutors {
  decide: AgentDecisionExecutor;
  generateText?: AgentRequestExecutor;
}

/**
 * Wraps a decide executor so one call answers the request with its strategy
 * (see {@link DecisionStrategy}): it makes the strategy's sub-calls and returns
 * ONE `{ event }` or `{ rejected }`, which `resolveDecision` validates and
 * retries like any answer. Every sub-call gets the request's `attempts`, and
 * `info.callKey` suffixed with `.pick`, `.group`, or `.fill`. `'direct'`
 * returns `executors.decide` itself. @internal
 */
export function withDecisionStrategy(
  request: Pick<AgentDecisionRequest, "strategy" | "fillModel" | "groups" | "events" | "options">,
  executors: DecisionStrategyExecutors,
): AgentDecisionExecutor {
  const strategy = resolveDecisionStrategy(request);
  if (strategy === "direct") return executors.decide;
  return strategy === "grouped" ? groupedDecide(executors) : pickThenFillDecide(executors);
}

function groupedDecide({ decide }: DecisionStrategyExecutors): AgentDecisionExecutor {
  return async (request, info) => {
    const groups = decisionGroups(request);
    if (groups.length < 2) return decide(request, info);
    const picked = await decide(
      choiceRequest(
        request,
        groups.map(({ name, types }) => ({ name, description: `One of: ${types.join(", ")}` })),
      ),
      subInfo(info, "group"),
    );
    if (picked.rejected) return picked;
    const group = groups.find(({ name }) => name === picked.event.type);
    if (!group) {
      return {
        rejected: {
          failure: "unknown-event",
          reason: `'${picked.event.type}' is not a group: ${groups.map(({ name }) => name).join(", ")}.`,
        },
      };
    }
    return decide(narrowRequest(request, group.types), subInfo(info, "pick"));
  };
}

function pickThenFillDecide(executors: DecisionStrategyExecutors): AgentDecisionExecutor {
  return async (request, info) => {
    const types = candidateTypes(request);
    const descriptions = new Map(
      (request.options ?? [])
        .filter((option) => Object.keys(option.event).length === 1 && option.description)
        .map((option) => [option.event.type, option.description!]),
    );
    let type: string;
    if (types.length === 1) {
      type = types[0]!;
    } else {
      const picked = await executors.decide(
        choiceRequest(
          request,
          types.map((name) => ({ name, description: descriptions.get(name) })),
        ),
        subInfo(info, "pick"),
      );
      if (picked.rejected) return picked;
      if (!types.includes(picked.event.type)) {
        return {
          rejected: {
            failure: "unknown-event",
            reason: `'${picked.event.type}' is not among the currently allowed events: ${types.join(", ")}.`,
            event: picked.event,
          },
        };
      }
      type = picked.event.type;
    }
    return fill(request, type, executors, info);
  };
}

async function fill(
  request: AgentExecutorDecisionRequest,
  type: string,
  { decide, generateText }: DecisionStrategyExecutors,
  info: AgentRequestExecutorInfo | undefined,
): Promise<DecisionAnswer> {
  const narrowed = narrowRequest(request, [type]);
  const descriptor = narrowed.events[0];
  // A closed choice already enumerated this type's payloads.
  let options: AgentDecisionOption[] | undefined = narrowed.options;
  if (!options) {
    // A schema without a JSON Schema cannot be enumerated: fill it as open.
    const payloads = descriptor?.inputSchema
      ? enumerateFinitePayloads(getJsonSchemaSync(descriptor.inputSchema))
      : [{}];
    if (payloads) options = payloads.map((payload) => ({ event: { ...payload, type } }));
  }
  if (options) {
    if (options.length === 1) return { event: options[0]!.event };
    return decide({ ...narrowed, options }, subInfo(info, "fill"));
  }
  return fillWithModel(narrowed, descriptor!, generateText, info);
}

async function fillWithModel(
  request: AgentExecutorDecisionRequest,
  descriptor: AgentEventDescriptor,
  generateText: AgentRequestExecutor | undefined,
  info: AgentRequestExecutorInfo | undefined,
): Promise<DecisionAnswer> {
  if (request.fillModel === undefined) {
    throw new AgentError(
      "missing-fill-model",
      `Decision '${request.name}' uses strategy 'pick-then-fill', but '${descriptor.type}' has ` +
        "open payload fields and no `fillModel` is set to fill them. Set `fillModel`, " +
        "enumerate the payloads with `payloads`, or use strategy 'direct'.",
    );
  }
  if (!generateText) {
    throw new AgentError(
      "missing-fill-executor",
      `Decision '${request.name}' fills '${descriptor.type}' with fillModel ` +
        `'${request.fillModel}', which needs a 'generateText' executor; none was provided.`,
    );
  }
  const instruction = `You chose '${descriptor.type}'. Write its payload.`;
  const feedback = request.attempts.map((attempt) =>
    userMessage(`Your previous choice failed: ${attempt.reason}`),
  );
  const raw = await generateText(
    {
      name: request.name,
      ...(request.input !== undefined ? { input: request.input } : {}),
      model: request.fillModel,
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.messages
        ? { messages: [...request.messages, ...feedback, userMessage(instruction)] }
        : {
            prompt: [request.prompt, ...feedback.map((message) => message.content), instruction]
              .filter((part) => part !== undefined)
              .join("\n\n"),
          }),
      outputSchema: descriptor.inputSchema,
      tools: {},
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    },
    subInfo(info, "fill"),
  );
  const payload = (raw as { result?: unknown }).result;
  if (!isRecord(payload)) {
    return {
      rejected: {
        failure: "invalid-payload",
        reason: `'${descriptor.type}' payload must be an object; got ${JSON.stringify(payload)}.`,
        event: { type: descriptor.type },
      },
    };
  }
  return { event: { ...payload, type: descriptor.type } as ChosenEvent };
}
