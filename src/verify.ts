/**
 * Provider-free verification for agent machines — static lint checks plus
 * model-free simulation over the pure step path. Coding agents generate these
 * machines; this module lets them close the loop and self-verify WITHOUT any
 * API keys or model calls.
 *
 * - {@link lintAgentMachine} — static structural checks over a built machine
 *   (works for TS-authored and `setupAgent.fromConfig`-compiled machines).
 * - {@link simulateAgent} — a deterministic, scripted playthrough.
 * - {@link explorePaths} — enumerates decision/external branches to a bounded
 *   depth and reports reached states and terminal outcomes.
 * - {@link canReach} — a thin wrapper over {@link explorePaths} answering
 *   "can this state (or snapshot predicate) be reached?" with a witness path.
 *
 * @module
 */
import {
  getNextTransitions,
  machineToJSON,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type EventObject,
} from "xstate";
import type { ChosenEvent, StandardSchemaV1 } from "./types.js";
import { AgentError } from "./errors.js";
import { getAcceptedEvents, isEventPattern, type AgentSchemas } from "./events.js";
import {
  acceptedDecisionOptions,
  AgentDecisionExhaustedError,
  isDecisionLogic,
  resolveDecision,
  type AgentDecisionOption,
} from "./decision.js";
import { isRecord } from "./internal/is-record.js";
import { getJsonSchemaSync } from "./utils.js";
import { isTextLogic, type AgentTextResult } from "./text-logic.js";
import { executorBoundLogics, getRegisteredAgentExecutionOptions } from "./internal/registry.js";
import {
  getPendingInvokes,
  initialAgentStep,
  rejectAgentStep,
  resolveAgentStep,
  transitionAgentStep,
  type AgentStep,
  type AgentStepRequest,
} from "./steps.js";

// Well-known builtin invoke srcs (kept local to avoid widening the public
// surface of text-logic/decision internals).
const DECIDE_SRC = "agent.decide";
const ACT_SRC = "agent.act";

// ─── Diagnostics ───

/** Severity of an {@link AgentLintDiagnostic}. `error` findings fail CI/the CLI; `warning`s are advisory. */
export type AgentLintSeverity = "error" | "warning";

/**
 * One static-analysis finding from {@link lintAgentMachine}. `code` names the
 * check (stable, machine-readable), `path` points at the offending state path
 * or config location, and `message` explains the problem and its remedy.
 */
export interface AgentLintDiagnostic {
  code:
    | "decide-without-events"
    | "decide-allows-human-event"
    | "direct-object-src"
    | "invoke-without-on-error";
  severity: AgentLintSeverity;
  /** State path (`parent.child`) or config pointer (e.g. `(root)`, `context`) the finding is about. */
  path: string;
  message: string;
}

/** Options for {@link lintAgentMachine}. */
export interface LintAgentMachineOptions {
  /** Skip these check codes entirely. */
  disable?: AgentLintDiagnostic["code"][];
  /**
   * Throw {@link AgentLintError} on failing diagnostics instead of returning
   * them. Fails on error-severity findings; add `warnings: true` to fail on
   * warnings too.
   */
  throw?: boolean;
  /** With `throw: true`, also fail on warning-severity findings. Default: errors only. */
  warnings?: boolean;
}

// ─── State-config model ───

interface AnyConfig {
  id?: string;
  initial?: string;
  type?: string;
  states?: Record<string, AnyConfig>;
  invoke?: unknown;
  on?: Record<string, unknown>;
  always?: unknown;
  choice?: unknown;
  after?: Record<string, unknown>;
  onDone?: unknown;
  output?: unknown;
  [key: string]: unknown;
}

interface InvokeConfig {
  id?: unknown;
  src?: unknown;
  input?: unknown;
  onDone?: unknown;
  onError?: unknown;
}

interface StateNode {
  path: string;
  config: AnyConfig;
  parentPath: string;
  isFinal: boolean;
  isParallel: boolean;
  isCompound: boolean;
  invokes: InvokeConfig[];
}

function normalizeInvokes(invoke: unknown): InvokeConfig[] {
  if (invoke === undefined || invoke === null) {
    return [];
  }
  return (Array.isArray(invoke) ? invoke : [invoke]) as InvokeConfig[];
}

// Builds a flat index of every state node in a machine config, keyed by dotted path.
function buildStateIndex(rootConfig: AnyConfig): Map<string, StateNode> {
  const index = new Map<string, StateNode>();

  const walk = (states: Record<string, AnyConfig> | undefined, parentPath: string): void => {
    for (const [name, config] of Object.entries(states ?? {})) {
      const path = parentPath ? `${parentPath}.${name}` : name;
      const hasChildren = !!config.states && Object.keys(config.states).length > 0;
      index.set(path, {
        path,
        config,
        parentPath,
        isFinal: config.type === "final",
        isParallel: config.type === "parallel",
        isCompound: hasChildren && config.type !== "parallel",
        invokes: normalizeInvokes(config.invoke),
      });
      if (hasChildren) {
        walk(config.states, path);
      }
    }
  };

  walk(rootConfig.states, "");
  return index;
}

interface LintContext {
  config: AnyConfig;
  /** The machine as `machineToJSON` writes it, where invoke inputs stay data. */
  json: AnyConfig | undefined;
  index: Map<string, StateNode>;
  schemas: { context?: unknown; output?: unknown; events?: Record<string, unknown> } | undefined;
  actors: Record<string, AnyActorLogic>;
}

function ancestorChain(node: StateNode, index: Map<string, StateNode>): StateNode[] {
  const chain: StateNode[] = [];
  let parent = node.parentPath;
  while (parent) {
    const parentNode = index.get(parent);
    if (!parentNode) {
      break;
    }
    chain.push(parentNode);
    parent = parentNode.parentPath;
  }
  return chain;
}

function hasNonEmptyOn(config: AnyConfig): boolean {
  return !!config.on && Object.keys(config.on).length > 0;
}

// True when an invoke src is a decision (and so needs event handling) — by
// builtin src string or by a registered/direct-object DecisionLogic.
function isDecisionInvoke(src: unknown, actors: Record<string, AnyActorLogic>): boolean {
  if (typeof src === "string") {
    return src === DECIDE_SRC || isDecisionLogic(actors[src]);
  }
  return isDecisionLogic(src);
}

function isAgentLogicNeedingBinding(src: object): boolean {
  return (isTextLogic(src) || isDecisionLogic(src)) && !executorBoundLogics.has(src);
}

// A schema's synchronous JSON Schema, or `undefined` when it exposes none (a
// `z.custom` without the `jsonSchema` extension) or throws producing it. A
// schema with no JSON Schema cannot be statically inspected at all, so lint
// checks read this as "nothing to check".
function safeJsonSchema(schema: StandardSchemaV1): Record<string, unknown> | undefined {
  try {
    return getJsonSchemaSync(schema);
  } catch {
    return undefined;
  }
}

function checkDecideWithoutEvents(ctx: LintContext): AgentLintDiagnostic[] {
  const out: AgentLintDiagnostic[] = [];
  for (const node of ctx.index.values()) {
    for (const invoke of node.invokes) {
      if (!isDecisionInvoke(invoke.src, ctx.actors)) {
        continue;
      }
      const selfHandles = hasNonEmptyOn(node.config);
      const ancestorHandles = ancestorChain(node, ctx.index).some((ancestor) =>
        hasNonEmptyOn(ancestor.config),
      );
      // An `onDone` on the invoke can observe a chosen event whose transition
      // stays in-state, so it also counts as "the decision can deliver".
      const invokeObserves = invoke.onDone !== undefined;
      if (selfHandles || ancestorHandles || invokeObserves) {
        continue;
      }
      const srcName = typeof invoke.src === "string" ? invoke.src : "(inline logic)";
      out.push({
        code: "decide-without-events",
        severity: "error",
        path: node.path,
        message:
          `State '${node.path}' invokes decision source '${srcName}', but neither it nor ` +
          `any ancestor handles any event (no 'on:'), so the decision's chosen event can ` +
          `never be delivered. Add an 'on:' handler for the candidate events.`,
      });
    }
  }
  return out;
}

// The `allowedEvents` of a state's invoke as written: from a literal input,
// or the JSON of a fromConfig `{ "@expr" }` input. A function input has none.
function literalAllowedEvents(
  json: AnyConfig | undefined,
  path: string,
  index: number,
): unknown[] | undefined {
  let node: AnyConfig | undefined = json;
  for (const key of path.split(".")) node = node?.states?.[key];
  let input = normalizeInvokes(node?.invoke)[index]?.input;
  if (isRecord(input) && typeof input["@expr"] === "string") {
    try {
      input = JSON.parse(input["@expr"]);
    } catch {
      return undefined;
    }
  }
  const allowedEvents = isRecord(input) ? input.allowedEvents : undefined;
  return typeof allowedEvents === "string"
    ? [allowedEvents]
    : Array.isArray(allowedEvents)
      ? allowedEvents
      : undefined;
}

// True when the state handles `eventType` through a transition tagged `meta: { actor: "human" }`.
function handlesAsHuman(config: AnyConfig, eventType: string): boolean {
  const transitions = config.on?.[eventType];
  return (Array.isArray(transitions) ? transitions : [transitions]).some(
    (transition) =>
      !!transition &&
      typeof transition === "object" &&
      (transition as { meta?: { actor?: unknown } }).meta?.actor === "human",
  );
}

function checkDecideAllowsHumanEvent(ctx: LintContext): AgentLintDiagnostic[] {
  const out: AgentLintDiagnostic[] = [];
  for (const node of ctx.index.values()) {
    for (const [index, invoke] of node.invokes.entries()) {
      // `agent.act` also offers only non-human events as its tools.
      const isAct = invoke.src === ACT_SRC;
      if (!isAct && !isDecisionInvoke(invoke.src, ctx.actors)) {
        continue;
      }
      const allowedEvents = literalAllowedEvents(ctx.json, node.path, index);
      if (!allowedEvents) {
        continue;
      }
      const configs = [
        node.config,
        ...ancestorChain(node, ctx.index).map((ancestor) => ancestor.config),
        ctx.config,
      ];
      for (const type of allowedEvents) {
        if (
          typeof type !== "string" ||
          isEventPattern(type) ||
          !configs.some((config) => handlesAsHuman(config, type))
        ) {
          continue;
        }
        out.push({
          code: "decide-allows-human-event",
          severity: "error",
          path: node.path,
          message:
            `State '${node.path}' lets ${isAct ? "'agent.act'" : "a decision"} choose '${type}', but a transition tagged ` +
            `'meta: { actor: "human" }' handles it, so the model is never offered it. Remove ` +
            `'${type}' from 'allowedEvents', or drop the tag if a model may send it.`,
        });
      }
    }
  }
  return out;
}

