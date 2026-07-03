import {
  createAsyncLogic,
  type AnyActorRef,
  type AsyncActorLogic,
  type EnqueueObject,
  type EventObject,
} from 'xstate';
import type { AgentMessage, AllowedEvents, ChosenEvent, InferOutput, StandardSchemaV1 } from './types.js';
import { validateSchemaSync } from './utils.js';
import { DECIDE_ACTOR, resolveTextLogicValue, type ResolveTextLogicValue } from './text-logic.js';
import { sanitizeEventToolName, type AgentEventDescriptor } from './events.js';
import { executorBoundLogics } from './internal/registry.js';

/** Inline input for the `agent.decide` builtin actor. */
export interface AgentDecisionInput<
  TEvent extends string = string,
  TMetadata = Record<string, unknown>,
  TModel extends string = string,
> {
  model: TModel;
  system?: string;
  prompt?: string;
  messages?: AgentMessage[];
  allowedEvents?: AllowedEvents<TEvent>;
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  metadata?: TMetadata;
}

const agentDecisionInputSchema: StandardSchemaV1<AgentDecisionInput> = {
  '~standard': {
    version: 1,
    vendor: 'statelyai-agent',
    validate(value: unknown) {
      const ok =
        !!value
        && typeof value === 'object'
        && typeof (value as AgentDecisionInput).model === 'string';

      return ok
        ? { value: value as AgentDecisionInput }
        : { issues: [{ message: 'Expected agent decision input with a model' }] };
    },
  },
};

function decideRequestFromInput(input: AgentDecisionInput): AgentDecisionRequest {
  const allowedEventTypes = resolveAllowedEventTypes(input.allowedEvents, input) ?? [];

  return {
    kind: 'decision',
    id: '',
    model: input.model,
    system: input.system,
    prompt: input.prompt,
    messages: input.messages,
    events: allowedEventTypes.map((type) => ({
      type,
      toolName: sanitizeEventToolName(type),
    })),
    attempts: [],
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    topP: input.topP,
    topK: input.topK,
    seed: input.seed,
    stopSequences: input.stopSequences,
    metadata: input.metadata,
  };
}

// Placeholder DecisionLogic for the `agent.decide` builtin. Bespoke (not
// createDecisionLogic) because `maxRetries` is per-invoke inline input here,
// not a static config value.
function decideActorWithExecutor(
  execute?: AgentDecisionExecutor
): DecisionLogic<StandardSchemaV1<AgentDecisionInput>> {
  const logic = createAsyncLogic<ChosenEvent, AgentDecisionInput>({
    run: async ({ input, signal }) => {
      if (!execute) {
        throw new Error(
          `'${DECIDE_ACTOR}' has no host execution. Provide an implementation with ` +
            `machine.provide({ actorSources: { '${DECIDE_ACTOR}': ... } }) or resolve ` +
            `the returned agent request with resolveDecision(...).`
        );
      }

      // See the analogous check in createDecisionLogic's run: omitted
      // allowedEvents means "all currently-legal events," unknowable
      // without a snapshot-aware host.
      if (resolveAllowedEventTypes(input.allowedEvents, input) === undefined) {
        throw new Error(
          `'${DECIDE_ACTOR}' input has omitted \`allowedEvents\`, which means "all ` +
            'currently-legal events" — but that requires a snapshot-aware host (runAgent ' +
            'or the step path) to resolve. Under a bare createActor(...), declare ' +
            '`allowedEvents` explicitly to use this actor here.'
        );
      }

      return resolveDecision(decideRequestFromInput(input), execute, {
        maxRetries: input.maxRetries ?? 2,
        signal,
      });
    },
  });

  return Object.assign(logic, {
    kind: 'statelyai.decisionLogic' as const,
    maxRetries: 2,
    request: decideRequestFromInput,
    // Internal: see the analogous field in createDecisionLogic's return.
    allowedEventTypes: (input: AgentDecisionInput) =>
      resolveAllowedEventTypes(input.allowedEvents, input),
    withExecutor: (nextExecute: AgentDecisionExecutor) =>
      decideActorWithExecutor(nextExecute),
  }) as DecisionLogic<StandardSchemaV1<AgentDecisionInput>>;
}

export function createDecideActor(): DecisionLogic<StandardSchemaV1<AgentDecisionInput>> {
  return decideActorWithExecutor();
}

// ─── Decision logic ───

export interface DecisionLogicConfig<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TEvent extends string = string,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
  TModel extends string = string,
