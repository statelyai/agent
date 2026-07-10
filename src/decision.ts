import {
  createAsyncLogic,
  type AnyActorRef,
  type AsyncActorLogic,
  type EnqueueObject,
  type EventObject,
} from "xstate";
import type {
  AgentMessage,
  AllowedEvents,
  ChosenEvent,
  InferOutput,
  StandardSchemaV1,
} from "./types.js";
import { validateSchemaSync } from "./utils.js";
import {
  DECIDE_ACTOR,
  PLAN_ACTOR,
  resolveTextLogicValue,
  type ResolveTextLogicValue,
} from "./text-logic.js";
import { isEventPattern, sanitizeEventToolName, type AgentEventDescriptor } from "./events.js";
import { executorBoundLogics } from "./internal/registry.js";

/**
 * Inline input for the `agent.decide` builtin actor — the zero-config
 * counterpart to {@link createDecisionLogic}, invoked directly from a
 * state's `invoke.input` (typed against the machine's own event schemas).
 * See {@link AgentDecisionRequest} for the request shape this lowers to.
 */
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
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  metadata?: TMetadata;
}

// Lowers `agent.decide` inline input into an AgentDecisionRequest (id filled in by the caller).
// Wildcard entries are dropped here: they can only expand against a live snapshot, which
// snapshot-aware hosts do via getAcceptedEvents (overwriting `events` wholesale).
function decideRequestFromInput(input: AgentDecisionInput): AgentDecisionRequest {
  const allowedEventTypes = resolveAllowedEventTypes(input.allowedEvents, input) ?? [];

  return {
    kind: "decision",
    id: "",
    model: input.model,
    system: input.system,
    prompt: input.prompt,
    messages: input.messages,
    events: allowedEventTypes
      .filter((type) => !isEventPattern(type))
      .map((type) => ({
        type,
        toolName: sanitizeEventToolName(type),
      })),
    attempts: [],
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
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
  execute?: AgentDecisionExecutor,
): DecisionLogic<StandardSchemaV1<AgentDecisionInput>> {
  const logic = createAsyncLogic<ChosenEvent, AgentDecisionInput>({
    run: async ({ input, signal }) => {
      if (!execute) {
        throw new Error(
          `'${DECIDE_ACTOR}' has no host execution. Provide an implementation with ` +
            `machine.provide({ actorSources: { '${DECIDE_ACTOR}': ... } }) or resolve ` +
            `the returned agent request with resolveDecision(...).`,
        );
      }

      // See the analogous check in createDecisionLogic's run: omitted
      // allowedEvents means "all currently-legal events," unknowable
      // without a snapshot-aware host.
      const resolvedEventTypes = resolveAllowedEventTypes(input.allowedEvents, input);
      if (resolvedEventTypes === undefined) {
        throw new Error(
          `'${DECIDE_ACTOR}' input has omitted \`allowedEvents\`, which means "all ` +
            'currently-legal events" — but that requires a snapshot-aware host (runAgent ' +
            "or the step path) to resolve. Under a bare createActor(...), declare " +
            "`allowedEvents` explicitly to use this actor here.",
        );
      }
      if (resolvedEventTypes.some(isEventPattern)) {
        throw new Error(
          `'${DECIDE_ACTOR}' input uses wildcard \`allowedEvents\` patterns, which expand ` +
            "against the live snapshot — that requires a snapshot-aware host (runAgent " +
            "or the step path). Under a bare createActor(...), list event types explicitly.",
        );
      }

      return resolveDecision(decideRequestFromInput(input), execute, {
        maxRetries: input.maxRetries ?? 2,
        signal,
      });
    },
  });

  return Object.assign(logic, {
    kind: "statelyai.decisionLogic" as const,
    maxRetries: 2,
    request: decideRequestFromInput,
    // Internal: see the analogous field in createDecisionLogic's return.
    allowedEventTypes: (input: AgentDecisionInput) =>
      resolveAllowedEventTypes(input.allowedEvents, input),
    withExecutor: (nextExecute: AgentDecisionExecutor) => decideActorWithExecutor(nextExecute),
  }) as DecisionLogic<StandardSchemaV1<AgentDecisionInput>>;
}

// Builds the unbound `agent.decide` builtin actor logic registered by setupAgent.
export function createDecideActor(): DecisionLogic<StandardSchemaV1<AgentDecisionInput>> {
  return decideActorWithExecutor();
}

// ─── Plan (multi-event decision) ───

/**
 * Inline input for the `agent.plan` builtin actor — a multi-event decision.
 * Where `agent.decide` picks exactly one currently-legal event, `agent.plan`
 * applies an ordered sequence of them: each step re-reads the live snapshot,
 * asks the `decide` executor for one legal event (same validation and
 * `rejected-by-guard` retry loop as a decision), sends it to the machine,
 * and repeats until a `stopOn` event is chosen, `maxSteps` is reached, no
 * legal candidate remains, or an applied event exits the invoking state
 * (which cancels the invoke — the machine simply moves on).
 *
 * Requires a snapshot-aware host ({@link runAgent}); the step path does not
 * surface plan requests yet (see docs/roadmap.md).
 */
export interface AgentPlanInput<
  TEvent extends string = string,
  TMetadata = Record<string, unknown>,
  TModel extends string = string,
> extends AgentDecisionInput<TEvent, TMetadata, TModel> {
  /** Maximum events applied in one plan. Default 8. */
  maxSteps?: number;
  /**
   * Machine events that end the plan once chosen: the event is still
   * validated and sent, then the loop stops. Usually unnecessary — every
   * plan step already offers the built-in {@link PLAN_DONE_EVENT_TYPE}
   * "done" option, which ends the plan without touching the machine.
   * Declare `stopOn` only for "send this real event AND stop" semantics.
   */
  stopOn?: readonly TEvent[];
}

/**
 * Reserved event type the `agent.plan` builtin adds to every step's
 * candidates as the explicit "no further action needed" move. Choosing it
 * ends the plan (`stopped: 'done'`); it is never sent to the machine, so
 * machines need no no-op sentinel event of their own.
 */
export const PLAN_DONE_EVENT_TYPE = "agent.plan.done" as const;

/** What an `agent.plan` invoke resolves with (its `onDone` output). */
export interface AgentPlanOutput {
  /** The events applied, in order (possibly empty). */
  steps: ChosenEvent[];
  /** Why the loop ended. */
  stopped: "done" | "stop-event" | "max-steps" | "no-legal-events";
}

/**
 * Actor logic for the `agent.plan` builtin. Like the unbound `agent.decide`
 * placeholder, the registered logic cannot run by itself: applying events
 * mid-invoke needs a live parent actor, which only a snapshot-aware host
 * (`runAgent`) has. runAgent swaps this placeholder for its own
 * implementation at bind time.
 */
export interface PlanLogic<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1<AgentPlanInput>,
> extends AsyncActorLogic<AgentPlanOutput, InferOutput<TInputSchema>> {
  readonly kind: "statelyai.planLogic";
  readonly maxRetries: number;
  /** Builds the per-step base {@link AgentDecisionRequest} (id/events filled in per step). */
  request(input: InferOutput<TInputSchema>): AgentDecisionRequest;
  /** @internal Resolves declared `allowedEvents` (undefined = all currently legal). */
  allowedEventTypes(input: InferOutput<TInputSchema>): readonly string[] | undefined;
}

// Builds the unbound `agent.plan` builtin actor logic registered by setupAgent.
export function createPlanActor(): PlanLogic {
  const logic = createAsyncLogic<AgentPlanOutput, AgentPlanInput>({
    run: async () => {
      throw new Error(
        `'${PLAN_ACTOR}' requires a snapshot-aware host: it applies events to the ` +
          `live machine between model calls. Run the machine with runAgent(...) ` +
          `(with a 'decide' executor), or provide a custom implementation with ` +
          `machine.provide({ actorSources: { '${PLAN_ACTOR}': ... } }).`,
      );
    },
  });

  return Object.assign(logic, {
    kind: "statelyai.planLogic" as const,
    maxRetries: 2,
    request: decideRequestFromInput,
    allowedEventTypes: (input: AgentPlanInput) =>
      resolveAllowedEventTypes(input.allowedEvents, input),
  }) as PlanLogic;
}

/** Type guard: true for the `agent.plan` builtin logic (checks the `kind` marker). @internal */
export function isPlanLogic(logic: unknown): logic is PlanLogic {
  return !!logic && (logic as { kind?: unknown }).kind === "statelyai.planLogic";
}

// ─── Decision logic ───

/**
 * Config for {@link createDecisionLogic}: how to build an
 * {@link AgentDecisionRequest} from typed input. Each field mirrors
 * {@link TextLogicConfig} (static value or a `({ input }) => value`
 * resolver), plus `allowedEvents` to narrow the candidate event set (see
 * {@link AllowedEvents}) and `maxRetries` for {@link resolveDecision}.
 */
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
  messages?: ResolveTextLogicValue<AgentMessage[] | undefined, InferOutput<TInputSchema>>;
  allowedEvents?: AllowedEvents<TEvent, InferOutput<TInputSchema>>;
  maxRetries?: number; // default 2
  temperature?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  maxOutputTokens?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  topP?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  topK?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  seed?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  stopSequences?: ResolveTextLogicValue<string[] | undefined, InferOutput<TInputSchema>>;
  metadata?: ResolveTextLogicValue<TMetadata | undefined, InferOutput<TInputSchema>>;
}