function checkDirectObjectSrc(ctx: LintContext): AgentLintDiagnostic[] {
  const out: AgentLintDiagnostic[] = [];
  for (const node of ctx.index.values()) {
    for (const invoke of node.invokes) {
      const src = invoke.src;
      if (typeof src === "string" || !src || typeof src !== "object") {
        continue;
      }
      if (!isAgentLogicNeedingBinding(src)) {
        continue;
      }
      out.push({
        code: "direct-object-src",
        severity: "warning",
        path: node.path,
        message:
          `State '${node.path}' invokes a direct-object agent logic. Direct-object invoke ` +
          `srcs cannot be rebound by the agent runtime, so they inherit no host executors — call ` +
          `'.withExecutor(...)' on the logic, or register it as a string-keyed actor source ` +
          `(machine.provide({ actors: { name: logic } })) and invoke it by name.`,
      });
    }
  }
  return out;
}

// True when a state config can observe an actor error: an explicit state-level
// `onError`, a wildcard handler, or an `xstate.error.*` handler in `on`.
function handlesActorError(config: AnyConfig): boolean {
  if (config["onError"] !== undefined) return true;
  return Object.keys(config.on ?? {}).some(
    (type) => type === "*" || type.startsWith("xstate.error"),
  );
}

function checkInvokeWithoutOnError(ctx: LintContext): AgentLintDiagnostic[] {
  const out: AgentLintDiagnostic[] = [];
  for (const node of ctx.index.values()) {
    for (const invoke of node.invokes) {
      if (invoke.onError !== undefined || handlesActorError(node.config)) {
        continue;
      }
      if (
        handlesActorError(ctx.config) ||
        ancestorChain(node, ctx.index).some((ancestor) => handlesActorError(ancestor.config))
      ) {
        continue;
      }
      const srcName = typeof invoke.src === "string" ? invoke.src : "(inline logic)";
      out.push({
        code: "invoke-without-on-error",
        severity: "warning",
        path: node.path,
        message:
          `State '${node.path}' invokes '${srcName}' with no 'onError' transition, and no ` +
          `ancestor handles an actor error. A rejected request or actor puts the machine in ` +
          `an error state with no modeled recovery. Add 'onError' (a 'failed' final state, or ` +
          `a bounded retry).`,
      });
    }
  }
  return out;
}

const LINT_CHECKS: Array<(ctx: LintContext) => AgentLintDiagnostic[]> = [
  checkDecideWithoutEvents,
  checkDecideAllowsHumanEvent,
  checkDirectObjectSrc,
  checkInvokeWithoutOnError,
];

/**
 * Runs static structural checks over a built agent machine and returns the
 * findings ({@link AgentLintDiagnostic}[], empty when clean). Works for
 * TS-authored (`setupAgent(...).createMachine(...)`) and
 * `setupAgent.fromConfig(...)`-compiled machines alike, reading `machine.config`
 * plus the schemas/actor sources the library already retains per machine.
 *
 * No model calls, no API keys — a coding agent that emits an agent machine can
 * call this to catch agent-specific mistakes such as undeliverable decisions,
 * un-rebindable request sources, and an unhandled transcript event. General
 * state-machine lint belongs to XState tooling.
 *
 * Pass `{ throw: true }` for the one-liner form used in tests and generation
 * loops: it returns silently when the machine is clean and throws
 * {@link AgentLintError} (findings on `.diagnostics`) on error-severity
 * findings, or on warnings too with `{ throw: true, warnings: true }`.
 *
 * @example
 * ```ts
 * const errors = lintAgentMachine(machine).filter((d) => d.severity === 'error');
 * if (errors.length) throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
 * ```
 *
 * @example Throwing form
 * ```ts
 * test('agent machine is structurally sound', () => {
 *   lintAgentMachine(machine, { throw: true });
 * });
 * ```
 */
export function lintAgentMachine(
  machine: AnyStateMachine,
  options: LintAgentMachineOptions = {},
): AgentLintDiagnostic[] {
  const config = (machine as { config?: AnyConfig }).config ?? {};
  const index = buildStateIndex(config);
  const registered = getRegisteredAgentExecutionOptions(machine);
  let json: AnyConfig | undefined;
  try {
    json = machineToJSON(machine) as AnyConfig;
  } catch {
    json = undefined;
  }
  const ctx: LintContext = {
    config,
    json,
    index,
    schemas: registered.schemas as LintContext["schemas"],
    actors:
      (registered.actors as Record<string, AnyActorLogic> | undefined) ??
      (machine as { sources?: { actors?: Record<string, AnyActorLogic> } }).sources?.actors ??
      {},
  };

  const disabled = new Set(options.disable ?? []);
  const diagnostics = LINT_CHECKS.flatMap((check) => check(ctx)).filter(
    (d) => !disabled.has(d.code),
  );

  if (options.throw) {
    const failing = options.warnings
      ? diagnostics
      : diagnostics.filter((d) => d.severity === "error");
    if (failing.length > 0) {
      throw new AgentLintError(machine.id ?? "(machine)", failing);
    }
  }

  return diagnostics;
}

/**
 * Thrown by `lintAgentMachine(machine, { throw: true })` (and its
 * {@link assertAgentMachine} alias) when lint finds failing diagnostics.
 * `diagnostics` holds the findings; the message lists them one per finding,
 * so a test runner's failure output reads like the CLI's lint report.
 */
export class AgentLintError extends AgentError {
  readonly diagnostics: AgentLintDiagnostic[];
  constructor(machineId: string, diagnostics: AgentLintDiagnostic[]) {
    const lines = diagnostics.map(
      (d) =>
        `  ${d.severity === "error" ? "error" : "warn "}  ${d.code}  ${d.path}\n         ${d.message}`,
    );
    super(
      "lint-failed",
      `Agent machine '${machineId}' failed lint (${diagnostics.length} finding(s)):\n${lines.join("\n")}`,
    );
    this.name = "AgentLintError";
    this.diagnostics = diagnostics;
  }
}

/** Options for {@link assertAgentMachine}. */
export interface AssertAgentMachineOptions extends LintAgentMachineOptions {
  /** Also fail on warning-severity findings. Default: errors only. */
  warnings?: boolean;
}

/**
 * Asserts a machine passes {@link lintAgentMachine}: returns silently when
 * clean, throws {@link AgentLintError} (with the findings on `.diagnostics`)
 * otherwise — sugar for `lintAgentMachine(machine, { ...options, throw: true })`.
 * Fails on error-severity findings; set `warnings: true` to fail on warnings
 * too. The one-liner for tests and generation loops:
 *
 * @example
 * ```ts
 * test('agent machine is structurally sound', () => {
 *   assertAgentMachine(machine);
 * });
 * ```
 */
export function assertAgentMachine(
  machine: AnyStateMachine,
  options: AssertAgentMachineOptions = {},
): void {
  lintAgentMachine(machine, { ...options, throw: true });
}

// ─── Simulation ───

/**
 * Scripted responses for a {@link simulateAgent} playthrough. Each channel is a
 * by-`src` map of FIFO queues, consumed in the order the machine reaches the
 * requests:
 * - `text` — output values for text requests, keyed by request src (the
 *   `setupAgent({ requests })` key, or `agent.generateText`/`agent.streamText`).
 * - `decisions` — the {@link ChosenEvent} to apply for a decision request,
 *   keyed by decision src (usually `agent.decide`). An invoke whose src is an
 *   inline logic object has only an auto-generated src, so its queue may be
 *   keyed by the invoke's `id` instead.
 * - `invokes` — output values for scripted invokes (any actor whose output must
 *   be canned), keyed by src.
 * - `errors` — failure values to reject a request or invoke with instead of
 *   resolving it, keyed by the same srcs the other channels use. An entry here
 *   is consumed BEFORE that src's output queue, so a script can fail the first
 *   call and let the second succeed. The invoke is rejected with
 *   {@link rejectAgentStep}, so the machine takes its `onError`; for
 *   `agent.decide` the entry stands in for retry exhaustion. A value can be
 *   anything — an `Error`, a string, or an object such as `{ code: 'truncated' }`
 *   for a machine that branches on `event.error.code`.
 * - `events` — a flat FIFO queue of external (human/host-sent) events. When the
 *   machine settles idle with no pending request or invoke — a human gate — the
 *   next queued event is applied, so a simulation can cross states that a live
 *   run crosses via `actor.send(...)`. An event the current state cannot take
 *   (no handler, or guard-rejected) throws rather than silently vanishing.
 */
export interface SimulationScript {
  text?: Record<string, unknown[]>;
  decisions?: Record<string, ChosenEvent[]>;
  invokes?: Record<string, unknown[]>;
  errors?: Record<string, unknown[]>;
  events?: ChosenEvent[];
}

/**
 * One entry in a {@link SimulateAgentResult.trail}: the state after this step,
 * plus what drove the step. The first entry is always the machine's initial
 * state, with no `appliedEvent`/`resolvedRequest` — so `trail.map((e) =>
 * e.state)` is the complete state path, directly comparable with
 * `matchesTrajectory` without prepending the initial state by hand.
 */
export interface SimulationTrailEntry {
  /** The machine state value after applying this step. */
  state: unknown;
  /** The chosen event applied (for a decision request), or the external event applied (when `external`). */
  appliedEvent?: ChosenEvent;
  /** True when `appliedEvent` came from the script's `events` queue (an external/user event), not a decision. */
  external?: boolean;
  /**
   * Scripted decisions that failed validation (unknown event, invalid payload,
   * or guard-rejected — live-run retry parity, see {@link simulateAgent})
   * before this step settled. Present with an `appliedEvent` when a later
   * scripted attempt succeeded, or alone when every attempt failed and the
   * exhaustion error was routed through the decision invoke's `onError`.
   */
  rejectedEvents?: ChosenEvent[];
  /**
   * The request this step settled (a text, decision, or scripted invoke): its
   * kind, src, and how it settled. `outcome` is `'output'` when a scripted
   * output resolved it and `'error'` when a `script.errors` entry rejected it,
   * in which case `error` carries the scripted failure value.
   */
  resolvedRequest?: {
    kind: "text" | "invoke" | "decision";
    src: string;
    id: string;
    outcome: "output" | "error";
    error?: unknown;
  };
}

/** Options for {@link simulateAgent}. */
export interface SimulateAgentOptions {
  input?: unknown;
  script: SimulationScript;
  /** Max steps before returning `'exhausted'`. Default 100. */
  maxSteps?: number;
}

/** The outcome of a {@link simulateAgent} playthrough. */
export interface SimulateAgentResult {
  /** `'done'` = reached a final state; `'idle'` = paused with no pending work; `'exhausted'` = hit `maxSteps`. */
  status: "done" | "idle" | "exhausted";
  snapshot: AnyMachineSnapshot;
  trail: SimulationTrailEntry[];
}

