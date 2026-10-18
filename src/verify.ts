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
import type { AnyActorLogic, AnyMachineSnapshot, AnyStateMachine } from "xstate";
import type { ChosenEvent, StandardSchemaV1 } from "./types.js";
import { AgentError } from "./errors.js";
import { getAcceptedEvents, type AgentSchemas } from "./events.js";
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

// ─── Diagnostics ───

/** Severity of an {@link AgentLintDiagnostic}. `error` findings fail CI/the CLI; `warning`s are advisory. */
export type AgentLintSeverity = "error" | "warning";

/**
 * One static-analysis finding from {@link lintAgentMachine}. `code` names the
 * check (stable, machine-readable), `path` points at the offending state path
 * or config location, and `message` explains the problem and its remedy.
 */
export interface AgentLintDiagnostic {
  code: "decide-without-events" | "direct-object-src" | "invoke-without-on-error";
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
  const ctx: LintContext = {
    config,
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
}

function pendingInvokes(step: AgentStep): PendingInvoke[] {
  const out: PendingInvoke[] = [];
  for (const metadata of getPendingInvokes(step.snapshot as AnyMachineSnapshot)) {
    if (typeof metadata.src === "string") {
      out.push({ id: metadata.id, src: metadata.src });
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
   * Canned output for each text request, keyed by src (the
   * `setupAgent({ requests })` key, or `agent.generateText`/`agent.streamText`).
   * One value per src, reused every time that src is reached. A missing src
   * halts that branch with a `needs-output` terminal.
   */
  text?: Record<string, unknown>;
  /** Canned output for scripted invokes, keyed by src. Same one-value-per-src rule as `text`. */
  invokes?: Record<string, unknown>;
  /**
   * A canned failure per src, keyed like `text`/`invokes`. A src listed here
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
   */
  errors?: Record<string, unknown>;
  /**
   * Every output to try per src, keyed like `text`/`invokes`. A src with two
   * or more outputs forks one branch per output (plus the `errors` branch when
   * the src is listed there too), so a machine whose `onDone` branches on the
   * output is explored down every arm. Each fork counts against `maxDepth`,
   * and each branch records `{ type: 'xstate.done.actor.<id>', output }` in
   * the path. An entry here replaces that src's `text`/`invokes` value. A
   * one-element list is a plain canned output.
   */
  outputs?: Record<string, unknown[]>;
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
  payloads?: (snapshot: AnyMachineSnapshot) => Partial<Record<string, Record<string, unknown>[]>>;
  /**
   * A projection of the snapshot that determines its future. Settled
   * snapshots with an equal key are explored once (again only when reached
   * at a shallower depth), so payload and output branching that converges
   * stays tractable. Return everything a guard, choice, or output reads:
   * a key that drops a field the machine reads makes the search unsound.
   * Without it, every path is explored in full.
   */
  dedupeBy?: (snapshot: AnyMachineSnapshot) => string;
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
  /** For `needs-output`: the src whose canned output was missing. */
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
  /** The `errors` key for the failing branch, when there is one. */
  errorKey?: string;
  outputs: unknown[];
  /** Text requests resolve to `{ result, messages }`, not the bare output. */
  isText?: boolean;
  /** Outputs came from `options.outputs`: each branch records a done event in the path. */
  recordOutputs?: boolean;
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

// A pending branch point: the step to advance, the events that led to it, and
// how many branch points it has spent against `maxDepth`.
interface ExploreNode {
  step: AgentStep;
  path: ChosenEvent[];
  depth: number;
}

// Shared engine for explorePaths/canReach. Without `stopWhen` it walks depth
// first (explorePaths' terminal order). With `stopWhen` (canReach) it walks
// breadth first by path length and halts on the first snapshot the predicate
// holds for, so the returned witness is a shortest path.
function explore(
  machine: AnyStateMachine,
  options: ExplorePathsOptions,
  stopWhen?: (snapshot: AnyMachineSnapshot) => boolean,
): { report: AgentPathReport; witness?: ChosenEvent[] } {
  const maxDepth = options.maxDepth ?? 8;
  const maxPaths = options.maxPaths ?? 200;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const textScript = options.text ?? {};
  const invokeOutputs: Record<string, unknown> = { ...options.invokes };
  const errorScript = options.errors ?? {};
  const outputScript = options.outputs ?? {};
  // An agent machine's registered schemas, else a plain machine's own `schemas.events`.
  const eventSchemas =
    (getRegisteredAgentExecutionOptions(machine).schemas as AgentSchemas | undefined)?.events ??
    (machine.schemas as AgentSchemas | undefined)?.events ??
    {};

  // Schema-derived payloads per event type, computed once per type. A type
  // with no schema is applied bare, and that is all it can be.
  const finiteCache = new Map<string, { payloads: Record<string, unknown>[]; complete: boolean }>();
  const schemaPayloads = (type: string): Record<string, unknown>[] => {
    let fill = finiteCache.get(type);
    if (!fill) {
      const schema = eventSchemas[type];
      fill = schema ? finitePayloads(safeJsonSchema(schema)) : { payloads: [{}], complete: true };
      finiteCache.set(type, fill);
    }
    if (!fill.complete && !unexpanded.has(type)) {
      unexpanded.add(type);
      unexplored.push(
        `unexpanded: event '${type}' has payload fields the schema fill cannot enumerate; add a payloads entry for it`,
      );
    }
    return fill.payloads;
  };

  // The concrete events to try for one event type at a branch point: the
  // explorer's `payloads`, else the decision request's own options, else the
  // schema's finite domain, else the bare `{ type }`.
  const variantsOf = (
    type: string,
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
    return schemaPayloads(type).map((payload) => ({ ...payload, type }));
  };

  // How a text request or scripted invoke settles: resolved straight through
  // with its single output, forked (an `errors` entry or several `outputs`),
  // or blocked on a missing output.
  const settleFor = (
    id: string,
    src: string,
    single: Record<string, unknown>,
    isText: boolean,
  ): { fork: InvokeFork } | { output: unknown } | { blocked: true } => {
    const fromOutputs = src in outputScript;
    const outputs = fromOutputs ? (outputScript[src] ?? []) : src in single ? [single[src]] : [];
    if (src in errorScript || outputs.length > 1) {
      return {
        fork: {
          id,
          ...(src in errorScript ? { errorKey: src } : {}),
          outputs,
          isText,
          recordOutputs: fromOutputs,
        },
      };
    }
    return outputs.length === 1 ? { output: outputs[0] } : { blocked: true };
  };

  const reachedStates = new Set<string>();
  const reachedValues: unknown[] = [];
  const terminals: AgentPathTerminal[] = [];
  const unexplored: string[] = [];
  const unexpanded = new Set<string>();
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

  const recordState = (snapshot: AnyMachineSnapshot): void => {
    const key = JSON.stringify(snapshot.value);
    if (!reachedStates.has(key)) {
      reachedStates.add(key);
      reachedValues.push(snapshot.value);
    }
  };

  const initial = initialAgentStep(machine, options.input);
  recordState(initial.snapshot);
  if (stopWhen?.(initial.snapshot)) {
    witness = [];
  }

  // Advance a step deterministically through any non-branching text or scripted
  // invokes until it is done, idle-with-external-events, at a decision, or
  // blocked on a missing canned output. Returns the settled step plus a note.
  // `stopWhen` is checked on EVERY snapshot along the way — including the
  // intermediate ones this advance resolves straight through — so a predicate
  // canReach target that only holds mid-chain is still found (`hit`).
  const advance = (
    step: AgentStep,
  ): { step: AgentStep; blockedSrc?: string; hit?: boolean; fork?: InvokeFork } => {
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
        const settle = settleFor(request.id, request.src, textScript, true);
        if ("fork" in settle) {
          return { step: current, fork: settle.fork };
        }
        if ("blocked" in settle) {
          return { step: current, blockedSrc: request.src };
        }
        current = resolveAgentStep(machine, current, request, asTextResult(settle.output));
        recordState(current.snapshot);
        continue;
      }
      if (request && request.kind === "decision") {
        // A decision request carries no `src` of its own: correlate it to its
        // invoke the way simulateAgent does, and accept either the src
        // (usually `agent.decide`) or the invoke id as the `errors` key.
        const src = findInvokeMetadata(current, request.id)?.src;
        const errorSrc =
          src !== undefined && src in errorScript
            ? src
            : request.id in errorScript
              ? request.id
              : undefined;
        return errorSrc !== undefined
          ? {
              step: current,
              fork: { id: request.id, errorKey: errorSrc, outputs: [], isDecision: true },
            }
          : { step: current };
      }
      // No request: maybe a pending scripted invoke, else a wait.
      const [invoke] = pendingInvokes(current);
      if (invoke) {
        const settle = settleFor(invoke.id, invoke.src, invokeOutputs, false);
        if ("fork" in settle) {
          return { step: current, fork: settle.fork };
        }
        if ("blocked" in settle) {
          return { step: current, blockedSrc: invoke.src };
        }
        current = resolveAgentStep(machine, current, invoke.id, settle.output);
        recordState(current.snapshot);
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
  function* expand({ step, path, depth: startDepth }: ExploreNode): Generator<ExploreNode> {
    let depth = startDepth;
    if (witness !== undefined || capped()) {
      return;
    }
    nodesExpanded++;

    const { step: settled, blockedSrc, hit, fork } = advance(step);
    if (hit) {
      witness = path;
      return;
    }

    // A key already explored at this depth or shallower has nothing new
    // below it. A shallower revisit explores again: it has more depth left.
    // Breadth-first order is by path length, not depth (an unrecorded output
    // fork or a decision's rejection spends depth without adding the same
    // number of events), so the rule holds for both walks.
    if (options.dedupeBy) {
      const key = options.dedupeBy(settled.snapshot as AnyMachineSnapshot);
      const seenAt = visited.get(key);
      if (seenAt !== undefined && seenAt <= depth) {
        return;
      }
      visited.set(key, depth);
    }

    if (fork) {
      if (depth >= maxDepth) {
        pathsExplored++;
        terminals.push({ status: "max-depth", path, state: settled.snapshot.value });
        unexplored.push(`max-depth: stopped at path [${path.map((e) => e.type).join(", ")}]`);
        return;
      }
      // The failing branch first: it leads explorePaths' terminals, and breaks
      // ties between equally short canReach witnesses.
      if (fork.errorKey !== undefined) {
        const failed = rejectAgentStep(machine, settled, fork.id, errorScript[fork.errorKey]);
        recordState(failed.snapshot);
        yield {
          step: failed,
          path: [...path, { type: `xstate.error.actor.${fork.id}` }],
          depth: depth + 1,
        };
      }
      if (!fork.isDecision) {
        for (const output of fork.outputs) {
          if (witness !== undefined || capped()) {
            return;
          }
          const resolved = resolveAgentStep(
            machine,
            settled,
            fork.id,
            fork.isText ? asTextResult(output) : output,
          );
          recordState(resolved.snapshot);
          yield {
            step: resolved,
            path: fork.recordOutputs
              ? [...path, { type: `xstate.done.actor.${fork.id}`, output }]
              : path,
            depth: depth + 1,
          };
        }
        return;
      }
      // A decision's success branch is the per-candidate-event fork below.
      // The rejection already spent a level, so the branching starts a level in.
      depth += 1;
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
        `needs-output: no canned output for src '${blockedSrc}' at path [${path.map((e) => e.type).join(", ")}]`,
      );
      return;
    }

    if (settled.done) {
      pathsExplored++;
      terminals.push({ status: "done", path, state: settled.snapshot.value });
      return;
    }

    // A scripted failure with no `onError` in scope errors the machine, as it
    // does in a live run. That is a terminal of its own, not an idle wait.
    if ((settled.snapshot as AnyMachineSnapshot).status === "error") {
      pathsExplored++;
      terminals.push({
        status: "error",
        path,
        state: settled.snapshot.value,
        error: (settled.snapshot as AnyMachineSnapshot & { error?: unknown }).error,
      });
      return;
    }

    // Branch point: a decision request's candidates, or an idle wait's
    // externally-accepted events — each type expanded to its payload variants.
    const request = settled.requests[0] as AgentStepRequest | undefined;
    const table = options.payloads?.(settled.snapshot as AnyMachineSnapshot) ?? {};
    // A closed choice's options, rebuilt over the live candidates as a run
    // does but not yet filtered: the loop below prunes them, so guard-rejected
    // options count in `prunedByGuard`.
    const requestOptions =
      request?.kind === "decision" ? acceptedDecisionOptions(request, () => true) : undefined;
    const branchEvents: ChosenEvent[] =
      request?.kind === "decision"
        ? request.events.flatMap((descriptor) => variantsOf(descriptor.type, table, requestOptions))
        : getAcceptedEvents(settled.snapshot).flatMap((descriptor) =>
            variantsOf(descriptor.type, table),
          );

    if (branchEvents.length === 0) {
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

    for (const event of branchEvents) {
      if (witness !== undefined || capped()) {
        return;
      }
      // Guard legality: a type-legal-but-guard-rejected candidate is a pruned branch.
      if (!(settled.snapshot as AnyMachineSnapshot).can(event)) {
        prunedByGuard++;
        continue;
      }
      const next = transitionAgentStep(machine, settled, event);
      recordState(next.snapshot);
      yield { step: next, path: [...path, event], depth: depth + 1 };
    }
  }

  const root: ExploreNode = { step: initial, path: [], depth: 0 };
  if (witness === undefined && stopWhen) {
    // Breadth-first by path length, so the first witness found is a shortest
    // one. A fork that records no event (an unrecorded output) keeps its
    // child at the parent's length, so it joins the level being drained.
    const levels: (ExploreNode | undefined)[][] = [[root]];
    search: for (let length = 0; length < levels.length; length++) {
      const level = levels[length] ?? [];
      for (let i = 0; i < level.length; i++) {
        const node = level[i]!;
        // Drop the reference once taken, so a drained level frees its snapshots.
        level[i] = undefined;
        for (const child of expand(node)) {
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
    },
    witness,
  };
}

/**
 * Enumerates a machine's decision and external-event branches to a bounded
 * depth, model-free, and reports which states are reached and how each path
 * terminates. At each decision request it forks one branch per candidate event
 * (guard-rejected candidates are counted in `prunedByGuard`, not explored); at
 * an idle wait it forks per externally-accepted event. Text requests resolve
 * from `text`, other invokes from `invokes` — all by-src canned-output maps, and a missing src halts
 * that branch with a `needs-output` terminal rather than throwing. A src in
 * `errors` forks an extra branch where that invoke is rejected, so states
 * behind an `onError` are explored too.
 *
 * Events are applied as `{ type }` unless a payload is known: `payloads`
 * forks a type once per listed payload, a decide input's own `payloads`
 * become the branch set, and an event schema whose fields are finite (enums,
 * booleans, consts) expands to their product, each optional field also
 * omitted. A type that could not be fully expanded is listed in
 * `unexpandedEvents`. `outputs` forks an invoke once per listed output.
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
   * branch stopped `needs-output` on a missing canned output, or an event type
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
 * branch needed a canned output it did not have, or an event's payloads were
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
  target: string | ((snapshot: AnyMachineSnapshot) => boolean),
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
  // `done`, `idle`, and `error` end a branch the machine itself ended; any
  // other terminal stopped a branch the search did not explore.
  const complete =
    !report.hitPathCap &&
    report.unexpandedEvents.length === 0 &&
    report.terminals.every(
      (terminal) =>
        terminal.status === "done" || terminal.status === "idle" || terminal.status === "error",
    );
  return { reachable: false, complete, ...(resolvedTarget ? { target: resolvedTarget } : {}) };
}
