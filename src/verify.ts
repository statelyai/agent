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
  getInitialMicrosteps,
  getMicrosteps,
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
import { isTextLogic, type AgentCallUsage, type AgentTextResult } from "./text-logic.js";
import type { AgentMessage } from "./types.js";
import { AGENT_USAGE_EVENT_TYPE, type AgentUsageEvent } from "./usage.js";
import { executorBoundLogics, getRegisteredAgentExecutionOptions } from "./internal/registry.js";
import {
  doneEvent,
  errorEvent,
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
   * Skip one check at one state: `{ code: "invoke-without-on-error", path:
   * "listening" }` for a callback bridge that cannot fail. `path` is the
   * diagnostic's `path`.
   */
  ignore?: Array<{ code: AgentLintDiagnostic["code"]; path: string }>;
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
  const ignored = options.ignore ?? [];
  const diagnostics = LINT_CHECKS.flatMap((check) => check(ctx)).filter(
    (d) =>
      !disabled.has(d.code) &&
      !ignored.some((entry) => entry.code === d.code && entry.path === d.path),
  );

  if (options.throw) {
    const failing = options.warnings
      ? diagnostics
      : diagnostics.filter((d) => d.severity === "error");
    if (failing.length > 0) {
      throw new AgentLintError(machine.id, failing);
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
  /** Unique per started actor, so a child restarted under the same id is a new one. */
  sessionId?: string;
}

function pendingInvokes(step: AgentStep): PendingInvoke[] {
  const out: PendingInvoke[] = [];
  const children = (step.snapshot.children ?? {}) as Record<string, ChildRef | undefined>;
  for (const metadata of getPendingInvokes(step.snapshot as AnyMachineSnapshot)) {
    // XState leaves `src` undefined for inline logic; key it by the invoke id.
    const src = typeof metadata.src === "string" ? metadata.src : metadata.id;
    if (typeof src === "string") {
      const ref = children[metadata.id];
      out.push({
        id: metadata.id,
        src,
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

// A usage event to deliver before a completion, or `undefined` for a value the
// machine refuses (a run drops it).
type UsageChoice = AgentUsageEvent | undefined;

// Envelopes made by `textOutput`.
const textOutputs = new WeakSet<object>();

/**
 * Marks a canned text-request output for {@link explorePaths},
 * {@link canReach}, or {@link simulateAgent} as the whole
 * `{ result, messages }` envelope the invoke resolves with, so a machine that
 * reads `output.messages` sees them. A plain canned value is the `result`,
 * with `messages: []`.
 *
 * @example
 * ```ts
 * await explorePaths(machine, {
 *   outputs: { reply: [textOutput('hi', { messages: [{ role: 'assistant', content: 'hi' }] })] },
 * });
 * ```
 */
export function textOutput<TResult>(
  result: TResult,
  options: { messages?: AgentMessage[] } = {},
): AgentTextResult<TResult> {
  const envelope = { result, messages: options.messages ?? [] };
  textOutputs.add(envelope);
  return envelope;
}

// A scripted text value is the bare `result`; the invoke resolves to the same
// `{ result, messages }` a live executor produces, with no messages, unless
// `textOutput` made it the whole envelope.
function asTextResult(value: unknown): AgentTextResult {
  return isRecord(value) && textOutputs.has(value)
    ? (value as unknown as AgentTextResult)
    : { result: value, messages: [] };
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
  /**
   * Path cap per search before it stops (reported via `hitPathCap`). Default
   * 200. Each explored child search has its own; see `budget` for a total.
   */
  maxPaths?: number;
  /**
   * Branch points expanded per search before it stops (reported via
   * `hitPathCap`). Default 100,000. It bounds work and memory where
   * `maxPaths` cannot: a loopy machine expands many nodes per terminal.
   * Each explored child search has its own; see `budget` for a total.
   */
  maxNodes?: number;
  /**
   * Limits on the whole call. When one runs out, the search stops cleanly:
   * the report is `partial` and not `complete`, and `unexplored` notes
   * `budget-exhausted: nodes` or `budget-exhausted: ms` with the counts so
   * far. {@link canReach} returns what it found, with `complete: false`.
   */
  budget?: {
    /**
     * Branch points expanded in total: the top-level search and every child
     * search it triggers (`children: "explore"`). A cached child outcome
     * counts once, when it is computed; a cache hit costs nothing. Default
     * 250,000; raise it explicitly for a bigger machine.
     */
    nodes?: number;
    /**
     * Wall-clock milliseconds from the start of the call, checked at each
     * branch point, in child searches too. A slow `payloads` or guard call
     * is not interrupted: the check runs between them.
     */
    ms?: number;
    /**
     * Explored-child outcomes kept for reuse per search, keyed by logic, src,
     * and input; the least recently used is evicted first. An evicted child
     * is explored again when reached, and counts again. Default 64.
     */
    childCache?: number;
  };
  /**
   * Every output to try per src: a text request's src (the
   * `setupAgent({ requests })` key, or `agent.generateText`/`agent.streamText`)
   * or any other invoked actor's src. A one-element list is a canned output,
   * reused every time that src is reached; a text request resolves with it as
   * its `result` (`{ result, messages: [] }`), or with the whole envelope a
   * {@link textOutput} value carries. A src with two or more outputs
   * forks one branch per output (plus the `errors` branch when the src is
   * listed there too), so a machine whose `onDone` branches on the output is
   * explored down every arm. Each fork counts against `maxDepth`, and each
   * forked branch records `{ type: 'xstate.done.actor', actorId, output }` in the
   * path. A src with no entry (and no `errors` entry) halts that branch with a
   * `needs-output` terminal. An empty list, `[]`, is a src that never settles
   * (a callback bridge, a long-lived listener): its invoke stays pending and
   * only events move the machine on.
   */
  outputs?: Record<string, unknown[]>;
  /**
   * A canned failure per src, keyed like `outputs`. A src listed here
   * forks an extra branch at that invoke, where the invoke is rejected and the
   * machine takes its `onError` — so states reachable only through a failure
   * are explored. When the src also has an output, both branches are explored;
   * when it has only an error, only the failing one is. Each fork counts
   * against `maxDepth`, and the failing branch records
   * `{ type: 'xstate.error.actor', actorId }` in the path.
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
   * in any order, can reach the parent before it settles. While an
   * explored child is pending, it and every other pending invoke or text
   * request settle in any order; other combinations are not
   * enumerated beyond `interleave`. A child receives only the events its
   * parent forwards or the host sends it, so the child search offers
   * external events only for the types
   * {@link ExplorePathsOptions.childEvents} lists for its src (none by
   * default). A child wait that accepts an event not listed leaves the
   * child search incomplete.
   *
   * `"coupled"`: each child machine is stepped inside the parent's search,
   * one move at a time, so a witness is a run the machines can make
   * together. A child's events reach the parent in the order the child sends
   * them on its own path, its output follows them, and an event the parent
   * sends it (`sendTo`/`forwardTo`) is applied to the child's current state,
   * in order, instead of arriving at any time. `childEvents` then lists only
   * the types the host sends the child directly; the parent's own sends need
   * no entry. A child's pending work and the events that can reach it race
   * as with `interleave: "pending"`. Child moves count against `maxDepth`
   * like the parent's, and appear on a path with `actor` set to the child's
   * id (the child's own events, its choices, its settled work); the events
   * it sends the parent appear as the parent receives them. With `dedupeBy`,
   * each child's state is part of the key. A target predicate and `dedupeBy`
   * read each child's explored state through `snapshot.children[id]
   * .getSnapshot()`. More precise and often cheaper
   * than `"explore"` for authored child machines; `"explore"` remains the
   * over-approximation for a child whose behavior you do not want to trust.
   */
  children?: "outputs" | "explore" | "coupled";
  /**
   * With `children: "explore"`: per child src, the event types that can
   * reach the child at its waits (the ones the parent forwards with
   * `sendTo`/`forwardTo`, or the host sends it directly). Unlisted types are
   * never offered to the child. With `children: "coupled"`: only the types
   * the host sends the child directly; the parent's sends are delivered as
   * the parent makes them.
   */
  childEvents?: Record<string, string[]>;
  /**
   * The event types the host can send the machine at its waits (and, with
   * `interleave: "pending"`, while work is pending). Default: every type the
   * active states accept. List them when some accepted types only ever come
   * from the machine's own children (a child's status events), so the search
   * does not offer them as if the host sent them.
   */
  hostEvents?: string[];
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
  /**
   * Armed timers: `after` delays, state and invoke `timeout`s, and delayed
   * `enq.raise` events (`snapshot.timers` entries the machine delivers to
   * itself). `"fire"` (default): each armed timer whose event the active
   * states take is an event that may arrive, offered where host events are
   * (at idle waits, and while work is pending under `interleave: "pending"`),
   * in any order regardless of its delay. A fired timer records its event in
   * the path, e.g. `{ type: 'xstate.after', delay: 1000, stateId: 'm.waiting' }`.
   * `"ignore"`: timers never fire; a wait with an armed timer adds an
   * `unexplored` note and lists the timer's event type in `unexpandedEvents`,
   * so the report is not complete.
   */
  timers?: "fire" | "ignore";
  /**
   * Usage values to try per text-request src. When a request with an entry
   * settles at the root and the active states take `@agent.usage`, the
   * search delivers `{ type: '@agent.usage', kind: 'text', id, src, model,
   * name?, usage }` to the root immediately before the request's completion,
   * as a run does (a value the active states refuse is dropped, as a run drops it): once per listed value, each a fork that counts against
   * `maxDepth` and records the usage event in the path. One value with one
   * canned output is no fork, but its usage event is still recorded. No `budget`
   * field is sent. A settling request with no entry while a usage transition
   * is active lists `@agent.usage` in `vacuous`. With `children:
   * "coupled"`, a child's text request forks once per value and its usage
   * event goes to the root, which takes or drops it the same way (no
   * `vacuous` entry). Requests inside other children, and decisions, deliver
   * no usage.
   */
  usage?: Record<string, AgentCallUsage[]>;
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
  /** For `done`: the machine's output (absent when it has none). */
  output?: unknown;
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
  /** True when `maxPaths` or `maxNodes` cut exploration short (report is partial). */
  hitPathCap: boolean;
  /**
   * True when a cap or the `budget` cut exploration short: `hitPathCap`, or
   * a `budget-exhausted` note in `unexplored`.
   */
  partial: boolean;
  /**
   * True when the report covers every path: not `partial`, every payload
   * expanded, and every branch ended `done`, `idle`, or `error`.
   */
  complete: boolean;
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
   * payload-reading logic was exercised with no payload at all. Also lists
   * `@agent.usage` when a text request settled while a usage transition was
   * active and `usage` had no entry for its src. Data only; it does not
   * change completeness.
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
  /**
   * `usage` events to deliver before each output, one branch per entry;
   * `undefined` is a value the machine refuses, so nothing is delivered.
   */
  usage?: UsageChoice[];
  /** An explored child's events to its parent, each delivered at most once per path. */
  events?: EventObject[];
  /** The child actor's session, keying its delivered events. */
  session?: string;
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

// Default cap on branch points expanded across one call, child searches
// included (`budget.nodes`). Well above every search in this repo's tests
// and examples (the largest is under 50,000).
const DEFAULT_BUDGET_NODES = 250_000;

// Default cap on explored-child outcomes kept per search (`budget.childCache`).
const DEFAULT_CHILD_CACHE = 64;

// The budget one top-level call and every child search it triggers draw on.
interface SearchBudget {
  /** Branch points expanded so far, child searches included. */
  nodes: number;
  maxNodes: number;
  started: number;
  deadline: number | undefined;
  exhausted?: "nodes" | "ms";
}

function startBudget(budget: ExplorePathsOptions["budget"]): SearchBudget {
  const started = Date.now();
  return {
    nodes: 0,
    maxNodes: budget?.nodes ?? DEFAULT_BUDGET_NODES,
    started,
    deadline: budget?.ms === undefined ? undefined : started + budget.ms,
  };
}

// A stable id per child logic, for the child-outcome cache key.
const logicIds = new WeakMap<object, number>();
let nextLogicId = 0;
function logicId(logic: object): number {
  let id = logicIds.get(logic);
  if (id === undefined) {
    id = nextLogicId++;
    logicIds.set(logic, id);
  }
  return id;
}

function isMachineLogic(logic: unknown): logic is AnyStateMachine {
  return (
    isRecord(logic) &&
    "root" in logic &&
    "config" in logic &&
    typeof logic["transition"] === "function"
  );
}

// Appends a value unless an equal one is already in the list: equal by JSON
// (an Error by name and message), first seen first. A value with no JSON is
// always appended.
function pushDistinct<T>(values: T[], seen: Set<string>, value: T): void {
  let key: string;
  try {
    key =
      value instanceof Error
        ? `Error:${value.name}:${value.message}`
        : (JSON.stringify(value) ?? String(value));
  } catch {
    values.push(value);
    return;
  }
  if (!seen.has(key)) {
    seen.add(key);
    values.push(value);
  }
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

// What a coupled child's effects send beyond it, in effect order: events to
// `parent`, and events to any other actor that is not one of `own` (its own
// children) for its parent to route.
function outboundOf(effects: unknown, parent: unknown, own: unknown): Outbound[] {
  if (parent === undefined || !Array.isArray(effects)) {
    return [];
  }
  const children = Object.entries(isRecord(own) ? own : {});
  const out: Outbound[] = [];
  for (const effect of effects) {
    if (
      !isRecord(effect) ||
      effect["type"] !== "@xstate.sendTo" ||
      !isRecord(effect["event"]) ||
      typeof effect["event"]["type"] !== "string"
    ) {
      continue;
    }
    const target = effect["target"];
    const event = effect["event"] as EventObject;
    if (target === parent) {
      out.push({ event });
    } else if (!children.some(([id, ref]) => ref === target || id === target)) {
      out.push({ route: { target, event } });
    }
  }
  return out;
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

// One event of a path, linked to the one before it. A node keeps this parent
// pointer, not a copy of its whole path.
interface PathLink {
  event: ChosenEvent;
  prev: PathLink | undefined;
  length: number;
}

function extend(prev: PathLink | undefined, event: ChosenEvent): PathLink {
  return { event, prev, length: (prev?.length ?? 0) + 1 };
}

function pathOf(link: PathLink | undefined): ChosenEvent[] {
  const path = Array.from<ChosenEvent>({ length: link?.length ?? 0 });
  for (let at = link; at; at = at.prev) path[at.length - 1] = at.event;
  return path;
}

function pathTypes(link: PathLink | undefined): string {
  return pathOf(link)
    .map((event) =>
      typeof event.actorId === "string" ? `${event.type}(${event.actorId})` : event.type,
    )
    .join(", ");
}

// A pending branch point: the step to advance, the events that led to it, and
// how many branch points it has spent against `maxDepth`.
interface ExploreNode {
  step: AgentStep;
  /** The last event on the path here; the path itself is rebuilt only for a terminal or witness. */
  path: PathLink | undefined;
  depth: number;
  /** Child-to-parent events already delivered on this path (`<child session>\u0000<event JSON>`). */
  delivered?: ReadonlySet<string> | undefined;
  /** `children: "coupled"`: each live child machine's state, by actor session. */
  kids?: KidsMap | undefined;
  /** In a coupled child's search: what this move sent beyond the child, in order. */
  outbound?: Outbound[] | undefined;
}

// `children: "coupled"`: the live child machines a node carries, by actor session.
type KidsMap = ReadonlyMap<string, KidState>;

// One coupled child machine, stepped inside its parent's search.
interface KidState {
  /** The invoke or spawn id its parent knows it by. */
  id: string;
  src: string;
  /** Steps this child (shared by every child of the same logic and src). */
  engine: ChildStepper;
  step: AgentStep;
  /** The parent actor its `sendTo(parent, …)` effects target. */
  parent: unknown;
  /** Its own coupled children. */
  kids: KidsMap | undefined;
}

// One move a coupled child can make from its current state.
interface ChildMove {
  step: AgentStep;
  /** What the child did, in order (its events, choices, settled work). */
  path: ChosenEvent[];
  depth: number;
  kids: KidsMap | undefined;
  /**
   * What the move sent beyond the child, in effect order: events to its
   * parent, and events to other actors (a sibling) for the parent to route.
   */
  outbound: Outbound[];
}

// An event a coupled child sent an actor it does not hold: its parent routes it.
interface Routed {
  target: unknown;
  event: EventObject;
}

// A child machine's search, run one move at a time by its parent.
interface ChildStepper {
  /** The moves a child can make, and the reasons a branch could not be followed. */
  moves(
    kid: KidState,
    depth: number,
  ): {
    moves: ChildMove[];
    blocked: Array<{ status: AgentPathTerminal["status"]; missingSrc?: string }>;
    /** The child had no work pending: every move is an event the host sent it. */
    idle: boolean;
  };
  /** Applies an event the parent sends the child. */
  deliver(kid: KidState, event: EventObject): Settled;
  /** Delivers what a just-started child's entry sent its own children. */
  prime(kid: KidState): Settled;
  /** No work pending in the child or in any of its own children. */
  quiet(kid: KidState): boolean;
  /** A key for the child's state, for `dedupeBy`. */
  stateKey(kid: KidState): string;
  unexpanded: ReadonlySet<string>;
  vacuous: ReadonlySet<string>;
}

// What a child sent beyond itself: an event to its parent, one to route, or
// a request's usage event for the root.
type Outbound = { event: EventObject } | { route: Routed } | { usage: AgentUsageEvent };

// What a coupled pump delivers next: an event to the machine, one to route, or a child that settled.
type Delivery = Outbound | { settle: string };

// A coupled child after a delivery, and what it sent on the way.
interface Settled {
  step: AgentStep;
  kids: KidsMap | undefined;
  outbound: Outbound[];
  overflow?: boolean;
}

// Cap on deliveries in one coupled pump (a parent and children sending to each other).
const MAX_PUMP = 1_000;

// An explored child starts from its pure-transition actor's snapshot, which
// keeps the parent link `sendTo(parent, …)` needs, with the requests a fresh
// start of the same logic and input discovers.
function childStartStep(machine: AnyStateMachine, input: unknown, ref?: ChildRef): AgentStep {
  const fresh = initialAgentStep(machine, input);
  const snapshot = ref?.getSnapshot?.();
  return withLiveRequests(
    isRecord(snapshot) && snapshot["status"] === "active"
      ? { ...fresh, snapshot: snapshot as unknown as AnyMachineSnapshot }
      : fresh,
  );
}

// A request is classified by the logic the machine actually runs, as at run
// time: a src registered as a text or decision request but provided a plain
// actor (`.provide({ actors })`) is a plain invoke.
function withLiveRequests(step: AgentStep): AgentStep {
  if (step.requests.length === 0) {
    return step;
  }
  const children = (step.snapshot.children ?? {}) as Record<
    string,
    { logic?: unknown } | undefined
  >;
  const requests = step.requests.filter((request) => {
    const logic = children[request.id]?.logic;
    return logic === undefined || isTextLogic(logic) || isDecisionLogic(logic);
  });
  return requests.length === step.requests.length ? step : { ...step, requests };
}

// Whether the active states take `@agent.usage`: an explicit transition or a
// `'*'` wildcard, as the runtime decides whether to deliver it.
function declaresUsageTransition(snapshot: AnyMachineSnapshot): boolean {
  return getNextTransitions(snapshot).some(
    (transition) => transition.eventType === AGENT_USAGE_EVENT_TYPE || transition.eventType === "*",
  );
}

// The key a child's delivered events are recorded under: its actor session,
// so a child restarted under the same id is a new sender.
function childSession(id: string, ref: ChildRef | undefined): string {
  return typeof ref?.sessionId === "string" ? ref.sessionId : id;
}

// `children: "coupled"`: the snapshot a predicate sees, whose child refs'
// `getSnapshot()` return each coupled child's explored state (its own
// coupled children likewise), not the state the child actor started in.
function withKidSnapshots(
  snapshot: AnyMachineSnapshot,
  kids: KidsMap | undefined,
): AnyMachineSnapshot {
  if (!kids || kids.size === 0) {
    return snapshot;
  }
  const children = { ...(snapshot.children ?? {}) } as Record<string, ChildRef | undefined>;
  let changed = false;
  for (const [id, ref] of Object.entries(children)) {
    const kid = kids.get(childSession(id, ref));
    if (!kid || !ref) continue;
    const kidSnapshot = withKidSnapshots(kid.step.snapshot as AnyMachineSnapshot, kid.kids);
    children[id] = Object.assign(Object.create(ref) as ChildRef, {
      getSnapshot: () => kidSnapshot,
    });
    changed = true;
  }
  if (!changed) {
    return snapshot;
  }
  return Object.assign(
    Object.create(Object.getPrototypeOf(snapshot)) as AnyMachineSnapshot,
    snapshot,
    { children },
  );
}

// Drops delivered child events whose child actor is no longer running.
function pruneDelivered(
  delivered: ReadonlySet<string> | undefined,
  step: AgentStep,
): ReadonlySet<string> | undefined {
  if (delivered === undefined || delivered.size === 0) {
    return delivered;
  }
  const children = (step.snapshot.children ?? {}) as Record<string, ChildRef | undefined>;
  const running = new Set(Object.entries(children).map(([id, ref]) => childSession(id, ref)));
  const kept = [...delivered].filter((key) => running.has(key.slice(0, key.indexOf("\u0000"))));
  return kept.length === delivered.size ? delivered : new Set(kept);
}

// Whether `node` or a state under it is only ever passed through: one with
// an `always` transition, or a choice state.
function hasTransientStates(node: unknown): boolean {
  const visit = (node: unknown): boolean => {
    if (!isRecord(node)) {
      return false;
    }
    if (node["type"] === "choice" || (Array.isArray(node["always"]) && node["always"].length > 0)) {
      return true;
    }
    return Object.values(isRecord(node["states"]) ? node["states"] : {}).some(visit);
  };
  return visit(node);
}

// The ids of the states under `node` (itself included) only ever passed through.
function transientStateIds(node: unknown, ids: string[] = []): string[] {
  if (!isRecord(node)) {
    return ids;
  }
  if (node["type"] === "choice" || (Array.isArray(node["always"]) && node["always"].length > 0)) {
    ids.push(String(node["id"]));
  }
  for (const child of Object.values(isRecord(node["states"]) ? node["states"] : {})) {
    transientStateIds(child, ids);
  }
  return ids;
}

function hasParallelStates(node: unknown): boolean {
  return (
    isRecord(node) &&
    (node["type"] === "parallel" ||
      Object.values(isRecord(node["states"]) ? node["states"] : {}).some(hasParallelStates))
  );
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
  // Read states passed through within a step: for `explorePaths`'
  // `reachedStates` and a `canReach` state target that can be one. An
  // explored child, whose states are not reported, skips it.
  trackTransits = nesting === 0 && hasTransientStates(machine.root),
  // Shared by the top-level search and every child search it triggers.
  budget: SearchBudget = startBudget(options.budget),
  // `children: "coupled"`: build a child's stepper instead of searching.
  stepping = false,
): {
  report: AgentPathReport;
  witness?: ChosenEvent[];
  doneOutputs: unknown[];
  failures: unknown[];
  undeliverable: string[];
  parentEvents: EventObject[];
  /** Some path ended `idle`. */
  stalls: boolean;
  /** Some path ended short of `done`, `idle`, or `error`. */
  unfinished: boolean;
  /** With `stepping`: the child's stepper. */
  stepper?: ChildStepper;
} {
  const maxDepth = options.maxDepth ?? 8;
  const maxPaths = options.maxPaths ?? 200;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const errorScript = options.errors ?? {};
  const outputScript = options.outputs ?? {};
  const coupled = options.children === "coupled";
  const timerMode = options.timers ?? "fire";
  // A run delivers usage to its root, so `usage` covers the root's own
  // requests and those of its coupled children (sent up to the root).
  const usageScript = nesting === 0 || stepping ? (options.usage ?? {}) : undefined;
  // In a coupled child: the usage event a settled step sends the root.
  const charges = new WeakMap<AgentStep, AgentUsageEvent>();
  // A coupled child's pending work always races what can reach it.
  const interleaving = options.interleave === "pending" || stepping;
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

  // States the machine passes through within one step (an `always` hop, a
  // choice state) never settle, so they are read off the step's microsteps.
  // Only machines that have such a state pay for it.
  // Once every such state has been passed through, a further pass adds
  // nothing, so the microsteps stop (unless parallel regions make each
  // combination a distinct value).
  const unseenTransient = new Set(trackTransits ? transientStateIds(machine.root) : []);
  const keepTracking = trackTransits && hasParallelStates(machine.root);
  const transits = new WeakMap<AgentStep, AnyMachineSnapshot[]>();
  const withTransits = (
    next: AgentStep,
    microsteps: () => Array<[AnyMachineSnapshot, ...unknown[]]>,
  ): AgentStep => {
    next = withLiveRequests(next);
    if (unseenTransient.size > 0 || keepTracking) {
      const passed = microsteps()
        .slice(0, -1)
        .map(([snapshot]) => snapshot);
      for (const snapshot of passed) {
        for (const node of snapshot.nodes) unseenTransient.delete(node.id);
      }
      transits.set(next, passed);
    }
    return next;
  };
  const resolveStep = (prev: AgentStep, id: string | { id: string }, output: unknown) =>
    withTransits(resolveAgentStep(machine, prev, id, output), () =>
      getMicrosteps(machine, prev.snapshot, doneEvent(prev.snapshot, id, output) as never),
    );
  const rejectStep = (prev: AgentStep, id: string | { id: string }, error: unknown) =>
    withTransits(rejectAgentStep(machine, prev, id, error), () =>
      getMicrosteps(machine, prev.snapshot, errorEvent(prev.snapshot, id, error) as never),
    );
  const transitionStep = (prev: AgentStep, event: EventObject) =>
    withTransits(transitionAgentStep(machine, prev, event as never), () =>
      getMicrosteps(machine, prev.snapshot, event as never),
    );
  // An invoke's completion, preceded by its request's `usage` event when it
  // has one. A usage transition that leaves the invoking state cancels the
  // invoke: its completion never arrives (`completed: false`).
  const settleStep = (
    prev: AgentStep,
    id: string,
    output: unknown,
    usage?: AgentUsageEvent,
  ): { step: AgentStep; completed: boolean } => {
    if (!usage) {
      return { step: resolveStep(prev, id, output), completed: true };
    }
    // A coupled child's usage goes to the root, which takes it or drops it.
    if (stepping) {
      const resolved = resolveStep(prev, id, output);
      charges.set(resolved, usage);
      return { step: resolved, completed: true };
    }
    // The invoke's actor session, so one restarted under the same id (a
    // re-entered state) is a new invoke this completion never reaches.
    const sessionOf = (step: AgentStep): string | undefined => {
      const invoke = pendingInvokes(step).find((pending) => pending.id === id);
      return invoke && childSession(id, invoke.ref);
    };
    const session = sessionOf(prev);
    const charged = transitionStep(prev, usage);
    if (session === undefined || sessionOf(charged) !== session) {
      return { step: charged, completed: false };
    }
    const resolved = resolveStep(charged, id, output);
    // The snapshot between the two is passed through, for `stopWhen` and `reachedStates`.
    transits.set(resolved, [
      ...(transits.get(charged) ?? []),
      charged.snapshot as AnyMachineSnapshot,
      ...(transits.get(resolved) ?? []),
    ]);
    return { step: resolved, completed: true };
  };
  // The usage events to deliver before a root text request settles, one per
  // `usage` value, when the active states take `@agent.usage`. A value the
  // machine refuses (`can` is false) is dropped, as a run drops it: one
  // `undefined` entry stands for all of them. A settling request with no
  // entry there leaves the usage transition vacuous.
  // In a coupled child, every value is a branch: the root gates it on delivery.
  const usageFor = (step: AgentStep, request: AgentStepRequest): UsageChoice[] | undefined => {
    if (
      !usageScript ||
      request.kind !== "text" ||
      (!stepping && !declaresUsageTransition(step.snapshot as AnyMachineSnapshot))
    ) {
      return undefined;
    }
    const values = usageScript[request.src];
    if (!values?.length) {
      if (!stepping) vacuous.add(AGENT_USAGE_EVENT_TYPE);
      return undefined;
    }
    const snapshot = step.snapshot as AnyMachineSnapshot;
    const events: AgentUsageEvent[] = values.map((usage) => ({
      type: AGENT_USAGE_EVENT_TYPE,
      kind: "text",
      id: request.id,
      src: request.src,
      model: request.input.model,
      ...(request.input.name !== undefined ? { name: request.input.name } : {}),
      usage,
    }));
    if (stepping) {
      return events;
    }
    const accepted: UsageChoice[] = events.filter((event) => snapshot.can(event as never));
    if (accepted.length === 0) {
      return undefined;
    }
    return accepted.length < events.length ? [...accepted, undefined] : accepted;
  };
  // `stopWhen` on the settled snapshot or any state passed through to reach it.
  // With `children: "coupled"`, each snapshot shows the coupled children's
  // explored state (`kids`).
  const stops = (step: AgentStep, kids?: KidsMap): boolean =>
    stopWhen !== undefined &&
    (stopWhen(withKidSnapshots(step.snapshot as AnyMachineSnapshot, kids)) ||
      (transits.get(step)?.some((snapshot) => stopWhen(withKidSnapshots(snapshot, kids))) ??
        false));

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
      note(() =>
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
  // (logic, src, input) while its outcome stays in the cache, the least
  // recently used entry evicted first. Its unexpanded and vacuous types join
  // this report's.
  const childCache = new Map<string, ChildOutcome>();
  const childCacheSize = options.budget?.childCache ?? DEFAULT_CHILD_CACHE;
  const exploreChild = (
    src: string,
    logic: AnyStateMachine,
    input: unknown,
    ref?: ChildRef,
  ): ChildOutcome => {
    if (nesting >= MAX_CHILD_NESTING) {
      note(
        () =>
          `child: src '${src}' is nested deeper than ${MAX_CHILD_NESTING} machines; not explored`,
      );
      return { outputs: [], errors: [], events: [], stalls: false, complete: false };
    }
    let key: string | undefined;
    try {
      // Keyed by src too: `childEvents` is per src.
      key = `${logicId(logic)}\u0000${src}\u0000${JSON.stringify(input) ?? "undefined"}`;
    } catch {
      key = undefined;
    }
    const cached = key === undefined ? undefined : childCache.get(key);
    if (cached) {
      // Most recently used last.
      childCache.delete(key!);
      childCache.set(key!, cached);
      return cached;
    }
    // Only the outcome outlives this call: the child's search state is
    // released once its outputs are collected.
    const child = explore(
      logic,
      { ...options, input },
      undefined,
      nesting + 1,
      new Set(options.childEvents?.[src] ?? []),
      ref,
      false,
      budget,
    );
    if (child.undeliverable.length > 0) {
      note(
        () =>
          `child: src '${src}' waits for ${child.undeliverable.join(", ")}, which childEvents does not list as reaching it; list each event the parent forwards`,
      );
    }
    for (const type of child.report.unexpandedEvents) unexpanded.add(type);
    for (const type of child.report.vacuous) vacuous.add(type);
    const outcome: ChildOutcome = {
      outputs: child.doneOutputs,
      errors: child.failures,
      events: child.parentEvents,
      stalls: child.stalls,
      complete:
        !child.unfinished &&
        isExplorationComplete(child.report) &&
        child.undeliverable.length === 0,
    };
    if (!outcome.complete) {
      note(
        () =>
          `child: exploring src '${src}' was incomplete, so its outputs may be partial; add an outputs entry for it`,
      );
    }
    if (key !== undefined && childCacheSize > 0) {
      childCache.set(key, outcome);
      if (childCache.size > childCacheSize) {
        childCache.delete(childCache.keys().next().value!);
      }
    }
    return outcome;
  };

  // How a text request or scripted invoke settles: resolved straight through
  // with its single output, forked (an `errors` entry, several `outputs`, or
  // an explored child's outcomes), or blocked on a missing output.
  // `outputs: { src: [] }`: the src never settles (a callback bridge or a
  // long-lived listener), so its invoke stays pending and only events move on.
  const neverSettles = (src: string): boolean => outputScript[src]?.length === 0 && !errorsFor(src);
  const settleFor = (
    id: string,
    src: string,
    isText: boolean,
    invoke?: PendingInvoke,
    usage?: UsageChoice[],
  ): { fork: InvokeFork } | { output: unknown } | { blocked: true } | { never: true } => {
    const failures = errorsFor(src);
    if (neverSettles(src)) {
      return { never: true };
    }
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
          session: childSession(id, invoke.ref),
          stalls: child.stalls,
          ...(child.complete ? {} : { incompleteSrc: src }),
        },
      };
    }
    const outputs = outputScript[src] ?? [];
    if (failures || outputs.length > 1 || (outputs.length === 1 && (usage?.length ?? 0) > 1)) {
      return {
        fork: {
          id,
          errors: failures?.values ?? [],
          recordError: failures?.record ?? false,
          outputs,
          isText,
          ...(usage ? { usage } : {}),
        },
      };
    }
    return outputs.length === 1 ? { output: outputs[0] } : { blocked: true };
  };

  // A pending invoke `children: "explore"` explores rather than scripts.
  const isExploredChild = (invoke: PendingInvoke): boolean =>
    (options.children === "explore" || coupled) &&
    !(invoke.src in outputScript) &&
    !errorsFor(invoke.src) &&
    isMachineLogic(invoke.logic);
  // Every settlement that can come next while an explored child is pending:
  // text requests, scripted invokes, and the children themselves, each a fork
  // of its own, so whichever settles first (and leaves the state) is a branch.
  // Undefined when there is at most one: the usual one-at-a-time advance.
  // A blocked one (no `outputs` entry) is no fork, but settling first is
  // still a branch the search cannot follow: it ends `needs-output`.
  const concurrentForks = (
    step: AgentStep,
  ):
    | {
        forks: InvokeFork[];
        blocked: string[];
        decisions: AgentStepRequest[];
        /** `children: "coupled"`: the child machines stepped beside them. */
        kids?: PendingInvoke[];
      }
    | undefined => {
    if (options.children !== "explore" && !coupled) {
      return undefined;
    }
    const invokes = pendingInvokes(step);
    if (!invokes.some(isExploredChild)) {
      return undefined;
    }
    const kids = coupled ? invokes.filter(isExploredChild) : [];
    const blocked: string[] = [];
    const asFork = (
      settle: ReturnType<typeof settleFor>,
      id: string,
      src: string,
      isText: boolean,
      usage?: UsageChoice[],
    ): InvokeFork[] => {
      if ("fork" in settle) {
        return [settle.fork];
      }
      if ("blocked" in settle) {
        blocked.push(src);
        return [];
      }
      if ("never" in settle) {
        return [];
      }
      return [{ id, errors: [], outputs: [settle.output], isText, ...(usage ? { usage } : {}) }];
    };
    const texts = step.requests.filter(
      (request): request is AgentStepRequest & { kind: "text" } => request.kind === "text",
    );
    // Text requests are settled below by their request; a decision's choices
    // are the decision branch's to expand, not a settlement.
    const requestIds = new Set(step.requests.map((request) => request.id));
    const forks = [
      ...texts.flatMap((request) => {
        const usage = usageFor(step, request);
        return asFork(
          settleFor(request.id, request.src, true, undefined, usage),
          request.id,
          request.src,
          true,
          usage,
        );
      }),
      ...invokes
        .filter((invoke) => !requestIds.has(invoke.id) && !kids.includes(invoke))
        .flatMap((invoke) =>
          asFork(settleFor(invoke.id, invoke.src, false, invoke), invoke.id, invoke.src, false),
        ),
    ];
    // Each pending decision's choices are branches of the same node; its
    // `errors` entry, if any, is a failing settlement like the others.
    const decisions = step.requests.filter((request) => request.kind === "decision");
    for (const decision of decisions) {
      const src = findInvokeMetadata(step, decision.id)?.src;
      const failed = (src !== undefined ? errorsFor(src) : undefined) ?? errorsFor(decision.id);
      if (failed) {
        forks.push({
          id: decision.id,
          errors: failed.values,
          recordError: failed.record,
          outputs: [],
        });
      }
    }
    if (coupled) {
      return { forks, blocked, decisions, kids };
    }
    return forks.length > 0 && forks.length + blocked.length + decisions.length > 1
      ? { forks, blocked, decisions }
      : undefined;
  };

  const reachedStates = new Set<string>();
  const reachedValues: unknown[] = [];
  const terminals: AgentPathTerminal[] = [];
  const unexplored: string[] = [];
  const unexpanded = new Set<string>();
  const vacuous = new Set<string>();
  // An explored child's reports are read only for these, so a child keeps
  // no terminals or notes, and its outputs, failures, and events distinct.
  const doneOutputs: unknown[] = [];
  const failures: unknown[] = [];
  const seenOutputs = new Set<string>();
  const seenFailures = new Set<string>();
  const seenParentEvents = new Set<string>();
  let stalls = false;
  let unfinished = false;
  const note = (text: () => string): void => {
    if (nesting === 0) {
      unexplored.push(text());
    }
  };
  // A coupled child's moves() collects its terminals here instead.
  let captured: Array<{ status: AgentPathTerminal["status"]; missingSrc?: string }> | undefined;
  const endPath = (path: PathLink | undefined, terminal: Omit<AgentPathTerminal, "path">): void => {
    if (captured) {
      captured.push({
        status: terminal.status,
        ...(terminal.missingSrc === undefined ? {} : { missingSrc: terminal.missingSrc }),
      });
      return;
    }
    pathsExplored++;
    if (terminal.status === "idle") {
      stalls = true;
    } else if (terminal.status !== "done" && terminal.status !== "error") {
      unfinished = true;
    }
    if (nesting === 0) {
      terminals.push({ ...terminal, path: pathOf(path) });
    }
  };
  let prunedByGuard = 0;
  let pathsExplored = 0;
  let nodesExpanded = 0;
  let hitPathCap = false;
  // True, and recorded, once a cap or the shared budget leaves a node unexpanded.
  const capped = (): boolean => {
    // A coupled child's moves are bounded by its parent's search, not its own caps.
    if (!stepping && (pathsExplored >= maxPaths || nodesExpanded >= maxNodes)) {
      hitPathCap = true;
    }
    if (budget.exhausted === undefined) {
      if (budget.nodes >= budget.maxNodes) {
        budget.exhausted = "nodes";
      } else if (budget.deadline !== undefined && Date.now() >= budget.deadline) {
        budget.exhausted = "ms";
      }
    }
    return hitPathCap || budget.exhausted !== undefined;
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
    for (const event of eventsToParent(effects, parent)) {
      pushDistinct(parentEvents, seenParentEvents, event);
    }
    for (const snapshot of transits.get(step) ?? []) {
      const transitKey = JSON.stringify(snapshot.value);
      if (!reachedStates.has(transitKey)) {
        reachedStates.add(transitKey);
        reachedValues.push(snapshot.value);
      }
    }
  };

  // A coupled child's stepper starts from each child's own state, not here.
  const initial = stepping
    ? undefined
    : withTransits(childStartStep(machine, options.input, childRef), () =>
        getInitialMicrosteps(machine, options.input as never),
      );
  if (initial) {
    recordState(initial, childRef?._initialEffects ?? initial.actions);
    if (stops(initial)) {
      witness = [];
    }
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
  const external =
    deliverable ?? (options.hostEvents === undefined ? undefined : new Set(options.hostEvents));
  const arriving = (snapshot: AnyMachineSnapshot) =>
    getAcceptedEvents(snapshot).filter((descriptor) => {
      if (external === undefined || external.has(descriptor.type)) {
        return true;
      }
      if (deliverable !== undefined) {
        undeliverable.add(descriptor.type);
      }
      return false;
    });
  // A coupled child never resolves work straight through: each settlement is
  // a move of its own, so the parent's sends and the child's sends to the
  // parent can fall between them.
  const races = (step: AgentStep): boolean =>
    stepping ||
    (interleaving &&
      (arriving(step.snapshot as AnyMachineSnapshot).length > 0 ||
        (timerMode === "fire" && armedTimers(step.snapshot as AnyMachineSnapshot).length > 0)));
  // `recordEvent` receives each event the advance delivers that belongs on
  // the path (a request's `usage` event), before `stopWhen` sees its result.
  const advance = (
    step: AgentStep,
    recordEvent: (event: ChosenEvent) => void,
    kids?: KidsMap,
  ): {
    step: AgentStep;
    blockedSrc?: string;
    hit?: boolean;
    fork?: InvokeFork;
    /** Other pending explored children, which can settle or send first. */
    siblings?: InvokeFork[];
    /** Srcs pending beside them with no `outputs` entry. */
    blockedSiblings?: string[];
    /** Decisions pending beside them: their choices branch from the same node. */
    decisions?: AgentStepRequest[];
    /** `children: "coupled"`: child machines pending, stepped by the parent. */
    kids?: PendingInvoke[];
    pending?: { id: string; output: unknown; usage?: AgentUsageEvent };
  } => {
    let current = step;
    // Bounded loop: each iteration resolves one text or scripted invoke.
    for (let i = 0; i < MAX_ADVANCE_STEPS; i++) {
      // A step whose sends to coupled children are not delivered yet is not a
      // state the machines are in: they apply at once.
      if (!awaitsKids(current, kids) && stops(current, kids)) {
        return { step: current, hit: true };
      }
      if (current.done) {
        return { step: current };
      }
      const request = current.requests.find(
        (pending) => pending.kind !== "text" || !neverSettles(pending.src),
      );
      const concurrent = concurrentForks(current);
      if (concurrent) {
        return {
          step: current,
          fork: concurrent.forks[0],
          siblings: concurrent.forks.slice(1),
          blockedSiblings: concurrent.blocked,
          decisions: concurrent.decisions,
          ...(concurrent.kids?.length ? { kids: concurrent.kids } : {}),
        };
      }
      if (request && request.kind === "text") {
        const usage = usageFor(current, request);
        const settle = settleFor(request.id, request.src, true, undefined, usage);
        if ("fork" in settle) {
          return { step: current, fork: settle.fork };
        }
        if ("blocked" in settle) {
          return { step: current, blockedSrc: request.src };
        }
        if ("never" in settle) {
          return { step: current };
        }
        if (races(current)) {
          return {
            step: current,
            pending: {
              id: request.id,
              output: asTextResult(settle.output),
              ...(usage?.[0] ? { usage: usage[0] } : {}),
            },
          };
        }
        if (usage?.[0]) {
          recordEvent(usage[0] as unknown as ChosenEvent);
        }
        current = settleStep(current, request.id, asTextResult(settle.output), usage?.[0]).step;
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
      const [invoke] = pendingInvokes(current).filter((pending) => !neverSettles(pending.src));
      if (invoke) {
        const settle = settleFor(invoke.id, invoke.src, false, invoke);
        if ("fork" in settle) {
          return { step: current, fork: settle.fork };
        }
        if ("blocked" in settle) {
          return { step: current, blockedSrc: invoke.src };
        }
        if ("never" in settle) {
          return { step: current };
        }
        if (races(current)) {
          return { step: current, pending: { id: invoke.id, output: settle.output } };
        }
        current = resolveStep(current, invoke.id, settle.output);
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
    path: PathLink | undefined,
    table: Partial<Record<string, Record<string, unknown>[]>>,
    except?: ReadonlySet<string>,
  ): ChosenEvent[] => [
    ...arriving(snapshot).flatMap((descriptor) => {
      if (except?.has(descriptor.type)) {
        return [];
      }
      // An explorer table that lists no payload for a type the wait
      // accepts skips that type: the search no longer covers it.
      if (table[descriptor.type]?.length === 0) {
        unexpanded.add(descriptor.type);
        note(
          () =>
            `skipped: payloads lists no ${descriptor.type} at path [${pathTypes(path)}], so its branches were not explored`,
        );
      }
      return variantsOf(descriptor.type, snapshot, table);
    }),
    ...timerEvents(snapshot, path),
  ];

  // Fired timers: the event a path records, mapped to the timer firing that
  // delivers it (and disarms the timer, as a run does).
  const timerFires = new WeakMap<ChosenEvent, EventObject>();
  const applied = (event: ChosenEvent): EventObject => timerFires.get(event) ?? event;
  const ignoredTimers = new Set<string>();
  // Each armed timer the machine delivers to itself (`after`, `timeout`, a
  // delayed `enq.raise`) whose event the active states take now.
  function armedTimers(
    snapshot: AnyMachineSnapshot,
  ): Array<{ event: EventObject; key: Record<string, unknown> }> {
    const timers = (snapshot as { timers?: unknown }).timers;
    if (!Array.isArray(timers) || timers.length === 0) {
      return [];
    }
    return timers.flatMap((timer) => {
      if (
        !isRecord(timer) ||
        timer["target"] !== "self" ||
        !isRecord(timer["event"]) ||
        typeof timer["event"]["type"] !== "string"
      ) {
        return [];
      }
      const event = timer["event"] as EventObject;
      if (!snapshot.can(event)) {
        return [];
      }
      const key =
        typeof timer["id"] === "string"
          ? { id: timer["id"] }
          : typeof timer["seq"] === "number"
            ? { seq: timer["seq"] }
            : { event };
      return [{ event, key }];
    });
  }
  // The armed timers a wait offers beside host events (none under `timers: "ignore"`).
  const timerEvents = (snapshot: AnyMachineSnapshot, path: PathLink | undefined): ChosenEvent[] => {
    const armed = armedTimers(snapshot);
    if (timerMode === "ignore") {
      for (const { event } of armed) {
        unexpanded.add(event.type);
        const key = JSON.stringify(event);
        if (!ignoredTimers.has(key)) {
          ignoredTimers.add(key);
          note(
            () =>
              `timers: ${key} is armed at path [${pathTypes(path)}], and timers: "ignore" never fires it`,
          );
        }
      }
      return [];
    }
    return armed.map(({ event, key }) => {
      const entry = { ...event } as ChosenEvent;
      timerFires.set(entry, { type: "xstate.timer", ...key });
      return entry;
    });
  };

  // `interleave: "pending"`: each accepted event (bar `except`) arriving
  // while an invoke is outstanding, one branch each.
  function* raceBranches(
    settled: AgentStep,
    path: PathLink | undefined,
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
      const next = transitionStep(settled, applied(event));
      recordState(next);
      yield { step: next, path: extend(path, event), depth: depth + 1 };
    }
  }

  const failBranch = (
    settled: AgentStep,
    path: PathLink | undefined,
    depth: number,
    fork: InvokeFork,
    error: unknown,
  ): ExploreNode => {
    const failed = rejectStep(settled, fork.id, error);
    recordState(failed);
    return {
      step: failed,
      path: extend(path, {
        type: "xstate.error.actor",
        actorId: fork.id,
        ...(fork.recordError ? { error } : {}),
      }),
      depth: depth + 1,
    };
  };
  // A forked completion, once per `usage` event its request delivers first.
  // A text request records its result, not the envelope.
  function* doneBranches(
    settled: AgentStep,
    path: PathLink | undefined,
    depth: number,
    fork: InvokeFork,
    output: unknown,
  ): Generator<ExploreNode> {
    const value = fork.isText ? asTextResult(output) : output;
    const recorded = fork.isText ? (value as AgentTextResult).result : output;
    const usages = fork.usage?.length ? fork.usage : [undefined];
    for (const [i, usage] of usages.entries()) {
      if (i > 0 && (witness !== undefined || capped())) {
        return;
      }
      const { step, completed } = settleStep(settled, fork.id, value, usage);
      recordState(step);
      const charged = usage && !stepping ? extend(path, usage as unknown as ChosenEvent) : path;
      yield {
        step,
        path: completed
          ? extend(charged, { type: "xstate.done.actor", actorId: fork.id, output: recorded })
          : charged,
        depth: depth + 1,
      };
    }
  }

  const maxDepthTerminal = (settled: AgentStep, path: PathLink | undefined): void => {
    endPath(path, { status: "max-depth", state: settled.snapshot.value });
    note(() => `max-depth: stopped at path [${pathTypes(path)}]`);
  };

  // `children: "coupled"`: a stepper per child (logic, src), shared by every
  // child of that kind; each child's own state travels with the node.
  const steppers = new Map<string, ChildStepper>();
  const stepperFor = (src: string, logic: AnyStateMachine): ChildStepper | undefined => {
    if (nesting >= MAX_CHILD_NESTING) {
      note(
        () =>
          `child: src '${src}' is nested deeper than ${MAX_CHILD_NESTING} machines; not explored`,
      );
      return undefined;
    }
    const key = `${logicId(logic)}\u0000${src}`;
    let stepper = steppers.get(key);
    if (!stepper) {
      stepper = explore(
        logic,
        { ...options, input: undefined, dedupeBy: undefined },
        undefined,
        nesting + 1,
        new Set(options.childEvents?.[src] ?? []),
        undefined,
        false,
        budget,
        true,
      ).stepper!;
      steppers.set(key, stepper);
    }
    return stepper;
  };

  // Steps whose effects a pump already delivered to their children.
  const pumped = new WeakSet<AgentStep>();
  // The parent the current coupled child sends to, while stepping it.
  let outParent: unknown;

  // Starts every coupled child live at `step` that `kids` does not hold yet
  // (its entry sends queued for the parent), and drops the ones that stopped.
  // False when priming a child ran past the delivery cap.
  const register = (step: AgentStep, kids: Map<string, KidState>, queue: Delivery[]): boolean => {
    const live = pendingInvokes(step).filter(isExploredChild);
    const sessions = new Set(live.map((invoke) => childSession(invoke.id, invoke.ref)));
    for (const session of kids.keys()) {
      if (!sessions.has(session)) kids.delete(session);
    }
    for (const invoke of live) {
      const session = childSession(invoke.id, invoke.ref);
      if (kids.has(session)) {
        continue;
      }
      const logic = invoke.logic as AnyStateMachine;
      const engine = stepperFor(invoke.src, logic);
      if (!engine) {
        continue;
      }
      // The entry effects the child actor actually ran, so their targets
      // are its own children's refs.
      const fresh = childStartStep(logic, invoke.input, invoke.ref);
      const start: AgentStep =
        invoke.ref?._initialEffects === undefined
          ? fresh
          : { ...fresh, actions: invoke.ref._initialEffects as AgentStep["actions"] };
      const parentRef = invoke.ref?._parent;
      const kid: KidState = {
        id: invoke.id,
        src: invoke.src,
        engine,
        step: start,
        parent: parentRef,
        kids: undefined,
      };
      // Its entry's sends, in order, then what its own children's replies set off.
      const primed = engine.prime(kid);
      if (primed.overflow) {
        return false;
      }
      kids.set(session, { ...kid, step: primed.step, kids: primed.kids });
      queue.push(
        ...outboundOf(start.actions, parentRef, start.snapshot.children),
        ...primed.outbound,
      );
      if (primed.step.snapshot.status !== "active") {
        queue.push({ settle: session });
      }
    }
    return true;
  };

  // The session of the coupled child an effect's `target` names, if any.
  const kidSessionFor = (
    step: AgentStep,
    target: unknown,
    kids: ReadonlyMap<string, KidState>,
  ): string | undefined => {
    const children = (step.snapshot.children ?? {}) as Record<string, ChildRef | undefined>;
    for (const [id, ref] of Object.entries(children)) {
      if (ref === target || id === target) {
        const session = childSession(id, ref);
        return kids.has(session) ? session : undefined;
      }
    }
    return undefined;
  };

  // Whether `step` still has sends to deliver to coupled children, or
  // children to start, before the machines settle.
  const awaitsKids = (step: AgentStep, kids: KidsMap | undefined): boolean => {
    if (!coupled || pumped.has(step)) {
      return false;
    }
    const held = kids ?? new Map<string, KidState>();
    if (
      pendingInvokes(step)
        .filter(isExploredChild)
        .some((invoke) => !held.has(childSession(invoke.id, invoke.ref)))
    ) {
      return true;
    }
    return (Array.isArray(step.actions) ? step.actions : []).some(
      (effect) =>
        isRecord(effect) &&
        effect["type"] === "@xstate.sendTo" &&
        kidSessionFor(step, effect["target"], held) !== undefined,
    );
  };

  // Delivers, in order, everything that follows from `start` with no choice:
  // the events its transition sent its coupled children, their replies to it,
  // the children that settled, and so on. Returns where that leaves the
  // machine, the path with each event it received, and the events it sent
  // its own parent on the way.
  const pump = (
    start: AgentStep,
    link: PathLink | undefined,
    kids: Map<string, KidState>,
    queue: Delivery[],
  ): {
    step: AgentStep;
    link: PathLink | undefined;
    kids: Map<string, KidState>;
    /** What this machine sent its own parent, or other actors to route, in order. */
    outbound: Outbound[];
    /** The deliveries ran past the cap: the branch ended `max-depth`, follow it no further. */
    overflow?: boolean;
  } => {
    let step = start;
    let overflow = false;
    const outbound: Outbound[] = [];
    // Delivers one event to a coupled child, queueing what follows from it.
    // False when no live coupled child at `at` is the target.
    const deliverTo = (at: AgentStep, target: unknown, event: EventObject): boolean => {
      const session = kidSessionFor(at, target, kids);
      const kid = session === undefined ? undefined : kids.get(session);
      if (!kid) {
        return false;
      }
      if (kid.step.snapshot.status !== "active") {
        return true;
      }
      const delivered = kid.engine.deliver(kid, event);
      if (delivered.overflow) {
        overflow = true;
        endPath(link, { status: "max-depth", state: at.snapshot.value });
        return true;
      }
      kids.set(session!, { ...kid, step: delivered.step, kids: delivered.kids });
      queue.push(...delivered.outbound);
      if (delivered.step.snapshot.status !== "active") {
        queue.push({ settle: session! });
      }
      return true;
    };
    // An event a child sent an actor neither it nor this machine holds: up
    // to this machine's parent, or, at the root, a gap in the search.
    const unrouted = (route: Routed): void => {
      if (stepping) {
        outbound.push({ route });
        return;
      }
      unexpanded.add(route.event.type);
      note(
        () =>
          `coupled: a child sent '${route.event.type}' to an actor the search does not model, at path [${pathTypes(link)}]`,
      );
    };
    const flush = (at: AgentStep): void => {
      if (pumped.has(at)) {
        return;
      }
      pumped.add(at);
      if (!register(at, kids, queue)) {
        overflow = true;
        endPath(link, { status: "max-depth", state: at.snapshot.value });
        return;
      }
      for (const effect of Array.isArray(at.actions) ? at.actions : []) {
        if (
          !isRecord(effect) ||
          effect["type"] !== "@xstate.sendTo" ||
          !isRecord(effect["event"]) ||
          typeof effect["event"]["type"] !== "string"
        ) {
          continue;
        }
        // Sends to anyone else are this step's outbound, in order.
        deliverTo(at, effect["target"], effect["event"] as EventObject);
        if (overflow) return;
      }
    };
    flush(step);
    for (let i = 0; queue.length > 0 && !overflow; i++) {
      if (step.done || step.snapshot.status !== "active" || witness !== undefined) {
        break;
      }
      if (i >= MAX_PUMP) {
        // A parent and children that keep sending each other: the branch is
        // cut short, so the search is not complete.
        endPath(link, { status: "max-depth", state: step.snapshot.value });
        note(() => `coupled: more than ${MAX_PUMP} deliveries at path [${pathTypes(link)}]`);
        overflow = true;
        break;
      }
      const item = queue.shift()!;
      if ("usage" in item) {
        if (stepping) {
          outbound.push(item);
          continue;
        }
        // The root takes a child's usage as a run does: only when its active
        // states take `@agent.usage` and accept this one.
        const snapshot = step.snapshot as AnyMachineSnapshot;
        if (!declaresUsageTransition(snapshot) || !snapshot.can(item.usage as never)) {
          continue;
        }
        step = transitionStep(step, item.usage);
        link = extend(link, item.usage as unknown as ChosenEvent);
      } else if ("route" in item) {
        if (!deliverTo(step, item.route.target, item.route.event)) {
          unrouted(item.route);
        }
        continue;
      } else if ("event" in item) {
        const accepted = (step.snapshot as AnyMachineSnapshot).can(item.event);
        step = transitionStep(step, item.event);
        if (accepted) {
          link = extend(link, item.event as ChosenEvent);
        }
      } else {
        const kid = kids.get(item.settle);
        if (!kid) {
          continue;
        }
        kids.delete(item.settle);
        const settledKid = kid.step.snapshot as AnyMachineSnapshot & { error?: unknown };
        if (settledKid.status === "done") {
          step = resolveStep(step, kid.id, settledKid.output);
          link = extend(link, {
            type: "xstate.done.actor",
            actorId: kid.id,
            output: settledKid.output,
          });
        } else {
          step = rejectStep(step, kid.id, settledKid.error);
          link = extend(link, {
            type: "xstate.error.actor",
            actorId: kid.id,
            error: settledKid.error,
          });
        }
      }
      recordState(step);
      outbound.push(...outboundOf(step.actions, outParent, step.snapshot.children));
      flush(step);
      if (!overflow && stops(step, kids)) {
        witness = pathOf(link);
        break;
      }
    }
    return { step, link, kids, outbound, overflow };
  };

  // A key for each coupled child's state, for `dedupeBy`.
  let unkeyable = 0;
  const kidsKey = (kids: KidsMap | undefined): string => {
    if (!kids || kids.size === 0) {
      return "";
    }
    const parts = [...kids.values()].map(
      (kid) => `${kid.id}\u0000${kid.src}\u0000${kid.engine.stateKey(kid)}`,
    );
    return `\u0003${parts.sort().join("\u0003")}`;
  };
  const stateKey = (kid: KidState): string => {
    const snapshot = kid.step.snapshot as AnyMachineSnapshot;
    try {
      return (
        JSON.stringify([
          snapshot.value,
          snapshot.context,
          snapshot.status,
          (snapshot as { historyValue?: unknown }).historyValue ?? null,
          kid.step.requests.map((request) => request.id),
          Object.keys(snapshot.children ?? {}),
          pumped.has(kid.step),
        ]) + kidsKey(kid.kids)
      );
    } catch {
      return `\u0002${unkeyable++}`;
    }
  };

  function* expand({
    step,
    path,
    depth,
    delivered,
    kids: nodeKids,
  }: ExploreNode): Generator<ExploreNode> {
    if (witness !== undefined || capped()) {
      return;
    }
    nodesExpanded++;
    budget.nodes++;

    const {
      step: settled,
      blockedSrc,
      hit,
      fork,
      siblings,
      blockedSiblings,
      decisions,
      pending,
      kids: pendingKids,
    } = advance(
      step,
      (event) => {
        path = extend(path, event);
      },
      nodeKids,
    );
    if (hit) {
      witness = pathOf(path);
      return;
    }

    // `children: "coupled"`: first deliver what the step sent its children
    // and start the ones it spawned. Doing so is no choice, so it keeps the depth.
    if (pendingKids) {
      const kids = new Map(nodeKids ?? []);
      const sizeBefore = kids.size;
      const synced = pump(settled, path, kids, []);
      if (synced.overflow) {
        return;
      }
      if (
        witness !== undefined ||
        synced.step !== settled ||
        synced.kids.size !== sizeBefore ||
        [...synced.kids].some(([session, kid]) => nodeKids?.get(session) !== kid)
      ) {
        if (witness === undefined) {
          yield {
            step: synced.step,
            path: synced.link,
            depth,
            kids: synced.kids,
            outbound: synced.outbound,
          };
        }
        return;
      }
      // Nothing to deliver after all: the check `advance` held back.
      if (stops(settled, nodeKids)) {
        witness = pathOf(path);
        return;
      }
    }

    // A key already explored at this depth or shallower has nothing new
    // below it. A shallower revisit explores again: it has more depth left
    // (the depth-first walk can reach a key deep before it reaches it
    // shallow).
    if (options.dedupeBy) {
      const key =
        options.dedupeBy(withKidSnapshots(settled.snapshot as AnyMachineSnapshot, nodeKids)) +
        (delivered?.size ? `\u0001${[...delivered].sort().join("\u0001")}` : "") +
        kidsKey(nodeKids);
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
      const resolved = settleStep(settled, pending.id, pending.output, pending.usage).step;
      recordState(resolved);
      // A delivered usage event is an event the machine receives: it is on the path.
      const charged =
        pending.usage && !stepping ? extend(path, pending.usage as unknown as ChosenEvent) : path;
      yield {
        step: resolved,
        // A coupled child's settled work is a move of its own, shown on the path.
        path: stepping
          ? extend(charged, {
              type: "xstate.done.actor",
              actorId: pending.id,
              output: pending.output,
            })
          : charged,
        depth,
      };
      yield* raceBranches(settled, path, depth);
      return;
    }

    // `children: "coupled"`: each child's next move, then the parent's own
    // settlements beside them. With no move left but a decision or an idle
    // wait, the branch point below takes over.
    if (pendingKids) {
      if (depth >= maxDepth) {
        maxDepthTerminal(settled, path);
        return;
      }
      let moved = false;
      // Every child is waiting on the host (or stalled): the machines as a
      // whole sit at an idle wait, where the parent's host events can arrive.
      let quiet = true;
      for (const [session, kid] of nodeKids ?? []) {
        const { moves, blocked, idle } = kid.engine.moves(kid, depth);
        if (!idle && moves.length > 0) quiet = false;
        for (const type of kid.engine.unexpanded) unexpanded.add(type);
        for (const type of kid.engine.vacuous) vacuous.add(type);
        for (const terminal of blocked) {
          if (witness !== undefined || capped()) {
            return;
          }
          if (
            terminal.status === "idle" ||
            terminal.status === "done" ||
            terminal.status === "error"
          ) {
            continue;
          }
          endPath(path, {
            status: terminal.status,
            state: settled.snapshot.value,
            ...(terminal.status === "needs-output"
              ? { missingSrc: terminal.missingSrc ?? kid.src }
              : {}),
          });
          note(
            () =>
              `child: src '${kid.src}' (actor '${kid.id}') stopped ${terminal.status} at path [${pathTypes(path)}]`,
          );
        }
        for (const move of moves) {
          if (witness !== undefined || capped()) {
            return;
          }
          moved = true;
          const kids = new Map(nodeKids!);
          kids.set(session, { ...kid, step: move.step, kids: move.kids });
          const queue: Delivery[] = [...move.outbound];
          if (move.step.snapshot.status !== "active") {
            queue.push({ settle: session });
          }
          let link = path;
          // A grandchild's move keeps its own actor, qualified by this child's id.
          for (const event of move.path) {
            const actor =
              typeof event["actor"] === "string" ? `${kid.id}.${event["actor"]}` : kid.id;
            link = extend(link, { ...event, actor });
          }
          // The machine is not mid-transition when the child's sends reach it,
          // so each one runs to quiescence (its replies included) before the next.
          let next: ReturnType<typeof pump> = { step: settled, link, kids, outbound: [] };
          for (const item of queue) {
            const after = pump(next.step, next.link, next.kids, [item]);
            next = { ...after, outbound: [...next.outbound, ...after.outbound] };
            if (
              after.overflow ||
              witness !== undefined ||
              after.step.snapshot.status !== "active"
            ) {
              break;
            }
          }
          if (witness !== undefined) {
            return;
          }
          if (next.overflow) {
            continue;
          }
          yield {
            step: next.step,
            path: next.link,
            depth: move.depth,
            kids: next.kids,
            outbound: next.outbound,
          };
        }
      }
      // A coupled child the nesting cap kept out never moves.
      const registered = new Set(
        [...(nodeKids ?? new Map<string, KidState>()).values()].map((kid) => kid.id),
      );
      for (const kid of pendingKids.filter((invoke) => !registered.has(invoke.id))) {
        if (witness !== undefined || capped()) {
          return;
        }
        endPath(path, {
          status: "needs-output",
          state: settled.snapshot.value,
          missingSrc: kid.src,
        });
      }
      const others = [...(fork ? [fork] : []), ...(siblings ?? [])];
      for (const other of others) {
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
          yield* doneBranches(settled, path, depth, other, output);
        }
      }
      for (const src of blockedSiblings ?? []) {
        if (witness !== undefined || capped()) {
          return;
        }
        endPath(path, { status: "needs-output", state: settled.snapshot.value, missingSrc: src });
        note(
          () => `needs-output: no \`outputs\` entry for src '${src}' at path [${pathTypes(path)}]`,
        );
      }
      if (
        !decisions?.length &&
        (moved || others.length > 0 || (blockedSiblings ?? []).length > 0)
      ) {
        if (interleaving || (quiet && others.length === 0 && !blockedSiblings?.length)) {
          yield* raceBranches(settled, path, depth);
        }
        return;
      }
      if (witness !== undefined) {
        return;
      }
    }

    if (fork && !pendingKids) {
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
          yield* doneBranches(settled, path, depth, fork, output);
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
            yield* doneBranches(settled, path, depth, other, output);
          }
        }
        for (const child of [fork, ...(siblings ?? [])]) {
          for (const event of child.events ?? []) {
            if (witness !== undefined || capped()) {
              return;
            }
            const key = `${child.session ?? child.id}\u0000${JSON.stringify(event)}`;
            if (delivered?.has(key) || !(settled.snapshot as AnyMachineSnapshot).can(event)) {
              continue;
            }
            const next = transitionStep(settled, event);
            recordState(next);
            yield {
              step: next,
              path: extend(path, event as ChosenEvent),
              depth: depth + 1,
              delivered: new Set([...(delivered ?? []), key]),
            };
          }
        }
        // An explored child that can stall leaves the parent waiting here.
        if (fork.stalls && witness === undefined && !capped()) {
          endPath(path, { status: "idle", state: settled.snapshot.value });
        }
        for (const src of blockedSiblings ?? []) {
          note(
            () =>
              `needs-output: no \`outputs\` entry for src '${src}' at path [${pathTypes(path)}]`,
          );
        }
        for (const incompleteSrc of [
          ...[fork, ...(siblings ?? [])].flatMap((child) =>
            child.incompleteSrc === undefined ? [] : [child.incompleteSrc],
          ),
          ...(blockedSiblings ?? []),
        ]) {
          if (witness !== undefined || capped()) {
            break;
          }
          endPath(path, {
            status: "needs-output",
            state: settled.snapshot.value,
            missingSrc: incompleteSrc,
          });
        }
        // A pending decision's choices follow, at the branch point below.
        if (!decisions?.length) {
          if (interleaving) {
            yield* raceBranches(settled, path, depth);
          }
          return;
        }
      }
      // A decision's success branch is the per-candidate-event fork below, a
      // sibling of the error branch: it spends its own level, not a second one.
      if (witness !== undefined) {
        return;
      }
    }

    if (blockedSrc) {
      endPath(path, {
        status: "needs-output",
        state: settled.snapshot.value,
        missingSrc: blockedSrc,
      });
      note(
        () =>
          `needs-output: no \`outputs\` entry for src '${blockedSrc}' at path [${pathTypes(path)}]`,
      );
      if (interleaving && depth < maxDepth) {
        yield* raceBranches(settled, path, depth);
      }
      return;
    }

    if (settled.done) {
      const output: unknown = (settled.snapshot as AnyMachineSnapshot).output;
      endPath(path, {
        status: "done",
        state: settled.snapshot.value,
        ...(output === undefined ? {} : { output }),
      });
      pushDistinct(doneOutputs, seenOutputs, output);
      return;
    }

    // A scripted failure with no `onError` in scope errors the machine, as it
    // does in a live run. That is a terminal of its own, not an idle wait.
    if ((settled.snapshot as AnyMachineSnapshot).status === "error") {
      const error = (settled.snapshot as AnyMachineSnapshot & { error?: unknown }).error;
      endPath(path, { status: "error", state: settled.snapshot.value, error });
      pushDistinct(failures, seenFailures, error);
      return;
    }

    // Branch point: a decision request's candidates, or an idle wait's
    // externally-accepted events — each type expanded to its payload variants.
    const snapshot = settled.snapshot as AnyMachineSnapshot;
    const table = options.payloads?.(snapshot) ?? {};
    // Beside an explored child, every pending decision is a branch point.
    const branchRequests: (AgentStepRequest | undefined)[] = decisions?.length
      ? decisions
      : [settled.requests.find((request) => request.kind !== "text" || !neverSettles(request.src))];
    for (const request of branchRequests) {
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
        endPath(path, { status: "idle", state: settled.snapshot.value });
        return;
      }

      if (depth >= maxDepth) {
        endPath(path, { status: "max-depth", state: settled.snapshot.value });
        note(() => `max-depth: stopped at path [${pathTypes(path)}]`);
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
        const next = transitionStep(settled, applied(event));
        recordState(next);
        yield { step: next, path: extend(path, event), depth: depth + 1 };
      }

      // An idle wait whose every offered event the guards refuse: a live run
      // would sit here, but more likely the payload table offered nothing the
      // machine accepts. Record the wait and list the types as unexpanded, so
      // the search is not a proof until the table covers an accepted payload.
      if (request?.kind !== "decision" && taken === 0 && witness === undefined && !capped()) {
        endPath(path, { status: "idle", state: settled.snapshot.value });
        const refused = [...new Set(branchEvents.map((event) => event.type))];
        for (const type of refused) unexpanded.add(type);
        note(
          () =>
            `stuck: every offered ${refused.join(", ")} event at path [${pathTypes(path)}] was refused by the machine's guards; add a payloads entry it accepts`,
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
        const failed = rejectStep(settled, request.id, exhausted);
        recordState(failed);
        yield {
          step: failed,
          path: extend(path, { type: "xstate.error.actor", actorId: request.id }),
          depth: depth + 1,
        };
      }
    }

    // An event the active states accept but no decision offers can arrive
    // while the decisions are outstanding.
    const offered = branchRequests.filter((request) => request?.kind === "decision");
    if (interleaving && offered.length > 0) {
      yield* raceBranches(
        settled,
        path,
        depth,
        new Set(offered.flatMap((request) => request!.events.map((descriptor) => descriptor.type))),
      );
    }
  }

  if (stepping) {
    const stepper: ChildStepper = {
      moves(kid, depth) {
        const outer = { captured, outParent };
        captured = [];
        outParent = kid.parent;
        try {
          const idle = stepper.quiet(kid);
          const moves: ChildMove[] = [];
          for (const node of expand({ step: kid.step, path: undefined, depth, kids: kid.kids })) {
            // What the move's own step sent its children happens in the same
            // move: nothing else can run between them.
            const settledMove = pump(
              node.step,
              node.path,
              new Map(node.kids ?? kid.kids ?? []),
              [],
            );
            if (settledMove.overflow) {
              continue;
            }
            moves.push({
              step: settledMove.step,
              path: pathOf(settledMove.link),
              depth: node.depth,
              kids: settledMove.kids,
              outbound: [
                ...(charges.has(node.step) ? [{ usage: charges.get(node.step)! }] : []),
                ...(node.outbound ??
                  outboundOf(node.step.actions, kid.parent, node.step.snapshot.children)),
                ...settledMove.outbound,
              ],
            });
          }
          return { moves, blocked: captured, idle };
        } finally {
          captured = outer.captured;
          outParent = outer.outParent;
        }
      },
      deliver(kid, event) {
        const outer = outParent;
        outParent = kid.parent;
        try {
          // A child not yet settled: its own pending effects come first.
          const primed = pump(kid.step, undefined, new Map(kid.kids ?? []), []);
          if (primed.overflow) {
            return { ...primed, overflow: true };
          }
          const next = transitionStep(primed.step, event);
          recordState(next);
          const pumpedKids = pump(next, undefined, primed.kids, []);
          return {
            step: pumpedKids.step,
            kids: pumpedKids.kids,
            outbound: [
              ...primed.outbound,
              ...outboundOf(next.actions, kid.parent, next.snapshot.children),
              ...pumpedKids.outbound,
            ],
            ...(pumpedKids.overflow ? { overflow: true } : {}),
          };
        } finally {
          outParent = outer;
        }
      },
      prime(kid) {
        const outer = outParent;
        outParent = kid.parent;
        try {
          return pump(kid.step, undefined, new Map(kid.kids ?? []), []);
        } finally {
          outParent = outer;
        }
      },
      quiet(kid) {
        if (kid.step.requests.length > 0) {
          return false;
        }
        // Its only pending work may be coupled children that are quiet too.
        const held = [...(kid.kids ?? new Map<string, KidState>()).values()];
        return pendingInvokes(kid.step).every((invoke) => {
          const child = held.find((candidate) => candidate.id === invoke.id);
          return child !== undefined && child.engine.quiet(child);
        });
      },
      stateKey,
      unexpanded,
      vacuous,
    };
    return {
      report: undefined as never,
      doneOutputs,
      failures,
      undeliverable: [],
      parentEvents,
      stalls,
      unfinished,
      stepper,
    };
  }

  const root: ExploreNode = { step: initial!, path: undefined, depth: 0 };
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
          child.delivered = pruneDelivered(child.delivered ?? node.delivered, child.step);
          child.kids ??= node.kids;
          (levels[child.path?.length ?? 0] ??= []).push(child);
        }
        if (witness !== undefined || hitPathCap || budget.exhausted !== undefined) {
          break search;
        }
      }
      levels[length] = [];
    }
  } else if (witness === undefined) {
    const visit = (node: ExploreNode): void => {
      for (const child of expand(node)) {
        child.delivered = pruneDelivered(child.delivered ?? node.delivered, child.step);
        child.kids ??= node.kids;
        visit(child);
      }
    };
    visit(root);
  }

  if (nesting === 0 && budget.exhausted !== undefined) {
    unexplored.push(
      `budget-exhausted: ${budget.exhausted} (${budget.nodes} nodes expanded in ${Date.now() - budget.started} ms, child searches included)`,
    );
  }
  const partial = hitPathCap || budget.exhausted !== undefined;
  const report: AgentPathReport = {
    reachedStates: reachedValues,
    terminals,
    prunedByGuard,
    unexplored,
    pathsExplored,
    hitPathCap,
    partial,
    complete: false,
    unexpandedEvents: [...unexpanded],
    vacuous: [...vacuous],
  };
  report.complete = isExplorationComplete(report);
  return {
    report,
    witness,
    doneOutputs,
    failures,
    undeliverable: [...undeliverable],
    parentEvents,
    stalls,
    unfinished,
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
 * 200), and `maxNodes` (default 100,000) per search, the last two reported
 * via `hitPathCap`, and by `budget` across the whole call, child searches
 * included. A cut-short report is `partial` and not `complete`.
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
   * cap (`maxPaths` or `maxNodes`) or the `budget` cut it short, a path reached `maxDepth`, a
   * branch stopped `needs-output` on a src with no `outputs` entry, or an event type
   * was not expanded to all its payload variants (`unexpandedEvents` in the
   * {@link explorePaths} report). `reachable: false` is a proof of
   * unreachability only when `complete` is true.
   */
  complete: boolean;
  /**
   * Why the search is not complete, present only when `complete` is false:
   * the {@link explorePaths} report's `unexplored` notes (such as
   * `needs-output: no \`outputs\` entry for src 'resume' at path []`), plus a
   * `path-cap`, `unexpanded-events`, or `max-depth` note for the causes the
   * report records elsewhere.
   */
  unexplored?: string[];
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
  // Only a state target can be passed through; a predicate sees settled snapshots.
  const { witness, report } = explore(
    machine,
    options,
    stopWhen,
    0,
    undefined,
    undefined,
    resolvedTarget !== undefined && hasTransientStates(machine.getStateNodeById(resolvedTarget)),
  );
  if (witness !== undefined) {
    return {
      reachable: true,
      witness,
      complete: true,
      ...(resolvedTarget ? { target: resolvedTarget } : {}),
    };
  }
  const complete = isExplorationComplete(report);
  return {
    reachable: false,
    complete,
    ...(resolvedTarget ? { target: resolvedTarget } : {}),
    ...(complete
      ? {}
      : {
          unexplored: [
            ...report.unexplored,
            ...(report.hitPathCap
              ? [
                  `path-cap: maxPaths or maxNodes cut the search short after ${report.pathsExplored} paths`,
                ]
              : []),
            ...(report.unexpandedEvents.length
              ? [
                  `unexpanded-events: not every payload variant was explored for ${report.unexpandedEvents.join(", ")}`,
                ]
              : []),
            ...(report.terminals.some((terminal) => terminal.status === "max-depth")
              ? ["max-depth: a path reached maxDepth before settling"]
              : []),
          ],
        }),
  };
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
    !report.partial &&
    report.unexpandedEvents.length === 0 &&
    report.terminals.every(
      (terminal) =>
        terminal.status === "done" || terminal.status === "idle" || terminal.status === "error",
    )
  );
}