// A pending non-decision invoke read off the snapshot's live children (any
// actor whose output must be scripted).
// Ordered by invoke id, like `step.requests`.
interface PendingInvoke {
  id: string;
  src: string;
  input?: unknown;
  logic?: unknown;
  /** The live child actor (invoked or spawned), for `children: "explore"`. */
  ref?: ChildRef;
}

// The parts of a pure-transition child actor `children: "explore"` reads.
interface ChildRef {
  getSnapshot?: () => unknown;
  options?: { input?: unknown };
  _parent?: unknown;
  _initialEffects?: unknown;
}

function pendingInvokes(step: AgentStep): PendingInvoke[] {
  const out: PendingInvoke[] = [];
  const children = (step.snapshot.children ?? {}) as Record<string, ChildRef | undefined>;
  for (const metadata of getPendingInvokes(step.snapshot as AnyMachineSnapshot)) {
    if (typeof metadata.src === "string") {
      const ref = children[metadata.id];
      out.push({
        id: metadata.id,
        src: metadata.src,
        // A machine child's snapshot carries no `input`; its actor options do.
        input: metadata.input ?? ref?.options?.input,
        logic: metadata.logic,
        ref,
      });
    }
  }
  return out;
}

function takeFromQueue<T>(
  channel: Record<string, T[]> | undefined,
  src: string,
): { found: true; value: T } | { found: false } {
  const queue = channel?.[src];
  if (queue && queue.length > 0) {
    return { found: true, value: queue.shift() as T };
  }
  return { found: false };
}

/**
 * Deterministically plays a machine through, resolving each request from a
 * {@link SimulationScript} instead of a model — no API keys, no model calls.
 * Runs on the pure step path ({@link initialAgentStep} etc.), so it exercises
 * the real transition logic. Returns the terminal `status`, final `snapshot`,
 * and a `trail` of every step taken.
 *
 * Decisions run through the live run's own validation/retry core,
 * {@link resolveDecision}, with the script standing in for the model: each
 * attempt consumes the next queued {@link ChosenEvent} for that src, so an
 * unknown, payload-invalid, or guard-rejected event is NOT silently swallowed
 * — the next queued decision is tried, exactly as a live run re-asks the
 * model. The decision logic's `maxRetries` caps attempts as it would live;
 * when retries continue past the end of the queue, the last queued decision
 * repeats (a scripted model that insists). The repeat applies only within one
 * decision request's retries — each new decision request must have its own
 * queued entry, or the dry-script error throws as usual. Exhausting all
 * attempts delivers
 * the resulting {@link AgentDecisionExhaustedError} to the machine as the
 * decision invoke's error (so an `onError` transition observes it, as it
 * would live); with no `onError` to catch it, it is thrown.
 *
 * Throws a descriptive error when the script runs dry mid-request, naming the
 * pending request's kind, src, and id so the missing scripted response is
 * obvious.
 *
 * @example
 * ```ts
 * const { status, snapshot } = simulateAgent(machine, {
 *   input: { topic: 'state machines' },
 *   script: {
 *     decisions: { 'agent.decide': [{ type: 'ESCALATE' }] },
 *     events: [{ type: 'APPROVE' }], // crosses the human gate
 *   },
 * });
 * ```
 */
export async function simulateAgent(
  machine: AnyStateMachine,
  options: SimulateAgentOptions,
): Promise<SimulateAgentResult> {
  const maxSteps = options.maxSteps ?? 100;
  const script: SimulationScript = {
    // Each queue is copied, not just the map: `takeFromQueue` shifts entries
    // off, which would otherwise drain the caller's own arrays.
    text: mapValues(options.script.text ?? {}, (arr) => [...arr]),
    decisions: mapValues(options.script.decisions ?? {}, (arr) => [...arr]),
    invokes: mapValues(options.script.invokes ?? {}, (arr) => [...arr]),
    errors: mapValues(options.script.errors ?? {}, (arr) => [...arr]),
    events: [...(options.script.events ?? [])],
  };
  let step = initialAgentStep(machine, options.input);
  // The trail starts with the initial state, so it is a complete state path.
  const trail: SimulationTrailEntry[] = [{ state: step.snapshot.value }];

  for (let i = 0; i < maxSteps; i++) {
    if (step.done) {
      return { status: "done", snapshot: step.snapshot, trail };
    }

    const request = step.requests[0] as AgentStepRequest | undefined;
    if (request) {
      if (request.kind === "decision") {
        // A decision request carries no `src` of its own — correlate it to its
        // invoke (usually `agent.decide`) via the step's spawn actions. A
        // direct-object src lowers to an auto-generated src string
        // (`xstate.invoke.…`) nobody would key a script by, so the invoke id
        // works as the queue key too; the logic rides along for maxRetries.
        const invokeMeta = findInvokeMetadata(step, request.id);
        const src = invokeMeta?.src ?? request.id;
        const decisionSrc =
          src in (script.decisions ?? {})
            ? src
            : request.id in (script.decisions ?? {})
              ? request.id
              : src;
        const errorSrc = queueKey(script.errors, src, request.id);
        const failure = takeFromQueue(script.errors, errorSrc);
        if (failure.found) {
          // A scripted decide failure stands in for retry exhaustion: the
          // decide invoke is rejected, so its `onError` observes it.
          step = rejectScriptedRequest(machine, step, request.id, failure.value, {
            kind: "decision",
            src: errorSrc,
            trail,
          });
          continue;
        }
        step = await applyScriptedDecision(
          machine,
          step,
          request,
          decisionSrc,
          invokeMeta?.logic,
          script,
          trail,
        );
        continue;
      }
      // Text request. A scripted error for this src wins over its output queue.
      const failure = takeFromQueue(script.errors, request.src);
      if (failure.found) {
        step = rejectScriptedRequest(machine, step, request, failure.value, {
          kind: "text",
          src: request.src,
          trail,
        });
        continue;
      }
      const taken = takeFromQueue(script.text, request.src);
      if (!taken.found) {
        throw scriptDryError("text", request.src, request.id);
      }
      step = resolveAgentStep(machine, step, request, asTextResult(taken.value));
      trail.push({
        state: step.snapshot.value,
        resolvedRequest: {
          kind: "text",
          src: request.src,
          id: request.id,
          outcome: "output",
        },
      });
      continue;
    }

    // No text/decision request — check for a pending scripted invoke
    // (non-agent actors surface as spawn actions, not requests).
    const [invoke] = pendingInvokes(step);
    if (invoke) {
      const failure = takeFromQueue(script.errors, invoke.src);
      if (failure.found) {
        step = rejectScriptedRequest(machine, step, invoke.id, failure.value, {
          kind: "invoke",
          src: invoke.src,
          trail,
        });
        continue;
      }
      const taken = takeFromQueue(script.invokes, invoke.src);
      if (!taken.found) {
        throw scriptDryError("invoke", invoke.src, invoke.id);
      }
      step = resolveAgentStep(machine, step, invoke.id, taken.value);
      trail.push({
        state: step.snapshot.value,
        resolvedRequest: {
          kind: "invoke",
          src: invoke.src,
          id: invoke.id,
          outcome: "output",
        },
      });
      continue;
    }

    // Nothing pending and not done: an idle wait for an external event. Apply
    // the next scripted external event if there is one (the simulation
    // equivalent of a human's `actor.send(...)`), else settle idle.
    const external = script.events!;
    if (external.length > 0) {
      const event = external.shift() as ChosenEvent;
      if (!(step.snapshot as AnyMachineSnapshot).can(event as never)) {
        throw new Error(
          `simulateAgent: scripted external event '${event.type}' cannot be taken in state ` +
            `${JSON.stringify(step.snapshot.value)} (no handler, or its guard rejected it). ` +
            `A live run's send would be silently dropped here; fix the script's \`events\` queue.`,
        );
      }
      step = transitionAgentStep(machine, step, event as never);
      trail.push({ state: step.snapshot.value, appliedEvent: event, external: true });
      continue;
    }
    return { status: "idle", snapshot: step.snapshot, trail };
  }

  return { status: "exhausted", snapshot: step.snapshot, trail };
}

// The key a by-src channel is actually keyed by for this request: its src when
// present, else its invoke id (an inline logic src has only an auto-generated
// src string, so scripts key those by id).
function queueKey<T>(channel: Record<string, T[]> | undefined, src: string, id: string): string {
  return channel && !(src in channel) && id in channel ? id : src;
}

// Rejects a pending request/invoke with a scripted error value and records it
// on the trail. The rejection routes to the invoke's `onError`; when nothing
// catches it the machine's snapshot goes to `status: 'error'`, and the
// simulation throws — matching a live run, whose failed invoke ends the run.
function rejectScriptedRequest(
  machine: AnyStateMachine,
  step: AgentStep,
  request: { id: string } | string,
  error: unknown,
  entry: { kind: "text" | "invoke" | "decision"; src: string; trail: SimulationTrailEntry[] },
): AgentStep {
  const id = typeof request === "string" ? request : request.id;
  const next = rejectAgentStep(machine, step, request, error);
  if ((next.snapshot as { status?: unknown }).status === "error") {
    throw unhandledScriptedError(error, entry.kind, entry.src, id);
  }
  entry.trail.push({
    state: next.snapshot.value,
    resolvedRequest: { kind: entry.kind, src: entry.src, id, outcome: "error", error },
  });
  return next;
}

// The scripted error itself is thrown when it is an Error, so a test can assert
// on the very value it scripted; any other value is wrapped, carried on `cause`.
function unhandledScriptedError(
  error: unknown,
  kind: "text" | "invoke" | "decision",
  src: string,
  id: string,
): unknown {
  if (error instanceof Error) {
    return error;
  }
  return new Error(
    `simulateAgent: the scripted error for the ${kind} request '${src}' (id '${id}') reached no ` +
      `onError transition, so the machine errored. Add an onError to that invoke, or drop the ` +
      `errors['${src}'] entry.`,
    { cause: error },
  );
}

