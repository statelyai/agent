/**
 * Keyless verification for agent machines — static lint checks plus
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
import { getJsonSchemaSync } from "./utils.js";
import { getAcceptedEvents } from "./events.js";
import { AgentDecisionExhaustedError, isDecisionLogic, resolveDecision } from "./decision.js";
import { isTextLogic } from "./text-logic.js";
import { AGENT_MESSAGES_EVENT_TYPE } from "./messages.js";
import { executorBoundLogics, getRegisteredAgentExecutionOptions } from "./internal/registry.js";
import {
  getInvokeEffectMetadata,
  initialAgentStep,
  resolveAgentStep,
  transitionAgentStep,
  type AgentStep,
  type AgentStepRequest,
} from "./steps.js";

// Well-known builtin invoke srcs (kept local to avoid widening the public
// surface of text-logic/decision internals).
const DECIDE_SRC = "agent.decide";
const USER_INPUT_SRC = "agent.userInput";

// ─── Diagnostics ───

/** Severity of an {@link AgentLintDiagnostic}. `error` findings fail CI/the CLI; `warning`s are advisory. */
export type AgentLintSeverity = "error" | "warning";

/**
 * One static-analysis finding from {@link lintAgentMachine}. `code` names the
 * check (stable, machine-readable), `path` points at the offending state path
 * or config location, and `message` explains the problem and its remedy.
 */
export interface AgentLintDiagnostic {
  code: "decide-without-events" | "direct-object-src" | "unhandled-agent-messages";
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
          `srcs cannot be rebound by runAgent, so they inherit no host executors — call ` +
          `'.withExecutor(...)' on the logic, or register it as a string-keyed actor source ` +
          `(machine.provide({ actors: { name: logic } })) and invoke it by name.`,
      });
    }
  }
  return out;
}

function checkUnhandledAgentMessages(ctx: LintContext): AgentLintDiagnostic[] {
  const rootHandlesMessages =
    ctx.config.on?.[AGENT_MESSAGES_EVENT_TYPE] !== undefined || ctx.config.on?.["*"] !== undefined;
  if (rootHandlesMessages) return [];

  let contextJsonSchema: { properties?: Record<string, unknown> } | undefined;
  try {
    contextJsonSchema = getJsonSchemaSync(
      ctx.schemas?.context as StandardSchemaV1 | undefined,
    ) as typeof contextJsonSchema;
  } catch {
    // Some Standard Schemas deliberately cannot lower custom fields to JSON
    // Schema. This advisory check must stay best-effort.
  }
  if (!contextJsonSchema?.properties?.messages) return [];

  const hasTextRequest = [...ctx.index.values()].some((node) =>
    node.invokes.some((invoke) => {
      if (typeof invoke.src !== "string") return false;
      return (
        invoke.src === "agent.generateText" ||
        invoke.src === "agent.streamText" ||
        isTextLogic(ctx.actors[invoke.src])
      );
    }),
  );
  return hasTextRequest
    ? [
        {
          code: "unhandled-agent-messages",
          severity: "warning",
          path: "(root)",
          message:
            "Text requests may return framework messages, but the root machine does not " +
            `handle '${AGENT_MESSAGES_EVENT_TYPE}'. Add on: { ` +
            `'${AGENT_MESSAGES_EVENT_TYPE}': appendMessages() } when transcript retention ` +
            "is intended, or disable this warning when messages are intentionally ignored.",
        },
      ]
    : [];
}