/**
 * Actor logic for a decision: an async effect that resolves to exactly one
 * currently-legal {@link ChosenEvent} (never a plain value) and is meant to
 * be raised into the machine — see {@link sendDecision}. Built by
 * {@link createDecisionLogic}. Register it under `actorSources:` to reuse/export/
 * test it standalone; for a state-local, zero-config decision, use the
 * `agent.decide` builtin invoke instead.
 */
export interface DecisionLogic<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends AsyncActorLogic<ChosenEvent, InferOutput<TInputSchema>> {
  readonly kind: "statelyai.decisionLogic";
  readonly maxRetries: number;
  request(input: InferOutput<TInputSchema>): AgentDecisionRequest;
  withExecutor(execute: AgentDecisionExecutor): DecisionLogic<TInputSchema, TMetadata>;
}

// Resolves a declared `AllowedEvents` (single entry, array, or resolver) to a concrete
// list of types/patterns; undefined means "all legal events."
function resolveAllowedEventTypes(
  allowedEvents: AllowedEvents | undefined,
  input: unknown,
): readonly string[] | undefined {
  if (allowedEvents === undefined) {
    return undefined;
  }
  const resolved = typeof allowedEvents === "function" ? allowedEvents({ input }) : allowedEvents;
  return typeof resolved === "string" ? [resolved] : resolved;
}