// Resolves one decision request by running the live run's own validation/retry
// core, resolveDecision, with a scripted `decide` executor standing in for the
// model — so unknown-event, invalid-payload, and rejected-by-guard semantics
// (and the maxRetries budget) are the real ones, not a mirror that can drift.
// Each attempt dequeues the next scripted decision; when retries continue past
// the end of the queue, the last queued decision repeats (a scripted model
// that insists). A queue that is empty on the FIRST ask throws the dry-script
// error. Exhaustion is delivered to the machine as the invoke's error event so
// `onError` can observe it (as live), and thrown when nothing handles it.
async function applyScriptedDecision(
  machine: AnyStateMachine,
  step: AgentStep,
  request: AgentStepRequest & { kind: "decision" },
  decisionSrc: string,
  invokeLogic: unknown,
  script: SimulationScript,
  trail: SimulationTrailEntry[],
): Promise<AgentStep> {
  // The scripted decisions actually dequeued for this request (synthetic
  // repeats excluded) — failed ones surface on the trail as `rejectedEvents`.
  const dequeued: ChosenEvent[] = [];
  const decide = async (): Promise<{ event: ChosenEvent }> => {
    const taken = takeFromQueue(script.decisions, decisionSrc);
    if (taken.found) {
      dequeued.push(taken.value);
      return { event: taken.value };
    }
    if (dequeued.length === 0) {
      throw scriptDryError("decision", decisionSrc, request.id, request);
    }
    return { event: dequeued[dequeued.length - 1] as ChosenEvent };
  };

  // Mirror bindDecisionLogic (the runtime path): the attempt budget is the
  // invoke input's own `maxRetries` (lowered onto the request by
  // logic.request), else the decision logic's. For the logic: the invoke's
  // own logic wins (covers direct-object srcs), then the registered actors,
  // then `sources.actors` (which survives `machine.provide(...)`, whose
  // product the registry may not know).
  const logic = isDecisionLogic(invokeLogic)
    ? invokeLogic
    : resolveRegisteredDecisionLogic(machine, decisionSrc);
  const maxRetries = request.maxRetries ?? logic?.maxRetries;

  // A closed choice (decide input `payloads`) offers only the options the
  // snapshot accepts, as a live run does; a scripted event matching none of
  // them is rejected and retried.
  const can = (event: ChosenEvent): boolean =>
    (step.snapshot as AnyMachineSnapshot).can(event as never);
  const options = acceptedDecisionOptions(request, can);
  const offered = options ? { ...request, options } : request;

  let chosen: ChosenEvent;
  try {
    chosen = await resolveDecision(
      offered,
      { decide },
      {
        maxRetries,
        canTake: can,
      },
    );
  } catch (error) {
    if (!(error instanceof AgentDecisionExhaustedError)) {
      throw error;
    }
    const next = rejectAgentStep(machine, step, request.id, error);
    if ((next.snapshot as { status?: unknown }).status === "error") {
      // No onError anywhere caught it — same as a live run failing.
      throw error;
    }
    trail.push({ state: next.snapshot.value, rejectedEvents: dequeued });
    return next;
  }

  const next = transitionAgentStep(machine, step, chosen as never);
  // Success comes from the last dequeued decision; everything before it failed.
  const rejected = dequeued.slice(0, -1);
  trail.push({
    state: next.snapshot.value,
    appliedEvent: chosen,
    ...(rejected.length > 0 ? { rejectedEvents: rejected } : {}),
  });
  return next;
}

// The metadata for the still-pending invoke with this id: its string src (when
// it has one) and its inline logic (when the src is a direct logic object).
function findInvokeMetadata(
  step: AgentStep,
  id: string,
): { src?: string; logic?: unknown } | undefined {
  for (const metadata of getPendingInvokes(step.snapshot as AnyMachineSnapshot)) {
    if (metadata.id !== id) {
      continue;
    }
    return {
      ...(typeof metadata.src === "string" ? { src: metadata.src } : {}),
      logic: metadata.logic ?? (typeof metadata.src === "object" ? metadata.src : undefined),
    };
  }
  return undefined;
}

// The DecisionLogic registered for a src, checking the machine's registered
// setupAgent actors first and falling back to `machine.sources.actors` (the
// same chain lintAgentMachine uses, so `.provide(...)` products resolve too).
function resolveRegisteredDecisionLogic(
  machine: AnyStateMachine,
  src: string,
): { maxRetries: number } | undefined {
  const candidate =
    (getRegisteredAgentExecutionOptions(machine).actors as Record<string, unknown> | undefined)?.[
      src
    ] ?? (machine as { sources?: { actors?: Record<string, unknown> } }).sources?.actors?.[src];
  return isDecisionLogic(candidate) ? candidate : undefined;
}

// A scripted text value is the bare `result`; the invoke resolves to the same
// `{ result, messages }` a live executor produces, with no messages.
function asTextResult(value: unknown): AgentTextResult {
  return { result: value, messages: [] };
}

function mapValues<T, U>(obj: Record<string, T>, fn: (value: T) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, fn(value)]));
}

function scriptDryError(
  kind: "text" | "decision" | "invoke",
  src: string,
  id: string,
  request?: AgentStepRequest,
): Error {
  const events =
    request?.kind === "decision"
      ? ` Candidate events: ${request.events.map((e) => e.type).join(", ") || "(none)"}.`
      : "";
  const key =
    kind === "text"
      ? `text['${src}']`
      : kind === "decision"
        ? `decisions['${src}']`
        : `invokes['${src}']`;
  return new Error(
    `simulateAgent: script ran dry on a pending ${kind} request for src '${src}' (id '${id}'). ` +
      `Add an entry to the script's \`${key}\` queue.${events}`,
  );
}

// ─── Path exploration ───

/** Options for {@link explorePaths}. */
/**
 * The snapshot type the exploration callbacks (`payloads`, `dedupeBy`, a
 * `canReach` predicate) receive. Import it from here rather than from your
 * own `xstate`, which can be another version than the one this package uses.
 */
export type ExploreSnapshot = AnyMachineSnapshot;

/** What {@link canReach} looks for: a state id or path, or a snapshot predicate. */
export type CanReachTarget = string | ((snapshot: ExploreSnapshot) => boolean);

export interface ExplorePathsOptions {
  input?: unknown;
  /** Max branch points (decisions + external-event forks) along any path. Default 8. */
  maxDepth?: number;
  /** Total path cap before exploration stops (reported via `hitPathCap`). Default 200. */
  maxPaths?: number;
  /**
   * Total branch points expanded before exploration stops (reported via
   * `hitPathCap`). Default 100,000. It bounds work and memory where
   * `maxPaths` cannot: a loopy machine expands many nodes per terminal.
   */
  maxNodes?: number;
  /**
   * Every output to try per src: a text request's src (the
   * `setupAgent({ requests })` key, or `agent.generateText`/`agent.streamText`)
   * or any other invoked actor's src. A one-element list is a canned output,
   * reused every time that src is reached; a text request resolves with it as
   * its `result` (`{ result, messages: [] }`). A src with two or more outputs
   * forks one branch per output (plus the `errors` branch when the src is
   * listed there too), so a machine whose `onDone` branches on the output is
   * explored down every arm. Each fork counts against `maxDepth`, and each
   * forked branch records `{ type: 'xstate.done.actor.<id>', output }` in the
   * path. A src with no entry (and no `errors` entry) halts that branch with a
   * `needs-output` terminal.
   */
  outputs?: Record<string, unknown[]>;
  /**
   * A canned failure per src, keyed like `outputs`. A src listed here
   * forks an extra branch at that invoke, where the invoke is rejected and the
   * machine takes its `onError` — so states reachable only through a failure
   * are explored. When the src also has an output, both branches are explored;
   * when it has only an error, only the failing one is. Each fork counts
   * against `maxDepth`, and the failing branch records
   * `{ type: 'xstate.error.actor.<id>' }` in the path.
   *
   * A decision invoke can be keyed here too — by its src (usually
   * `agent.decide`) or by its invoke id — standing in for retry exhaustion.
   * Its success branch is the usual per-candidate-event fork, so the failing
   * branch is explored in addition to, not instead of, the candidates.
   *
   * A rejection that reaches no `onError` errors the machine, and that path
   * ends in an `error` terminal.
   *
   * An array forks one failing branch per element, each recording its value
   * as `error` in the path entry; `[]` is no entry. Any other value is a
   * single failure. A single failure that is itself an array must be wrapped:
   * `[[...]]`.
   */
  errors?: Record<string, unknown | unknown[]>;
  /**
   * Where external events fork. `"idle"` (default): only at idle waits.
   * `"pending"`: also wherever an invoke is outstanding — before a text or
   * scripted invoke resolves (straight through or forked), at a
   * `needs-output` block, and at a decision — each event the active states
   * accept (decision candidates excepted) forks as "the event arrives before
   * the actor settles". Each such branch counts against `maxDepth`;
   * `payloads` and `dedupeBy` apply as at idle waits.
   */
  interleave?: "idle" | "pending";
  /**
   * How a child state machine (invoked, or spawned with `enq.spawn`) with no
   * `outputs` entry settles. `"outputs"` (default): it is a `needs-output`
   * block like any other src. `"explore"`: the child is explored on its own
   * with the same options (and its own invoke or spawn input), to at most 4
   * nested levels. Each distinct `output` of its `done` terminals forks the
   * parent as an output, each distinct failure of its `error` terminals
   * forks a failing branch, each distinct event it sends its parent
   * (`sendTo(parent, …)`) forks the parent receiving it, and a child that
   * can stall `idle` adds an `idle` terminal. Child idle waits are not
   * parent fork points. A child search that was incomplete also ends the
   * parent branch `needs-output` for that src, so the parent report is not
   * complete.
   *
   * Bounded: each child is explored independently. Its events and outputs
   * are not correlated: any of its events, each at most once per path and
   * in any order, can reach the parent before it settles. Several pending
   * explored children settle in any order; other combinations are not
   * enumerated beyond `interleave`. A child receives only the events its
   * parent forwards or the host sends it, so the child search offers
   * external events only for the types
   * {@link ExplorePathsOptions.childEvents} lists for its src (none by
   * default). A child wait that accepts an event not listed leaves the
   * child search incomplete.
   */
  children?: "outputs" | "explore";
  /**
   * With `children: "explore"`: per child src, the event types that can
   * reach the child at its waits (the ones the parent forwards with
   * `sendTo`/`forwardTo`, or the host sends it directly). Unlisted types are
   * never offered to the child.
   */
  childEvents?: Record<string, string[]>;
  /**
   * Payloads to try per event type at each branch point, given the settled
   * snapshot there. At a decision or an idle wait, an event type with an
   * entry forks once per payload as `{ ...payload, type }`; guard-rejected
   * variants count in `prunedByGuard`. An entry here overrides the
   * decision request's own `options` (from the decide input's `payloads`)
   * for that type.
   *
   * A type with no entry and no request option is filled from its event
   * schema when that schema exposes JSON Schema (Standard JSON Schema, e.g.
   * Zod 4) and its fields are finite domains (`enum`, `const`, `boolean`,
   * `null`, or a union of those): it forks over the cartesian product, up to
   * 64 combinations, each optional field also omitted. A type with a required
   * non-finite field, or a product over the cap, is applied as `{ type }`; an
   * optional non-finite field is left out. Either way the type's real variants
   * were not all tried, so it is listed in `unexpandedEvents`. A type with no
   * schema at all is applied as `{ type }`.
   */
  payloads?: (snapshot: ExploreSnapshot) => Partial<Record<string, Record<string, unknown>[]>>;
  /**
   * A projection of the snapshot that determines its future. Settled
   * snapshots with an equal key are explored once (again only when reached
   * at a shallower depth), so payload and output branching that converges
   * stays tractable. Return everything a guard, choice, or output reads:
   * a key that drops a field the machine reads makes the search unsound.
   * Without it, every path is explored in full.
   */
  dedupeBy?: (snapshot: ExploreSnapshot) => string;
}