const LINT_CHECKS: Array<(ctx: LintContext) => AgentLintDiagnostic[]> = [
  checkDecideWithoutEvents,
  checkDirectObjectSrc,
  checkUnhandledAgentMessages,
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
 * - `userInput` — a flat FIFO queue of answers for `agent.userInput`, the
 *   shorthand for `invokes: { 'agent.userInput': [...] }`. Entries here are
 *   consumed before that src's `invokes` queue.
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
  userInput?: unknown[];
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
  /** The resolved request (for a text/userInput invoke): its kind and src. */
  resolvedRequest?: { kind: "text" | "userInput"; src: string; id: string };
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

// A pending non-decision invoke surfaced from a step's spawn actions (used for
// `agent.userInput` and any other actor whose output must be scripted).
interface PendingInvoke {
  id: string;
  src: string;
}

function pendingInvokes(step: AgentStep): PendingInvoke[] {
  const out: PendingInvoke[] = [];
  for (const action of step.actions) {
    const metadata = getInvokeEffectMetadata(action);
    if (typeof metadata?.src === "string" && typeof metadata.id === "string") {
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
    events: [...(options.script.events ?? [])],
  };
  if (options.script.userInput?.length) {
    // `userInput` is the shorthand queue for the `agent.userInput` src, and is
    // consumed before that src's own `invokes` entries.
    script.invokes![USER_INPUT_SRC] = [
      ...options.script.userInput,
      ...(script.invokes![USER_INPUT_SRC] ?? []),
    ];
  }

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
      // Text request.
      const taken = takeFromQueue(script.text, request.src);
      if (!taken.found) {
        throw scriptDryError("text", request.src, request.id);
      }
      step = resolveAgentStep(machine, step, request, taken.value);
      trail.push({
        state: step.snapshot.value,
        resolvedRequest: { kind: "text", src: request.src, id: request.id },
      });
      continue;
    }

    // No text/decision request — check for a pending scripted invoke
    // (agent.userInput and friends surface as spawn actions, not requests).
    const [invoke] = pendingInvokes(step);
    if (invoke) {
      const taken = takeFromQueue(script.invokes, invoke.src);
      if (!taken.found) {
        throw scriptDryError("userInput", invoke.src, invoke.id);
      }
      step = resolveAgentStep(machine, step, invoke.id, taken.value);
      trail.push({
        state: step.snapshot.value,
        resolvedRequest: { kind: "userInput", src: invoke.src, id: invoke.id },
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

  // Mirror bindDecisionLogic (the runAgent path): the attempt budget is the
  // decision logic's maxRetries. The invoke's own logic wins (covers
  // direct-object srcs), then the registered actors, then `sources.actors`
  // (which survives `machine.provide(...)`, whose product the registry may
  // not know).
  const logic = isDecisionLogic(invokeLogic)
    ? invokeLogic
    : resolveRegisteredDecisionLogic(machine, decisionSrc);
  const maxRetries = logic?.maxRetries;

  let chosen: ChosenEvent;
  try {
    chosen = await resolveDecision(
      request,
      { decide },
      {
        maxRetries,
        canTake: (event) => (step.snapshot as AnyMachineSnapshot).can(event as never),
      },
    );
  } catch (error) {
    if (!(error instanceof AgentDecisionExhaustedError)) {
      throw error;
    }
    const errorEvent = {
      type: "xstate.error.actor",
      actorId: request.id,
      ...sessionIdOf(step.snapshot, request.id),
      error,
    };
    const next = transitionAgentStep(machine, step, errorEvent as never);
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

// The spawn-action metadata for the invoke with this id: its string src (when
// it has one) and its inline logic (when the src is a direct logic object).
function findInvokeMetadata(
  step: AgentStep,
  id: string,
): { src?: string; logic?: unknown } | undefined {
  for (const action of step.actions) {
    const metadata = getInvokeEffectMetadata(action);
    if (metadata?.id !== id) {
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

// The invoked child's session identity, needed on a minted error event so
// xstate's transition doesn't discard it as stale.
function sessionIdOf(snapshot: AnyMachineSnapshot, id: string): { sessionId?: string } {
  const child = (snapshot.children as Record<string, { sessionId?: unknown }>)[id];
  return typeof child?.sessionId === "string" ? { sessionId: child.sessionId } : {};
}

function mapValues<T, U>(obj: Record<string, T>, fn: (value: T) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, fn(value)]));
}

function scriptDryError(
  kind: "text" | "decision" | "userInput",
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
        : src === USER_INPUT_SRC
          ? "userInput"
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
   * Canned output for each text request, keyed by src (the
   * `setupAgent({ requests })` key, or `agent.generateText`/`agent.streamText`).
   * One value per src, reused every time that src is reached. A missing src
   * halts that branch with a `needs-output` terminal.
   */
  text?: Record<string, unknown>;
  /** Canned output for scripted invokes, keyed by src. Same one-value-per-src rule as `text`. */
  invokes?: Record<string, unknown>;
  /** Canned output for `agent.userInput`, the shorthand for `invokes['agent.userInput']`. */
  userInput?: unknown;
}

/** A single explored path's terminal outcome. */
export interface AgentPathTerminal {
  status: "done" | "idle" | "needs-output" | "max-depth";
  /** The chosen/applied events, in order, that produced this terminal. */
  path: ChosenEvent[];
  /** The final state value on this path. */
  state: unknown;
  /** For `needs-output`: the src whose canned output was missing. */
  missingSrc?: string;
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
  /** True when the total-paths cap was hit (report is partial). */
  hitPathCap: boolean;
}

// Safety bound on the deterministic advance between two branch points: each
// iteration resolves one text/userInput invoke, so this only trips on a machine
// that loops through invokes without ever branching or settling.
const MAX_ADVANCE_STEPS = 1000;

// Shared DFS engine for explorePaths/canReach. When `stopWhen` returns true for
// a visited snapshot, exploration halts and the witness path is returned.
async function explore(
  machine: AnyStateMachine,
  options: ExplorePathsOptions,
  stopWhen?: (snapshot: AnyMachineSnapshot) => boolean,
): Promise<{ report: AgentPathReport; witness?: ChosenEvent[] }> {
  const maxDepth = options.maxDepth ?? 8;
  const maxPaths = options.maxPaths ?? 200;
  const textScript = options.text ?? {};
  const invokeOutputs: Record<string, unknown> = { ...(options.invokes ?? {}) };
  if ("userInput" in options) {
    invokeOutputs[USER_INPUT_SRC] = options.userInput;
  }

  const reachedStates = new Set<string>();
  const reachedValues: unknown[] = [];
  const terminals: AgentPathTerminal[] = [];
  const unexplored: string[] = [];
  let prunedByGuard = 0;
  let pathsExplored = 0;
  let hitPathCap = false;
  let witness: ChosenEvent[] | undefined;

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

  // Advance a step deterministically through any non-branching text/userInput
  // invokes until it is done, idle-with-external-events, at a decision, or
  // blocked on a missing canned output. Returns the settled step plus a note.
  // `stopWhen` is checked on EVERY snapshot along the way — including the
  // intermediate ones this advance resolves straight through — so a predicate
  // canReach target that only holds mid-chain is still found (`hit`).
  const advance = (step: AgentStep): { step: AgentStep; blockedSrc?: string; hit?: boolean } => {
    let current = step;
    // Bounded loop: each iteration resolves one text/userInput invoke.
    for (let i = 0; i < MAX_ADVANCE_STEPS; i++) {
      if (stopWhen?.(current.snapshot)) {
        return { step: current, hit: true };
      }
      if (current.done) {
        return { step: current };
      }
      const request = current.requests[0] as AgentStepRequest | undefined;
      if (request && request.kind === "text") {
        if (!(request.src in textScript)) {
          return { step: current, blockedSrc: request.src };
        }
        current = resolveAgentStep(machine, current, request, textScript[request.src]);
        recordState(current.snapshot);
        continue;
      }
      if (request && request.kind === "decision") {
        return { step: current };
      }
      // No request: maybe a pending scripted invoke (userInput), else a wait.
      const [invoke] = pendingInvokes(current);
      if (invoke) {
        if (!(invoke.src in invokeOutputs)) {
          return { step: current, blockedSrc: invoke.src };
        }
        current = resolveAgentStep(machine, current, invoke.id, invokeOutputs[invoke.src]);
        recordState(current.snapshot);
        continue;
      }
      return { step: current };
    }
    return { step: current };
  };

  const visit = async (step: AgentStep, path: ChosenEvent[], depth: number): Promise<void> => {
    if (witness !== undefined) {
      return;
    }
    if (pathsExplored >= maxPaths) {
      hitPathCap = true;
      return;
    }

    const { step: settled, blockedSrc, hit } = advance(step);
    if (hit) {
      witness = path;
      return;
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

    // Branch point: a decision request's candidates, or an idle wait's
    // externally-accepted events.
    const request = settled.requests[0] as AgentStepRequest | undefined;
    const branchEvents: ChosenEvent[] =
      request?.kind === "decision"
        ? request.events.map((descriptor) => ({ type: descriptor.type }))
        : getAcceptedEvents(settled.snapshot).map((descriptor) => ({ type: descriptor.type }));

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
      if (witness !== undefined || pathsExplored >= maxPaths) {
        if (pathsExplored >= maxPaths) hitPathCap = true;
        return;
      }
      // Guard legality: a type-legal-but-guard-rejected candidate is a pruned branch.
      if (!(settled.snapshot as AnyMachineSnapshot).can(event)) {
        prunedByGuard++;
        continue;
      }
      const next = transitionAgentStep(machine, settled, event);
      recordState(next.snapshot);
      await visit(next, [...path, event], depth + 1);
    }
  };

  if (witness === undefined) {
    await visit(initial, [], 0);
  }

  return {
    report: {
      reachedStates: reachedValues,
      terminals,
      prunedByGuard,
      unexplored,
      pathsExplored,
      hitPathCap,
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
 * from `text`, other invokes from `invokes` (or `userInput` for
 * `agent.userInput`) — all by-src canned-output maps, and a missing src halts
 * that branch with a `needs-output` terminal rather than throwing.
 *
 * Combinatorics are bounded by `maxDepth` (default 8) and `maxPaths` (default
 * 200, reported via `hitPathCap`).
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
  return (await explore(machine, options)).report;
}

/** The result of a {@link canReach} query. */
export interface CanReachResult {
  /** True when the target state was reached within the exploration bounds. */
  reachable: boolean;
  /** Resolved XState state-node id for a string target. */
  target?: string;
  /** When reachable, the sequence of chosen/applied events that gets there. */
  witness?: ChosenEvent[];
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
 * `{ reachable: false }`.
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
      : (snapshot: AnyMachineSnapshot): boolean => snapshot.matches(target as never);
  const { witness } = await explore(machine, options, stopWhen);
  return witness !== undefined
    ? { reachable: true, witness, ...(resolvedTarget ? { target: resolvedTarget } : {}) }
    : { reachable: false, ...(resolvedTarget ? { target: resolvedTarget } : {}) };
}