/**
 * Creates reusable, standalone {@link DecisionLogic}: an actor that, when
 * run, resolves to exactly one currently-legal {@link ChosenEvent} by
 * calling the host `decide` executor (passed here as `execute`, or supplied
 * later via {@link DecisionLogic.withExecutor}, `machine.provide(...)`, or
 * `runAgent`'s `decide` option). Register the result under `actorSources:` and
 * invoke it by name; for a one-off, state-local decision, prefer the
 * `agent.decide` builtin invoke instead — it needs no separate declaration
 * and types `allowedEvents` against the machine's own event schemas.
 *
 * @example
 * ```ts
 * export const chooseMove = createDecisionLogic({
 *   schemas: { input: z.object({ playerHp: z.number(), enemyHp: z.number() }) },
 *   model: 'openai/gpt-5.4-mini',
 *   system: 'You are playing a turn-based game. Choose exactly one legal move.',
 *   prompt: ({ input }) => `Player HP: ${input.playerHp}\nEnemy HP: ${input.enemyHp}`,
 *   allowedEvents: ({ input }) =>
 *     input.playerHp <= 6
 *       ? ['ATTACK', 'DEFEND', 'HEAL', 'FLEE']
 *       : ['ATTACK', 'DEFEND', 'FLEE'],
 * });
 * ```
 *
 * @internal Not part of the public API (not exported from the package root).
 * State-local decisions use the `agent.decide` builtin invoke
 * (`src: 'agent.decide'`); this backs standalone/reusable decision tests.
 */
export function createDecisionLogic<
  TInputSchema extends StandardSchemaV1,
  TEvent extends string = string,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
  TModel extends string = string,