/** A single explored path's terminal outcome. */
export interface AgentPathTerminal {
  /**
   * `'error'` is a scripted failure the machine had no `onError` for: the
   * snapshot is errored, exactly as a live run's unhandled invoke failure.
   */
  status: "done" | "idle" | "needs-output" | "max-depth" | "error";
  /** The chosen/applied events, in order, that produced this terminal. */
  path: ChosenEvent[];
  /** The final state value on this path. */
  state: unknown;
  /** For `needs-output`: the src with no `outputs` entry. */
  missingSrc?: string;
  /** For `error`: the failure value that errored the machine. */
  error?: unknown;
}

/** The report returned by {@link explorePaths}. */
export interface AgentPathReport {
  /** Every distinct state value (JSON) encountered across all explored paths. */
  reachedStates: unknown[];
  /** One entry per explored path. */
  terminals: AgentPathTerminal[];
  /** How many candidate events were pruned because a guard rejected them. */
  prunedByGuard: number;
  /** Notes about coverage the exploration could not complete (missing outputs, depth/path caps). */
  unexplored: string[];
  /** Total paths explored. */
  pathsExplored: number;
  /** True when a cap (`maxPaths` or `maxNodes`) cut exploration short (report is partial). */
  hitPathCap: boolean;
  /**
   * Event types whose payload variants were not all tried: their schema has
   * a non-finite field or a product over the fill cap, and `payloads` has no
   * entry for them. Add a `payloads` entry for each to cover them.
   */
  unexpandedEvents: string[];
  /**
   * Event types offered only as the bare `{ type }` fallback at a snapshot
   * where a transition for them may read the payload (a function transition,
   * guard, `matches`, or context mapper): no `payloads` entry, no decision
   * option, and no schema variant beyond `{ type }` (no schema, or one whose
   * fields the fill cannot enumerate). A subset of `unexpandedEvents`: the
   * payload-reading logic was exercised with no payload at all. Data only;
   * it does not change completeness.
   */
  vacuous: string[];
}

// Safety bound on the deterministic advance between two branch points: each
// iteration resolves one text or scripted invoke, so this only trips on a machine
// that loops through invokes without ever branching or settling.
const MAX_ADVANCE_STEPS = 1000;

// An invoke that `options.errors` or `options.outputs` turns into a branch
// point: it can be rejected (when the src is in `errors`), and resolved with
// each of its outputs.
interface InvokeFork {
  id: string;
  /** Failure values, one failing branch each. */
  errors: unknown[];
  /** Record each failure as `error` on its path entry (an array `errors` entry, or a child's failures). */
  recordError?: boolean;
  outputs: unknown[];
  /** An explored child can stall idle: the parent waits there forever. */
  stalls?: boolean;
  /** An explored child whose search was incomplete: the src's outputs may be partial. */
  incompleteSrc?: string;
  /** Text requests resolve to `{ result, messages }`, not the bare output. */
  isText?: boolean;
  /** An explored child's events to its parent, each delivered at most once per path. */
  events?: EventObject[];
  /**
   * A decision invoke has no canned output of its own — its success branch is
   * the per-candidate-event fork the branch-point logic already does. So the
   * fork rejects it, then falls through to that normal branching instead of
   * resolving an output.
   */
  isDecision?: boolean;
}

// Cap on the cartesian product a schema's finite fields expand to.
const FINITE_PAYLOAD_CAP = 64;

// Default cap on branch points expanded per exploration.
const DEFAULT_MAX_NODES = 100_000;

// Cap on nested child-machine explorations (`children: "explore"`).
const MAX_CHILD_NESTING = 4;

function isMachineLogic(logic: unknown): logic is AnyStateMachine {
  return (
    isRecord(logic) &&
    "root" in logic &&
    "config" in logic &&
    typeof logic["transition"] === "function"
  );
}

// Distinct values by JSON (an Error by name and message), first seen first.
function distinctValues(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    let key: string;
    try {
      key =
        value instanceof Error
          ? `Error:${value.name}:${value.message}`
          : (JSON.stringify(value) ?? String(value));
    } catch {
      return true;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// What an explored child machine settles to, for its parent's invoke.
interface ChildOutcome {
  outputs: unknown[];
  errors: unknown[];
  /** Distinct events the child sends its parent on some explored path. */
  events: EventObject[];
  stalls: boolean;
  complete: boolean;
}

// The events a child's effects send to `parent` (`sendTo(parent, …)`).
function eventsToParent(effects: unknown, parent: unknown): EventObject[] {
  if (parent === undefined || !Array.isArray(effects)) {
    return [];
  }
  return effects.flatMap((effect) =>
    isRecord(effect) &&
    effect["type"] === "@xstate.sendTo" &&
    effect["target"] === parent &&
    isRecord(effect["event"]) &&
    typeof effect["event"]["type"] === "string"
      ? [effect["event"] as EventObject]
      : [],
  );
}

// Every value a JSON Schema admits when that set is finite and small: a
// `const`, an `enum`, `boolean`, `null`, or a union of those. Else undefined.
function finiteDomain(schema: unknown): unknown[] | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }
  if ("const" in schema) {
    return [schema["const"]];
  }
  if (Array.isArray(schema["enum"])) {
    return schema["enum"];
  }
  const union = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(union)) {
    const parts = union.map(finiteDomain);
    return parts.every((part) => part !== undefined) ? [...new Set(parts.flat())] : undefined;
  }
  const types: unknown[] = Array.isArray(schema["type"]) ? schema["type"] : [schema["type"]];
  if (types.every((type) => type === "boolean" || type === "null")) {
    return types.flatMap((type) => (type === "boolean" ? [true, false] : [null]));
  }
  return undefined;
}

const OMITTED = Symbol("omitted");

// The payloads an object JSON Schema admits: the product over its finite
// fields, each optional one also omitted. `complete` is false when that is not
// every variant: an optional non-finite field is left out, and a required
// non-finite field, a product over the cap, or a non-object schema falls back
// to the bare `{}`.
function finitePayloads(jsonSchema: unknown): {
  payloads: Record<string, unknown>[];
  complete: boolean;
} {
  const bare = { payloads: [{}], complete: false };
  if (
    !isRecord(jsonSchema) ||
    (jsonSchema["type"] !== "object" && !isRecord(jsonSchema["properties"]))
  ) {
    return bare;
  }
  const properties = isRecord(jsonSchema["properties"]) ? jsonSchema["properties"] : {};
  const required = new Set(Array.isArray(jsonSchema["required"]) ? jsonSchema["required"] : []);
  if ([...required].some((key) => key !== "type" && !(key in properties))) {
    return bare;
  }
  let product: Record<string, unknown>[] = [{}];
  let complete = true;
  for (const [key, schema] of Object.entries(properties)) {
    if (key === "type") {
      continue;
    }
    const domain = finiteDomain(schema);
    if (!domain || domain.length === 0) {
      if (required.has(key)) {
        return bare;
      }
      complete = false;
      continue;
    }
    const choices: unknown[] = required.has(key) ? domain : [OMITTED, ...domain];
    if (product.length * choices.length > FINITE_PAYLOAD_CAP) {
      return bare;
    }
    product = product.flatMap((payload) =>
      choices.map((value) => (value === OMITTED ? payload : { ...payload, [key]: value })),
    );
  }
  return { payloads: product, complete };
}

// True when a transition for `type` at this snapshot could read the event's
// payload: a function transition, a guard, a `matches` pattern, or a context
// mapper. An object transition with none of these cannot.
function mayReadPayload(snapshot: AnyMachineSnapshot, type: string): boolean {
  return getNextTransitions(snapshot).some(
    (transition) =>
      transition.eventType === type &&
      (transition.to !== undefined ||
        transition.guard !== undefined ||
        transition.matches !== undefined ||
        typeof transition.context === "function"),
  );
}

// A pending branch point: the step to advance, the events that led to it, and
// how many branch points it has spent against `maxDepth`.
interface ExploreNode {
  step: AgentStep;
  path: ChosenEvent[];
  depth: number;
  /** Child-to-parent events already delivered on this path (`<child id>\u0000<event JSON>`). */
  delivered?: ReadonlySet<string> | undefined;
}

// An explored child starts from its pure-transition actor's snapshot, which
// keeps the parent link `sendTo(parent, …)` needs, with the requests a fresh
// start of the same logic and input discovers.
function childStartStep(machine: AnyStateMachine, input: unknown, ref?: ChildRef): AgentStep {
  const fresh = initialAgentStep(machine, input);
  const snapshot = ref?.getSnapshot?.();
  return isRecord(snapshot) && snapshot["status"] === "active"
    ? { ...fresh, snapshot: snapshot as unknown as AnyMachineSnapshot }
    : fresh;
}

// Drops delivered child events whose child is no longer running, so a child
// started again under the same id can send them again.
function pruneDelivered(
  delivered: ReadonlySet<string> | undefined,
  step: AgentStep,
): ReadonlySet<string> | undefined {
  if (delivered === undefined || delivered.size === 0) {
    return delivered;
  }
  const running = step.snapshot.children ?? {};
  const kept = [...delivered].filter((key) => key.slice(0, key.indexOf("\u0000")) in running);
  return kept.length === delivered.size ? delivered : new Set(kept);
}