> {
  schemas?: { input: TInputSchema };
  model: ResolveTextLogicValue<TModel, InferOutput<TInputSchema>>;
  system?: ResolveTextLogicValue<string | undefined, InferOutput<TInputSchema>>;
  prompt?: ResolveTextLogicValue<string | undefined, InferOutput<TInputSchema>>;
  messages?: ResolveTextLogicValue<
    AgentMessage[] | undefined,
    InferOutput<TInputSchema>
  >;
  allowedEvents?: AllowedEvents<TEvent>;
  maxRetries?: number; // default 2
  temperature?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  maxTokens?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  topP?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  topK?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  seed?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  stopSequences?: ResolveTextLogicValue<
    string[] | undefined,
    InferOutput<TInputSchema>
  >;
  metadata?: ResolveTextLogicValue<TMetadata | undefined, InferOutput<TInputSchema>>;
}

export interface DecisionLogic<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends AsyncActorLogic<ChosenEvent, InferOutput<TInputSchema>> {
  readonly kind: 'statelyai.decisionLogic';
  readonly maxRetries: number;
  request(input: InferOutput<TInputSchema>): AgentDecisionRequest;
  withExecutor(execute: AgentDecisionExecutor): DecisionLogic<TInputSchema, TMetadata>;
}

function resolveAllowedEventTypes(
  allowedEvents: AllowedEvents | undefined,
  input: unknown
): readonly string[] | undefined {
  if (allowedEvents === undefined) {
    return undefined;
  }
  return typeof allowedEvents === 'function'
    ? allowedEvents({ input })
    : allowedEvents;
}

export function createDecisionLogic<
  TInputSchema extends StandardSchemaV1,
  TEvent extends string = string,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
  TModel extends string = string,
>(
  config: DecisionLogicConfig<TInputSchema, TEvent, TMetadata, TModel>,
  execute?: AgentDecisionExecutor
): DecisionLogic<TInputSchema, TMetadata> {
  type TInput = InferOutput<TInputSchema>;
  const maxRetries = config.maxRetries ?? 2;

  const request = (input: TInput): AgentDecisionRequest => {
    const parsedInput = config.schemas
      ? validateSchemaSync<TInput>(
        config.schemas.input as StandardSchemaV1<TInput>,
        input
      )
      : input;
    const args = { input: parsedInput };

    const allowedEventTypes = resolveAllowedEventTypes(
      config.allowedEvents as AllowedEvents | undefined,
      parsedInput
    );

    return {
      kind: 'decision',
      id: '',
      model: resolveTextLogicValue(config.model, args)!,
      system: resolveTextLogicValue(config.system, args),
      prompt: resolveTextLogicValue(config.prompt, args),
      messages: resolveTextLogicValue(config.messages, args),
      events: (allowedEventTypes ?? []).map((type) => ({
        type,
        toolName: sanitizeEventToolName(type),
      })),
      attempts: [],
      temperature: resolveTextLogicValue(config.temperature, args),
      maxTokens: resolveTextLogicValue(config.maxTokens, args),
      topP: resolveTextLogicValue(config.topP, args),
      topK: resolveTextLogicValue(config.topK, args),
      seed: resolveTextLogicValue(config.seed, args),
      stopSequences: resolveTextLogicValue(config.stopSequences, args),
      metadata: resolveTextLogicValue(config.metadata, args),
    };
  };

  const logic = createAsyncLogic<ChosenEvent, TInput>({
    run: async ({ input, signal }) => {
      if (!execute) {
        throw new Error(
          'Decision logic has no host execution. Pass an executor as the second ' +
            'argument to createDecisionLogic(...), provide a runtime adapter, or ' +
            'extract it with getAgentRequests(..., { actors }) and resolveDecision(...).'
        );
      }

      // Bare createActor path: no snapshot to intersect with, so only
      // modes 1-2 (type + payload validation) apply here — no canTake.
      // Omitted allowedEvents means "all currently-legal events," but with
      // no snapshot that set is unknowable here — fail fast instead of
      // silently resolving to an empty candidate list (guaranteed
      // DecisionExhaustedError).
      if (resolveAllowedEventTypes(config.allowedEvents as AllowedEvents | undefined, input) === undefined) {
        throw new Error(
          'Decision logic has omitted `allowedEvents`, which means "all currently-legal ' +
            'events" — but that requires a snapshot-aware host (runAgent or the step ' +
            'path) to resolve. Under a bare createActor(...), declare `allowedEvents` ' +
            'explicitly on this logic to use it here.'
        );
      }

      return resolveDecision(request(input), execute, { maxRetries, signal });
    },
  });

  const decisionLogic = Object.assign(logic, {
    kind: 'statelyai.decisionLogic' as const,
    maxRetries,
    request,
    // Internal: the raw declared `allowedEvents`, resolved but NOT yet
    // defaulted to `[]` — `undefined` here means "all legal events" and is
    // used by getAgentRequests to intersect with the snapshot correctly.
    // Not part of the public DecisionLogic type.
    allowedEventTypes: (input: TInput) =>
      resolveAllowedEventTypes(config.allowedEvents as AllowedEvents | undefined, input),
    withExecutor(nextExecute: AgentDecisionExecutor) {
      return createDecisionLogic(config, nextExecute);
    },
  }) as DecisionLogic<TInputSchema, TMetadata>;

  if (execute) {
    executorBoundLogics.add(decisionLogic as object);
  }

  return decisionLogic;
}