>(
  config: DecisionLogicConfig<TInputSchema, TEvent, TMetadata, TModel>,
  execute?: AgentDecisionExecutor,
): DecisionLogic<TInputSchema, TMetadata> {
  type TInput = InferOutput<TInputSchema>;
  const maxRetries = config.maxRetries ?? 2;

  const request = (input: TInput): AgentDecisionRequest => {
    const parsedInput = config.schemas
      ? validateSchemaSync<TInput>(config.schemas.input as StandardSchemaV1<TInput>, input)
      : input;
    const args = { input: parsedInput };

    const allowedEventTypes = resolveAllowedEventTypes(
      config.allowedEvents as AllowedEvents | undefined,
      parsedInput,
    );

    return {
      kind: "decision",
      id: "",
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
      maxOutputTokens: resolveTextLogicValue(config.maxOutputTokens, args),
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
          "Decision logic has no host execution. Pass an executor as the second " +
            "argument to createDecisionLogic(...), provide a runtime adapter, or " +
            "extract it with getAgentRequests(..., { actorSources }) and resolveDecision(...).",
        );
      }

      // Bare createActor path: no snapshot to intersect with, so only
      // modes 1-2 (type + payload validation) apply here — no canTake.
      // Omitted allowedEvents means "all currently-legal events," but with
      // no snapshot that set is unknowable here — fail fast instead of
      // silently resolving to an empty candidate list (guaranteed
      // DecisionExhaustedError).
      if (
        resolveAllowedEventTypes(config.allowedEvents as AllowedEvents | undefined, input) ===
        undefined
      ) {
        throw new Error(
          'Decision logic has omitted `allowedEvents`, which means "all currently-legal ' +
            'events" — but that requires a snapshot-aware host (runAgent or the step ' +
            "path) to resolve. Under a bare createActor(...), declare `allowedEvents` " +
            "explicitly on this logic to use it here.",
        );
      }
      if (
        resolveAllowedEventTypes(config.allowedEvents as AllowedEvents | undefined, input)?.some(
          isEventPattern,
        )
      ) {
        throw new Error(
          "Decision logic uses wildcard `allowedEvents` patterns, which expand against " +
            "the live snapshot — that requires a snapshot-aware host (runAgent or the " +
            "step path). Under a bare createActor(...), list event types explicitly.",
        );
      }

      return resolveDecision(request(input), execute, { maxRetries, signal });
    },
  });

  const decisionLogic = Object.assign(logic, {
    kind: "statelyai.decisionLogic" as const,
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

/** Type guard: true for any actor logic built by createDecisionLogic/createDecideActor (checks the `kind` marker). @internal */
export function isDecisionLogic(value: unknown): value is DecisionLogic {
  return (
    !!value &&
    typeof value === "object" &&
    (value as DecisionLogic).kind === "statelyai.decisionLogic" &&
    typeof (value as DecisionLogic).request === "function"
  );
}

/**
 * A decision request: resolves to exactly one currently-legal event. See
 * `resolveDecision`.
 */
export interface AgentDecisionRequest {
  kind: "decision";
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
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * A single failed decision attempt, recorded by {@link resolveDecision} and
 * fed back to the executor on the next attempt via
 * `request.attempts`. `failure` names which of the three checks rejected the
 * choice: `'unknown-event'` (not among the candidate `events`),
 * `'invalid-payload'` (failed the event's schema), or `'rejected-by-guard'`
 * (failed the `canTake` check — type/payload were legal, but the machine's
 * guard rejected it at apply time).
 */
export interface DecisionAttempt {
  event?: ChosenEvent;
  failure: "unknown-event" | "invalid-payload" | "rejected-by-guard";
  reason: string;
}

/**
 * Thrown by {@link resolveDecision} when every attempt (up to
 * `maxRetries + 1` of them) fails one of the three checks recorded in
 * {@link DecisionAttempt.failure}. Carries the full `attempts` list for
 * diagnostics; a machine typically routes this via the decision invoke's
 * `onError`.
 */
export class DecisionExhaustedError extends Error {
  attempts: DecisionAttempt[];

  constructor(attempts: DecisionAttempt[]) {
    super(
      `Decision exhausted after ${attempts.length} attempt${attempts.length === 1 ? "" : "s"}: ` +
        attempts.map((attempt) => attempt.reason).join("; "),
    );
    this.name = "DecisionExhaustedError";
    this.attempts = attempts;
  }
}

/**
 * Host implementation of "make the model choose one of `request.events`."
 * Third executor slot on {@link AgentRequestExecutors}, symmetric with
 * `generateText`/`streamText` — how the model is coerced into choosing
 * (tool-per-event + forced tool choice, structured output, …) is entirely
 * adapter business; core only validates and retries the returned choice (see
 * {@link resolveDecision}). The optional `reason` is carried through to
 * `onResult`/event-sourcing but never affects validation. Like text
 * executors' `{ output, ...extras }` envelope, any extra keys (usage, finish
 * reason, …) flow untouched to `onResult`'s `raw`.
 */
export type AgentDecisionExecutor = (
  request: AgentDecisionRequest,
) => PromiseLike<{ event: ChosenEvent; reason?: string; [key: string]: unknown }>;

/**
 * Options for {@link resolveDecision}. The `TEvent` parameter (the machine's
 * event union, defaulting to the loose {@link ChosenEvent}) types both
 * `canTake`'s argument and {@link resolveDecision}'s return — pass it (or let
 * it infer from `canTake`) to get a machine-typed chosen event out without a
 * downstream cast.
 */
export interface ResolveDecisionOptions<TEvent extends ChosenEvent = ChosenEvent> {
  /** Retries after a failed attempt. Default `2`, so up to 3 attempts total. */
  maxRetries?: number;
  /** Checked before each attempt; aborting rejects the pending decision. */
  signal?: AbortSignal;
  /**
   * Guard-legality check (mode 3), typically `(e) => snapshot.can(e)`. A
   * type-and-payload-valid event that this rejects records a
   * `'rejected-by-guard'` attempt and retries. Omit to skip guard checking
   * (type + payload validation only — e.g. under bare `createActor`, where
   * no snapshot is reachable). Typing its argument as the machine's event
   * union (e.g. `(e: GameEvent) => snapshot.can(e)`) makes
   * {@link resolveDecision} return that union.
   */
  canTake?: (event: TEvent) => boolean;
}

/**
 * Validation + retry core for decisions. No provider mechanics — the
 * `executor` is responsible for making the model choose an event; this
 * function only validates the choice and retries on failure, up to
 * `options.maxRetries` (default 2, i.e. up to 3 attempts total).
 *
 * Each attempt is checked in order and can fail one of three ways (recorded
 * as a {@link DecisionAttempt}): `'unknown-event'` (the chosen `type` is not
 * among `request.events`), `'invalid-payload'` (the payload fails that
 * event's schema), or `'rejected-by-guard'` (passes both checks but
 * `options.canTake` returns `false` — a type/payload-legal event the
 * machine's guard rejects right now; omit `canTake` to skip this check).
 * Every prior failed attempt for this call is fed back to the executor on
 * the next attempt via `request.attempts`, so an adapter can render "your
 * last choice failed because X — try again" into the next model call; core
 * never rewrites the request itself. Exhausting all attempts throws
 * {@link DecisionExhaustedError} with the full attempts list.
 *
 * @example
 * ```ts
 * const event = await resolveDecision(request, decide, {
 *   canTake: (e) => snapshot.can(e),
 * });
 * ```
 */
export async function resolveDecision<TEvent extends ChosenEvent = ChosenEvent>(
  request: AgentDecisionRequest,
  executor: AgentDecisionExecutor,
  options: ResolveDecisionOptions<TEvent> = {},
): Promise<TEvent> {
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
        failure: "unknown-event",
        reason: `'${event.type}' is not among the currently allowed events: ${
          request.events.map((candidate) => candidate.type).join(", ") || "(none)"
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
          failure: "invalid-payload",
          reason: `'${event.type}' payload failed validation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }
    }

    if (options.canTake?.(validatedEvent as TEvent) === false) {
      attempts.push({
        event: validatedEvent,
        failure: "rejected-by-guard",
        reason: `'${validatedEvent.type}' is not currently takeable (guard rejected it).`,
      });
      continue;
    }

    return validatedEvent as TEvent;
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
 *
 * @example
 * ```ts
 * deciding: {
 *   invoke: {
 *     src: 'agent.decide',
 *     input: ({ context }) => ({ model: 'quick', allowedEvents: ['ASK', 'GUESS'] }),
 *     onDone: sendDecision(),
 *     onError: { target: 'stumped' },
 *   },
 *   on: {
 *     ASK: ({ event }) => ({ target: 'awaitingAnswer' }),
 *     GUESS: ({ event }) => ({ target: 'awaitingGuessFeedback' }),
 *   },
 * }
 * ```
 */
export function sendDecision<
  TEvent extends EventObject = EventObject,
  TEmitted extends EventObject = EventObject,
>(): (
  args: { output: ChosenEvent; self: AnyActorRef },
  enq: EnqueueObject<TEvent, TEmitted>,
) => void {
  return ({ output, self }, enq) => {
    enq.sendTo(self, output as TEvent);
  };
}