// Shared engine for explorePaths/canReach. Without `stopWhen` it walks depth
// first (explorePaths' terminal order). With `stopWhen` (canReach) it walks
// breadth first by path length and halts on the first snapshot the predicate
// holds for, so the returned witness is a shortest path.
function explore(
  machine: AnyStateMachine,
  options: ExplorePathsOptions,
  stopWhen?: (snapshot: AnyMachineSnapshot) => boolean,
  nesting = 0,
  // For an explored child: the external event types that can reach it.
  // Undefined at the root, where every accepted event can arrive.
  deliverable?: ReadonlySet<string>,
  // For an explored child: its pure-transition actor, whose parent link
  // makes `sendTo(parent, …)` observable.
  childRef?: ChildRef,
): {
  report: AgentPathReport;
  witness?: ChosenEvent[];
  doneOutputs: unknown[];
  failures: unknown[];
  undeliverable: string[];
  parentEvents: EventObject[];
} {
  const maxDepth = options.maxDepth ?? 8;
  const maxPaths = options.maxPaths ?? 200;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const errorScript = options.errors ?? {};
  const outputScript = options.outputs ?? {};
  const interleaving = options.interleave === "pending";
  // An `errors` entry's failure values: an array is one per element (`[]` is
  // no entry), anything else is one failure.
  const errorsFor = (key: string): { values: unknown[]; record: boolean } | undefined => {
    if (!(key in errorScript)) {
      return undefined;
    }
    const entry = errorScript[key];
    if (Array.isArray(entry)) {
      return entry.length > 0 ? { values: entry, record: true } : undefined;
    }
    return { values: [entry], record: false };
  };
  // An agent machine's registered schemas, else a plain machine's own `schemas.events`.
  const eventSchemas =
    (getRegisteredAgentExecutionOptions(machine).schemas as AgentSchemas | undefined)?.events ??
    (machine.schemas as AgentSchemas | undefined)?.events ??
    {};

  // Schema-derived payloads per event type, computed once per type. A type
  // with no schema is applied bare. That covers it only when no transition
  // for it at this snapshot can read the payload: a function transition, a
  // guard, a `matches` pattern, or a context mapper could, so such a type
  // is unexpanded.
  const finiteCache = new Map<string, { payloads: Record<string, unknown>[]; complete: boolean }>();
  const schemaPayloads = (
    type: string,
    snapshot: AnyMachineSnapshot,
  ): Record<string, unknown>[] => {
    const schema = eventSchemas[type];
    let fill = finiteCache.get(type);
    if (schema && !fill) {
      fill = finitePayloads(safeJsonSchema(schema));
      finiteCache.set(type, fill);
    }
    fill ??= { payloads: [{}], complete: !mayReadPayload(snapshot, type) };
    // Only the bare `{ type }` reaches a transition that may read the payload.
    if (
      !fill.complete &&
      fill.payloads.length === 1 &&
      Object.keys(fill.payloads[0]!).length === 0 &&
      mayReadPayload(snapshot, type)
    ) {
      vacuous.add(type);
    }
    if (!fill.complete && !unexpanded.has(type)) {
      unexpanded.add(type);
      unexplored.push(
        schema
          ? `unexpanded: event '${type}' has payload fields the schema fill cannot enumerate; add a payloads entry for it`
          : `unexpanded: event '${type}' has no schema and a transition that may read its payload; add a payloads entry for it`,
      );
    }
    return fill.payloads;
  };

  // The concrete events to try for one event type at a branch point: the
  // explorer's `payloads`, else the decision request's own options, else the
  // schema's finite domain, else the bare `{ type }`.
  const variantsOf = (
    type: string,
    snapshot: AnyMachineSnapshot,
    table: Partial<Record<string, Record<string, unknown>[]>>,
    requestOptions?: AgentDecisionOption[],
  ): ChosenEvent[] => {
    const listed = table[type];
    if (listed) {
      return listed.map((payload) => ({ ...payload, type }));
    }
    // A closed choice is the whole branch set, as at run time: a type the
    // decide input withheld with `[]` has no options and is not explored.
    if (requestOptions) {
      return requestOptions
        .filter((option) => option.event.type === type)
        .map((option) => option.event);
    }
    return schemaPayloads(type, snapshot).map((payload) => ({ ...payload, type }));
  };

  // `children: "explore"`: a child machine explored on its own, once per
  // (logic, input). Its unexpanded and vacuous types join this report's.
  const childCache = new Map<unknown, Map<string, ChildOutcome>>();
  const exploreChild = (
    src: string,
    logic: AnyStateMachine,
    input: unknown,
    ref?: ChildRef,
  ): ChildOutcome => {
    if (nesting >= MAX_CHILD_NESTING) {
      unexplored.push(
        `child: src '${src}' is nested deeper than ${MAX_CHILD_NESTING} machines; not explored`,
      );
      return { outputs: [], errors: [], events: [], stalls: false, complete: false };
    }
    let key: string | undefined;
    try {
      // Keyed by src too: `childEvents` is per src.
      key = `${src}\u0000${JSON.stringify(input) ?? "undefined"}`;
    } catch {
      key = undefined;
    }
    const byInput = childCache.get(logic) ?? new Map<string, ChildOutcome>();
    childCache.set(logic, byInput);
    const cached = key === undefined ? undefined : byInput.get(key);
    if (cached) {
      return cached;
    }
    const child = explore(
      logic,
      { ...options, input },
      undefined,
      nesting + 1,
      new Set(options.childEvents?.[src] ?? []),
      ref,
    );
    if (child.undeliverable.length > 0) {
      unexplored.push(
        `child: src '${src}' waits for ${child.undeliverable.join(", ")}, which childEvents does not list as reaching it; list each event the parent forwards`,
      );
    }
    for (const type of child.report.unexpandedEvents) unexpanded.add(type);
    for (const type of child.report.vacuous) vacuous.add(type);
    const outcome: ChildOutcome = {
      outputs: distinctValues(child.doneOutputs),
      errors: distinctValues(child.failures),
      events: distinctValues(child.parentEvents) as EventObject[],
      stalls: child.report.terminals.some((terminal) => terminal.status === "idle"),
      complete: isExplorationComplete(child.report) && child.undeliverable.length === 0,
    };
    if (!outcome.complete) {
      unexplored.push(
        `child: exploring src '${src}' was incomplete, so its outputs may be partial; add an outputs entry for it`,
      );
    }
    if (key !== undefined) {
      byInput.set(key, outcome);
    }
    return outcome;
  };

  // How a text request or scripted invoke settles: resolved straight through
  // with its single output, forked (an `errors` entry, several `outputs`, or
  // an explored child's outcomes), or blocked on a missing output.
  const settleFor = (
    id: string,
    src: string,
    isText: boolean,
    invoke?: PendingInvoke,
  ): { fork: InvokeFork } | { output: unknown } | { blocked: true } => {
    const failures = errorsFor(src);
    if (
      options.children === "explore" &&
      !(src in outputScript) &&
      !failures &&
      isMachineLogic(invoke?.logic)
    ) {
      const child = exploreChild(src, invoke.logic, invoke.input, invoke.ref);
      if (
        child.outputs.length === 1 &&
        child.errors.length === 0 &&
        child.events.length === 0 &&
        !child.stalls &&
        child.complete
      ) {
        return { output: child.outputs[0] };
      }
      if (
        child.outputs.length === 0 &&
        child.errors.length === 0 &&
        child.events.length === 0 &&
        !child.stalls
      ) {
        return { blocked: true };
      }
      return {
        fork: {
          id,
          errors: child.errors,
          recordError: true,
          outputs: child.outputs,
          events: child.events,
          stalls: child.stalls,
          ...(child.complete ? {} : { incompleteSrc: src }),
        },
      };
    }
    const outputs = outputScript[src] ?? [];
    if (failures || outputs.length > 1) {
      return {
        fork: {
          id,
          errors: failures?.values ?? [],
          recordError: failures?.record ?? false,
          outputs,
          isText,
        },
      };
    }
    return outputs.length === 1 ? { output: outputs[0] } : { blocked: true };
  };

  // A pending invoke `children: "explore"` explores rather than scripts.
  const isExploredChild = (invoke: PendingInvoke): boolean =>
    options.children === "explore" &&
    !(invoke.src in outputScript) &&
    !errorsFor(invoke.src) &&
    isMachineLogic(invoke.logic);
  // The other pending explored children, as forks of their own.
  const siblingForks = (invokes: PendingInvoke[]): InvokeFork[] =>
    invokes.filter(isExploredChild).flatMap((invoke) => {
      const settle = settleFor(invoke.id, invoke.src, false, invoke);
      if ("fork" in settle) {
        return [settle.fork];
      }
      return "output" in settle ? [{ id: invoke.id, errors: [], outputs: [settle.output] }] : [];
    });

  const reachedStates = new Set<string>();
  const reachedValues: unknown[] = [];
  const terminals: AgentPathTerminal[] = [];
  const unexplored: string[] = [];
  const unexpanded = new Set<string>();
  const vacuous = new Set<string>();
  const doneOutputs: unknown[] = [];
  const failures: unknown[] = [];
  let prunedByGuard = 0;
  let pathsExplored = 0;
  let nodesExpanded = 0;
  let hitPathCap = false;
  // True, and recorded, once either cap leaves a node unexpanded.
  const capped = (): boolean => {
    if (pathsExplored >= maxPaths || nodesExpanded >= maxNodes) {
      hitPathCap = true;
    }
    return hitPathCap;
  };
  let witness: ChosenEvent[] | undefined;
  // `dedupeBy` key → the shallowest depth it was explored at.
  const visited = new Map<string, number>();

  const parentEvents: EventObject[] = [];
  const parent = childRef?._parent;
  const recordState = (step: AgentStep, effects: unknown = step.actions): void => {
    const key = JSON.stringify(step.snapshot.value);
    if (!reachedStates.has(key)) {
      reachedStates.add(key);
      reachedValues.push(step.snapshot.value);
    }
    parentEvents.push(...eventsToParent(effects, parent));
  };

  const initial = childStartStep(machine, options.input, childRef);
  recordState(initial, childRef?._initialEffects ?? initial.actions);
  if (stopWhen?.(initial.snapshot)) {
    witness = [];
  }

  // Advance a step deterministically through any non-branching text or scripted
  // invokes until it is done, idle-with-external-events, at a decision, or
  // blocked on a missing canned output. Returns the settled step plus a note.
  // `stopWhen` is checked on EVERY snapshot along the way — including the
  // intermediate ones this advance resolves straight through — so a predicate
  // canReach target that only holds mid-chain is still found (`hit`).
  // With `interleave: "pending"`, an invoke that would resolve straight
  // through stops the advance (`pending`) when the active states accept an
  // external event, so the event can race it.
  // Accepted events that can actually arrive: all of them at the root, only
  // the deliverable ones in an explored child (the rest are noted).
  const undeliverable = new Set<string>();
  const arriving = (snapshot: AnyMachineSnapshot) =>
    getAcceptedEvents(snapshot).filter((descriptor) => {
      if (deliverable === undefined || deliverable.has(descriptor.type)) {
        return true;
      }
      undeliverable.add(descriptor.type);
      return false;
    });
  const races = (step: AgentStep): boolean =>
    interleaving && arriving(step.snapshot as AnyMachineSnapshot).length > 0;
  const advance = (
    step: AgentStep,
  ): {
    step: AgentStep;
    blockedSrc?: string;
    hit?: boolean;
    fork?: InvokeFork;
    /** Other pending explored children, which can settle or send first. */
    siblings?: InvokeFork[];
    pending?: { id: string; output: unknown };
  } => {
    let current = step;
    // Bounded loop: each iteration resolves one text or scripted invoke.
    for (let i = 0; i < MAX_ADVANCE_STEPS; i++) {
      if (stopWhen?.(current.snapshot)) {
        return { step: current, hit: true };
      }
      if (current.done) {
        return { step: current };
      }
      const request = current.requests[0] as AgentStepRequest | undefined;
      if (request && request.kind === "text") {
        const settle = settleFor(request.id, request.src, true);
        if ("fork" in settle) {
          return { step: current, fork: settle.fork };
        }
        if ("blocked" in settle) {
          return { step: current, blockedSrc: request.src };
        }
        if (races(current)) {
          return {
            step: current,
            pending: { id: request.id, output: asTextResult(settle.output) },
          };
        }
        current = resolveAgentStep(machine, current, request, asTextResult(settle.output));
        recordState(current);
        continue;
      }
      if (request && request.kind === "decision") {
        // A decision request carries no `src` of its own: correlate it to its
        // invoke the way simulateAgent does, and accept either the src
        // (usually `agent.decide`) or the invoke id as the `errors` key.
        const src = findInvokeMetadata(current, request.id)?.src;
        const failed = (src !== undefined ? errorsFor(src) : undefined) ?? errorsFor(request.id);
        return failed
          ? {
              step: current,
              fork: {
                id: request.id,
                errors: failed.values,
                recordError: failed.record,
                outputs: [],
                isDecision: true,
              },
            }
          : { step: current };
      }
      // No request: maybe a pending scripted invoke, else a wait.
      const [invoke, ...others] = pendingInvokes(current);
      if (invoke) {
        const settle = settleFor(invoke.id, invoke.src, false, invoke);
        const siblings = isExploredChild(invoke) ? siblingForks(others) : [];
        if ("fork" in settle) {
          return { step: current, fork: settle.fork, siblings };
        }
        if ("output" in settle && siblings.length > 0) {
          return {
            step: current,
            fork: { id: invoke.id, errors: [], outputs: [settle.output] },
            siblings,
          };
        }
        if ("blocked" in settle) {
          return { step: current, blockedSrc: invoke.src };
        }
        if (races(current)) {
          return { step: current, pending: { id: invoke.id, output: settle.output } };
        }
        current = resolveAgentStep(machine, current, invoke.id, settle.output);
        recordState(current);
        continue;
      }
      return { step: current };
    }
    return { step: current };
  };

  // One branch point: advance the node, record its terminal or skip it as a
  // dedupe revisit, and yield its children lazily. The DFS driver visits each
  // child before resuming, so the cap and witness checks between children see
  // the state left by the previous child's subtree.
  // Every variant of every event the active states accept, as an idle wait
  // offers them. A type the explorer table lists as `[]` is skipped and noted.
  const acceptedVariants = (
    snapshot: AnyMachineSnapshot,
    path: ChosenEvent[],
    table: Partial<Record<string, Record<string, unknown>[]>>,
    except?: ReadonlySet<string>,
  ): ChosenEvent[] =>
    arriving(snapshot).flatMap((descriptor) => {
      if (except?.has(descriptor.type)) {
        return [];
      }
      // An explorer table that lists no payload for a type the wait
      // accepts skips that type: the search no longer covers it.
      if (table[descriptor.type]?.length === 0) {
        unexpanded.add(descriptor.type);
        unexplored.push(
          `skipped: payloads lists no ${descriptor.type} at path [${path
            .map((e) => e.type)
            .join(", ")}], so its branches were not explored`,
        );
      }
      return variantsOf(descriptor.type, snapshot, table);
    });

  // `interleave: "pending"`: each accepted event (bar `except`) arriving
  // while an invoke is outstanding, one branch each.
  function* raceBranches(
    settled: AgentStep,
    path: ChosenEvent[],
    depth: number,
    except?: ReadonlySet<string>,
  ): Generator<ExploreNode> {
    const snapshot = settled.snapshot as AnyMachineSnapshot;
    const table = options.payloads?.(snapshot) ?? {};
    for (const event of acceptedVariants(snapshot, path, table, except)) {
      if (witness !== undefined || capped()) {
        return;
      }
      if (!snapshot.can(event)) {
        prunedByGuard++;
        continue;
      }
      const next = transitionAgentStep(machine, settled, event);
      recordState(next);
      yield { step: next, path: [...path, event], depth: depth + 1 };
    }
  }

  const failBranch = (
    settled: AgentStep,
    path: ChosenEvent[],
    depth: number,
    fork: InvokeFork,
    error: unknown,
  ): ExploreNode => {
    const failed = rejectAgentStep(machine, settled, fork.id, error);
    recordState(failed);
    return {
      step: failed,
      path: [
        ...path,
        { type: `xstate.error.actor.${fork.id}`, ...(fork.recordError ? { error } : {}) },
      ],
      depth: depth + 1,
    };
  };
  const doneBranch = (
    settled: AgentStep,
    path: ChosenEvent[],
    depth: number,
    fork: InvokeFork,
    output: unknown,
  ): ExploreNode => {
    const resolved = resolveAgentStep(
      machine,
      settled,
      fork.id,
      fork.isText ? asTextResult(output) : output,
    );
    recordState(resolved);
    return {
      step: resolved,
      path: [...path, { type: `xstate.done.actor.${fork.id}`, output }],
      depth: depth + 1,
    };
  };

  const maxDepthTerminal = (settled: AgentStep, path: ChosenEvent[]): void => {
    pathsExplored++;
    terminals.push({ status: "max-depth", path, state: settled.snapshot.value });
    unexplored.push(`max-depth: stopped at path [${path.map((e) => e.type).join(", ")}]`);
  };

  function* expand({ step, path, depth, delivered }: ExploreNode): Generator<ExploreNode> {
    if (witness !== undefined || capped()) {
      return;
    }
    nodesExpanded++;

    const { step: settled, blockedSrc, hit, fork, siblings, pending } = advance(step);
    if (hit) {
      witness = path;
      return;
    }

    // A key already explored at this depth or shallower has nothing new
    // below it. A shallower revisit explores again: it has more depth left
    // (the depth-first walk can reach a key deep before it reaches it
    // shallow).
    if (options.dedupeBy) {
      const key =
        options.dedupeBy(settled.snapshot as AnyMachineSnapshot) +
        (delivered?.size ? `\u0001${[...delivered].sort().join("\u0001")}` : "");
      const seenAt = visited.get(key);
      if (seenAt !== undefined && seenAt <= depth) {
        return;
      }
      visited.set(key, depth);
    }

    // An outstanding invoke with a single known output, raced by external
    // events: resolving it is no choice, so it keeps the depth.
    if (pending) {
      if (depth >= maxDepth) {
        maxDepthTerminal(settled, path);
        return;
      }
      const resolved = resolveAgentStep(machine, settled, pending.id, pending.output);
      recordState(resolved);
      yield { step: resolved, path, depth };
      yield* raceBranches(settled, path, depth);
      return;
    }

    if (fork) {
      if (depth >= maxDepth) {
        maxDepthTerminal(settled, path);
        return;
      }
      // The failing branches first: they lead explorePaths' terminals, and
      // break ties between equally short canReach witnesses.
      for (const error of fork.errors) {
        if (witness !== undefined || capped()) {
          return;
        }
        yield failBranch(settled, path, depth, fork, error);
      }
      if (!fork.isDecision) {
        for (const output of fork.outputs) {
          if (witness !== undefined || capped()) {
            return;
          }
          yield doneBranch(settled, path, depth, fork, output);
        }
        // Explored children settle in any order, and each child event can
        // reach the parent before any of them settles.
        for (const other of siblings ?? []) {
          for (const error of other.errors) {
            if (witness !== undefined || capped()) {
              return;
            }
            yield failBranch(settled, path, depth, other, error);
          }
          for (const output of other.outputs) {
            if (witness !== undefined || capped()) {
              return;
            }
            yield doneBranch(settled, path, depth, other, output);
          }
        }
        for (const child of [fork, ...(siblings ?? [])]) {
          for (const event of child.events ?? []) {
            if (witness !== undefined || capped()) {
              return;
            }
            const key = `${child.id}\u0000${JSON.stringify(event)}`;
            if (delivered?.has(key) || !(settled.snapshot as AnyMachineSnapshot).can(event)) {
              continue;
            }
            const next = transitionAgentStep(machine, settled, event);
            recordState(next);
            yield {
              step: next,
              path: [...path, event as ChosenEvent],
              depth: depth + 1,
              delivered: new Set([...(delivered ?? []), key]),
            };
          }
        }
        // An explored child that can stall leaves the parent waiting here.
        if (fork.stalls && witness === undefined && !capped()) {
          pathsExplored++;
          terminals.push({ status: "idle", path, state: settled.snapshot.value });
        }
        if (fork.incompleteSrc !== undefined && witness === undefined && !capped()) {
          pathsExplored++;
          terminals.push({
            status: "needs-output",
            path,
            state: settled.snapshot.value,
            missingSrc: fork.incompleteSrc,
          });
        }
        if (interleaving) {
          yield* raceBranches(settled, path, depth);
        }
        return;
      }
      // A decision's success branch is the per-candidate-event fork below, a
      // sibling of the error branch: it spends its own level, not a second one.
      if (witness !== undefined) {
        return;
      }
    }

    if (blockedSrc) {
      pathsExplored++;
      terminals.push({
        status: "needs-output",
        path,
        state: settled.snapshot.value,
        missingSrc: blockedSrc,
      });
      unexplored.push(
        `needs-output: no \`outputs\` entry for src '${blockedSrc}' at path [${path.map((e) => e.type).join(", ")}]`,
      );
      if (interleaving && depth < maxDepth) {
        yield* raceBranches(settled, path, depth);
      }
      return;
    }

    if (settled.done) {
      pathsExplored++;
      terminals.push({ status: "done", path, state: settled.snapshot.value });
      doneOutputs.push((settled.snapshot as AnyMachineSnapshot).output);
      return;
    }

    // A scripted failure with no `onError` in scope errors the machine, as it
    // does in a live run. That is a terminal of its own, not an idle wait.
    if ((settled.snapshot as AnyMachineSnapshot).status === "error") {
      const error = (settled.snapshot as AnyMachineSnapshot & { error?: unknown }).error;
      pathsExplored++;
      terminals.push({ status: "error", path, state: settled.snapshot.value, error });
      failures.push(error);
      return;
    }

    // Branch point: a decision request's candidates, or an idle wait's
    // externally-accepted events — each type expanded to its payload variants.
    const request = settled.requests[0] as AgentStepRequest | undefined;
    const snapshot = settled.snapshot as AnyMachineSnapshot;
    const table = options.payloads?.(snapshot) ?? {};
    // A closed choice's options, rebuilt over the live candidates as a run
    // does but not yet filtered: the loop below prunes them, so guard-rejected
    // options count in `prunedByGuard`.
    const requestOptions =
      request?.kind === "decision" ? acceptedDecisionOptions(request, () => true) : undefined;
    const branchEvents: ChosenEvent[] =
      request?.kind === "decision"
        ? request.events.flatMap((descriptor) =>
            variantsOf(descriptor.type, snapshot, table, requestOptions),
          )
        : acceptedVariants(snapshot, path, table);

    // An idle wait with nothing to accept ends the branch. A decision with
    // nothing to choose does not: it exhausts, below.
    if (branchEvents.length === 0 && request?.kind !== "decision") {
      pathsExplored++;
      terminals.push({ status: "idle", path, state: settled.snapshot.value });
      return;
    }

    if (depth >= maxDepth) {
      pathsExplored++;
      terminals.push({ status: "max-depth", path, state: settled.snapshot.value });
      unexplored.push(`max-depth: stopped at path [${path.map((e) => e.type).join(", ")}]`);
      return;
    }

    let taken = 0;
    for (const event of branchEvents) {
      if (witness !== undefined || capped()) {
        return;
      }
      // Guard legality: a type-legal-but-guard-rejected candidate is a pruned branch.
      if (!snapshot.can(event)) {
        prunedByGuard++;
        continue;
      }
      taken++;
      const next = transitionAgentStep(machine, settled, event);
      recordState(next);
      yield { step: next, path: [...path, event], depth: depth + 1 };
    }

    // An idle wait whose every offered event the guards refuse: a live run
    // would sit here, but more likely the payload table offered nothing the
    // machine accepts. Record the wait and list the types as unexpanded, so
    // the search is not a proof until the table covers an accepted payload.
    if (request?.kind !== "decision" && taken === 0 && witness === undefined && !capped()) {
      pathsExplored++;
      terminals.push({ status: "idle", path, state: settled.snapshot.value });
      const refused = [...new Set(branchEvents.map((event) => event.type))];
      for (const type of refused) unexpanded.add(type);
      unexplored.push(
        `stuck: every offered ${refused.join(", ")} event at path [${path
          .map((e) => e.type)
          .join(", ")}] was refused by the machine's guards; add a payloads entry it accepts`,
      );
      return;
    }

    // A decision none of whose candidates the snapshot takes fails at run time
    // after its retries (or at once, for an empty closed choice) with
    // AgentDecisionExhaustedError, and the invoke's onError runs. Explore that
    // branch the same way; with no onError it errors the machine, an `error`
    // terminal.
    if (request?.kind === "decision" && taken === 0) {
      if (witness !== undefined || capped()) {
        return;
      }
      const exhausted = new AgentDecisionExhaustedError([]);
      exhausted.message =
        `Decision '${request.name ?? request.id}' has no candidate the current snapshot ` +
        "accepts (explored, no model call).";
      const failed = rejectAgentStep(machine, settled, request.id, exhausted);
      recordState(failed);
      yield {
        step: failed,
        path: [...path, { type: `xstate.error.actor.${request.id}` }],
        depth: depth + 1,
      };
    }

    // An event the active states accept but the decision does not offer can
    // arrive while the decision is outstanding.
    if (interleaving && request?.kind === "decision") {
      yield* raceBranches(
        settled,
        path,
        depth,
        new Set(request.events.map((descriptor) => descriptor.type)),
      );
    }
  }

  const root: ExploreNode = { step: initial, path: [], depth: 0 };
  if (witness === undefined && stopWhen) {
    // Breadth-first by path length, so the first witness found is a shortest
    // one.
    const levels: (ExploreNode | undefined)[][] = [[root]];
    search: for (let length = 0; length < levels.length; length++) {
      const level = levels[length] ?? [];
      for (let i = 0; i < level.length; i++) {
        const node = level[i]!;
        // Drop the reference once taken, so a drained level frees its snapshots.
        level[i] = undefined;
        for (const child of expand(node)) {
          child.delivered ??= pruneDelivered(node.delivered, child.step);
          (levels[child.path.length] ??= []).push(child);
        }
        if (witness !== undefined || hitPathCap) {
          break search;
        }
      }
      levels[length] = [];
    }
  } else if (witness === undefined) {
    const visit = (node: ExploreNode): void => {
      for (const child of expand(node)) {
        child.delivered ??= pruneDelivered(node.delivered, child.step);
        visit(child);
      }
    };
    visit(root);
  }

  return {
    report: {
      reachedStates: reachedValues,
      terminals,
      prunedByGuard,
      unexplored,
      pathsExplored,
      hitPathCap,
      unexpandedEvents: [...unexpanded],
      vacuous: [...vacuous],
    },
    witness,
    doneOutputs,
    failures,
    undeliverable: [...undeliverable],
    parentEvents,
  };
}