export function isDecisionLogic(value: unknown): value is DecisionLogic {
  return (
    !!value
    && typeof value === 'object'
    && (value as DecisionLogic).kind === 'statelyai.decisionLogic'
    && typeof (value as DecisionLogic).request === 'function'
  );
}

/**
 * A decision request: resolves to exactly one currently-legal event. See
 * `resolveDecision`.
 */
export interface AgentDecisionRequest {
  kind: 'decision';
  /** Durable invoke id. */
  id: string;
  model: string;
  system?: string;
  prompt?: string;
  messages?: AgentMessage[];
  /** Candidate events: declared `allowedEvents` ∩ snapshot-legal events. */
  events: AgentEventDescriptor[];
  /**
   * Prior failed attempts for THIS decision. Empty on the first attempt.
   * Adapters render these into the provider request so retries converge.
   * Core never rewrites prompts/messages — attempts are data on the request.
   */
  attempts: DecisionAttempt[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface DecisionAttempt {
  event?: ChosenEvent;
  failure: 'unknown-event' | 'invalid-payload' | 'rejected-by-guard';
  reason: string;
}

export class DecisionExhaustedError extends Error {
  attempts: DecisionAttempt[];

  constructor(attempts: DecisionAttempt[]) {
    super(
      `Decision exhausted after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}: ` +
        attempts.map((attempt) => attempt.reason).join('; ')
    );
    this.name = 'DecisionExhaustedError';
    this.attempts = attempts;
  }
}

/** Third executor slot, symmetric with generateText/streamText. */
export type AgentDecisionExecutor = (
  request: AgentDecisionRequest
) => PromiseLike<{ event: ChosenEvent; reason?: string }>;

export interface ResolveDecisionOptions {
  maxRetries?: number; // default 2 (⇒ up to 3 attempts)
  signal?: AbortSignal;
  /** Mode-3 guard check. Omit ⇒ mode-3 skipped (modes 1–2 only). */
  canTake?: (event: ChosenEvent) => boolean;
}

/**
 * Validation + retry core for decisions. No provider mechanics — the
 * `executor` is responsible for making the model choose an event; this
 * function only validates the choice and retries on failure.
 */
export async function resolveDecision(
  request: AgentDecisionRequest,
  executor: AgentDecisionExecutor,
  options: ResolveDecisionOptions = {}
): Promise<ChosenEvent> {
  const maxRetries = options.maxRetries ?? 2;
  const attempts: DecisionAttempt[] = [];
  const eventsByType = new Map(request.events.map((event) => [event.type, event]));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    options.signal?.throwIfAborted();
    const { event } = await executor({ ...request, attempts: [...attempts] });

    const descriptor = eventsByType.get(event.type);
    if (!descriptor) {
      attempts.push({
        event,
        failure: 'unknown-event',
        reason: `'${event.type}' is not among the currently allowed events: ${
          request.events.map((candidate) => candidate.type).join(', ') || '(none)'
        }.`,
      });
      continue;
    }

    let validatedEvent = event;
    if (descriptor.inputSchema) {
      const { type, ...payload } = event;
      try {
        const validatedPayload = validateSchemaSync(descriptor.inputSchema, payload);
        validatedEvent = { ...(validatedPayload as Record<string, unknown>), type };
      } catch (error) {
        attempts.push({
          event,
          failure: 'invalid-payload',
          reason: `'${event.type}' payload failed validation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }
    }

    if (options.canTake?.(validatedEvent) === false) {
      attempts.push({
        event: validatedEvent,
        failure: 'rejected-by-guard',
        reason: `'${validatedEvent.type}' is not currently takeable (guard rejected it).`,
      });
      continue;
    }

    return validatedEvent;
  }

  throw new DecisionExhaustedError(attempts);
}

/**
 * Transition-function factory for an `agent.decide` invoke's `onDone`.
 * Delivers the chosen event via `enq.sendTo(self, …)` — external and
 * observable (event-sourcing, §4.3) — rather than `enq.raise` (internal).
 *
 * v6 alpha transition functions are re-evaluated multiple times per
 * transition (spike S3: 8x) — purity is load-bearing here. This function
 * only calls `enq`, never side-effects directly, so re-evaluation is safe.
 */
export function sendDecision<
  TEvent extends EventObject = EventObject,
  TEmitted extends EventObject = EventObject,
>(): (
  args: { output: ChosenEvent; self: AnyActorRef },
  enq: EnqueueObject<TEvent, TEmitted>
) => void {
  return ({ output, self }, enq) => {
    enq.sendTo(self, output as TEvent);
  };
}