/**
 * Enumerates a machine's decision and external-event branches to a bounded
 * depth, model-free, and reports which states are reached and how each path
 * terminates. At each decision request it forks one branch per candidate event
 * (guard-rejected candidates are counted in `prunedByGuard`, not explored); a
 * decision with no takeable candidate exhausts as it does live, taking its
 * `onError` (an `error` terminal without one). At an idle wait it forks per
 * externally-accepted event. Text requests and other
 * invokes resolve from `outputs`, a by-src map of outputs to try (a
 * one-element list is a canned output; several fork one branch each), and a
 * missing src halts that branch with a `needs-output` terminal rather than
 * throwing. A src in
 * `errors` forks an extra branch where that invoke is rejected, so states
 * behind an `onError` are explored too.
 *
 * Events are applied as `{ type }` unless a payload is known: `payloads`
 * forks a type once per listed payload, a decide input's own `payloads`
 * become the branch set, and an event schema whose fields are finite (enums,
 * booleans, consts) expands to their product, each optional field also
 * omitted. A type that could not be fully expanded is listed in
 * `unexpandedEvents`, as is a type with no schema whose transition could read
 * the payload (a function transition, guard, `matches`, or context mapper).
 * `dedupeBy` explores each projected snapshot once, which keeps a large
 * payload table tractable.
 *
 * Combinatorics are bounded by `maxDepth` (default 8), `maxPaths` (default
 * 200), and `maxNodes` (default 100,000), the last two reported via
 * `hitPathCap`.
 *
 * @example
 * ```ts
 * const report = await explorePaths(refundMachine, { input: { request: 'x', amount: 5000 } });
 * // report.terminals → both 'refunded' and 'denied'; report.prunedByGuard → 1
 * ```
 */
export async function explorePaths(
  machine: AnyStateMachine,
  options: ExplorePathsOptions = {},
): Promise<AgentPathReport> {
  return explore(machine, options).report;
}

/** The result of a {@link canReach} query. */
export interface CanReachResult {
  /** True when the target state was reached within the exploration bounds. */
  reachable: boolean;
  /** Resolved XState state-node id for a string target. */
  target?: string;
  /** When reachable, the sequence of chosen/applied events that gets there. */
  witness?: ChosenEvent[];
  /**
   * False when the search left a branch it could not rule out unexplored: a
   * cap (`maxPaths` or `maxNodes`) cut it short, a path reached `maxDepth`, a
   * branch stopped `needs-output` on a src with no `outputs` entry, or an event type
   * was not expanded to all its payload variants (`unexpandedEvents` in the
   * {@link explorePaths} report). `reachable: false` is a proof of
   * unreachability only when `complete` is true.
   */
  complete: boolean;
}

/** Thrown when a string reachability target is not a state in the machine. */
export class AgentUnknownStateError extends AgentError {
  readonly target: string;

  constructor(machineId: string, target: string) {
    super("unknown-state", `canReach: machine '${machineId}' has no state matching '${target}'.`);
    this.name = "AgentUnknownStateError";
    this.target = target;
  }
}

function resolveStateTarget(machine: AnyStateMachine, target: string): string {
  const stack = [machine.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === target.replace(/^#/, "") || node.path.join(".") === target) {
      return node.id;
    }
    stack.push(...Object.values(node.states));
  }
  throw new AgentUnknownStateError(machine.id, target);
}

/**
 * Answers "can the machine reach this?" by exploring its branches (a thin
 * wrapper over {@link explorePaths}). The target is either a state path string
 * (`snapshot.matches(...)` semantics) or a snapshot predicate — the predicate
 * form checks any property (a context invariant, a tag, a state+context
 * combination) without reifying a sentinel state for it. Returns
 * `{ reachable: true, witness }` with the event sequence that reaches it, or
 * `{ reachable: false }`. Check `complete` before treating `reachable: false`
 * as a proof: it is false when a cap or `maxDepth` cut exploration short, a
 * branch needed an `outputs` entry it did not have, or an event's payloads were
 * not all tried.
 *
 * @example
 * ```ts
 * const { reachable, witness } = await canReach(refundMachine, 'denied', { input: { request: 'x', amount: 5000 } });
 * // reachable → true; witness → [{ type: 'NEEDS_REVIEW' }, { type: 'DENY' }]
 * ```
 *
 * @example Predicate target — a violation property, no sentinel state needed
 * ```ts
 * const violation = await canReach(
 *   refundMachine,
 *   (snapshot) => snapshot.matches('issued') && !snapshot.context.approved,
 *   { input: { amount: 5000 } },
 * );
 * // violation.reachable → false is the safety proof
 * ```
 */
export async function canReach(
  machine: AnyStateMachine,
  target: CanReachTarget,
  options: ExplorePathsOptions = {},
): Promise<CanReachResult> {
  const resolvedTarget =
    typeof target === "string" ? resolveStateTarget(machine, target) : undefined;
  const stopWhen =
    typeof target === "function"
      ? target
      : (snapshot: AnyMachineSnapshot): boolean =>
          snapshot.nodes.some((node) => node.id === resolvedTarget);
  const { witness, report } = explore(machine, options, stopWhen);
  if (witness !== undefined) {
    return {
      reachable: true,
      witness,
      complete: true,
      ...(resolvedTarget ? { target: resolvedTarget } : {}),
    };
  }
  const complete = isExplorationComplete(report);
  return { reachable: false, complete, ...(resolvedTarget ? { target: resolvedTarget } : {}) };
}

/**
 * Whether an `explorePaths` report covers every path: no cap cut it short,
 * every payload was expanded, and every branch ended on its own. `done`,
 * `idle`, and `error` end a branch the machine itself ended; any other
 * terminal stopped a branch the search did not explore.
 * @internal
 */
export function isExplorationComplete(report: AgentPathReport): boolean {
  return (
    !report.hitPathCap &&
    report.unexpandedEvents.length === 0 &&
    report.terminals.every(
      (terminal) =>
        terminal.status === "done" || terminal.status === "idle" || terminal.status === "error",
    )
  );
}
