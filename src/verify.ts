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
 *   "can this state be reached?" with a witness path.
 *
 * @module
 */
import type { AnyActorLogic, AnyMachineSnapshot, AnyStateMachine } from "xstate";
import type { ChosenEvent } from "./types.js";
import { AgentError } from "./errors.js";
import { getJsonSchemaSync } from "./utils.js";
import { getAcceptedEvents } from "./events.js";
import { isDecisionLogic } from "./decision.js";
import { isTextLogic } from "./text-logic.js";
import {
  executorBoundLogics,
  getMachineStaticTransitionTargets,
  getRegisteredAgentExecutionOptions,
} from "./internal/registry.js";
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
    | "unreachable-state"
    | "decide-without-events"
    | "unserializable-context"
    | "direct-object-src"
    | "final-without-output"
    | "final-output-reads-event"
    | "undeclared-event"
    | "missing-final";
  severity: AgentLintSeverity;
  /** State path (`parent.child`) or config pointer (e.g. `(root)`, `context`) the finding is about. */
  path: string;
  message: string;
}

/** Options for {@link lintAgentMachine}. Reserved for future check selection. */
export interface LintAgentMachineOptions {
  /** Skip these check codes entirely. */
  disable?: AgentLintDiagnostic["code"][];
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
  name: string;
  config: AnyConfig;
  parentPath: string;
  type?: string;
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
        name,
        config,
        parentPath,
        type: config.type,
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

function childrenOf(index: Map<string, StateNode>, parentPath: string): StateNode[] {
  const out: StateNode[] = [];
  for (const node of index.values()) {
    if (node.parentPath === parentPath) {
      out.push(node);
    }
  }
  return out;
}

// ─── Reachability (static, conservative) ───

// Extracts concrete target paths from a single transition config value, marking
// `opaque` when a target is a function (dynamic), a `#id` reference, or an
// unresolvable string — cases where we cannot know the destination and must
// over-approximate rather than risk a false "unreachable" finding.
function collectTransitionTargets(
  value: unknown,
  fromNode: StateNode,
  index: Map<string, StateNode>,
  out: { targets: string[]; opaque: boolean },
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTransitionTargets(item, fromNode, index, out);
    }
    return;
  }
  if (typeof value === "function") {
    // Dynamic transition — destination unknowable at lint time.
    out.opaque = true;
    return;
  }
  if (typeof value === "string") {
    resolveTargetString(value, fromNode, index, out);
    return;
  }
  if (typeof value === "object") {
    const { target, to } = value as { target?: unknown; to?: unknown };
    if (target !== undefined) {
      collectTransitionTargets(target, fromNode, index, out);
      return;
    }
    // xstate's JSON layer folds a transition that carries a context patch into a
    // single `to` resolver, erasing its `target`. Treat it as opaque rather than
    // as a targetless (in-state) transition, which would under-approximate.
    if (to !== undefined) {
      collectTransitionTargets(to, fromNode, index, out);
      return;
    }
    // An object with neither stays in-state (no edge).
  }
}

function resolveTargetString(
  target: string,
  fromNode: StateNode,
  index: Map<string, StateNode>,
  out: { targets: string[]; opaque: boolean },
): void {
  // `#id...` absolute references can't be resolved reliably from config alone.
  if (target.startsWith("#")) {
    out.opaque = true;
    return;
  }
  const resolved = target.startsWith(".")
    ? `${fromNode.path}.${target.slice(1)}`
    : fromNode.parentPath
      ? `${fromNode.parentPath}.${target}`
      : target;

  if (index.has(resolved)) {
    out.targets.push(resolved);
  } else {
    // Unresolved (deep/relative form we don't model) — over-approximate.
    out.opaque = true;
  }
}

// All outgoing edges from a state node: `on`/`always`/`after`/`onDone`
// transitions plus each invoke's `onDone`/`onError`.
//
// `staticTargets` (present for `setupAgent.fromConfig` machines) is the source
// config's own targets by state path. It is complete — the lowering records
// every declared target, including the ones the JSON layer later folds into
// opaque resolver functions — so when it is present it fully replaces the scan
// over `machine.config`, and reachability is exact rather than approximated.
function outgoingTargets(
  node: StateNode,
  index: Map<string, StateNode>,
  staticTargets?: Record<string, string[]>,
): { targets: string[]; opaque: boolean } {
  const out = { targets: [] as string[], opaque: false };
  const { config } = node;

  if (staticTargets) {
    for (const target of staticTargets[node.path] ?? []) {
      resolveTargetString(target, node, index, out);
    }
    return out;
  }

  for (const value of Object.values(config.on ?? {})) {
    collectTransitionTargets(value, node, index, out);
  }
  collectTransitionTargets(config.always, node, index, out);
  // `type: 'choice'` pseudo-states resolve a `choice` transition immediately.
  collectTransitionTargets(config.choice, node, index, out);
  for (const value of Object.values(config.after ?? {})) {
    collectTransitionTargets(value, node, index, out);
  }
  collectTransitionTargets(config.onDone, node, index, out);
  for (const invoke of node.invokes) {
    collectTransitionTargets(invoke.onDone, node, index, out);
    collectTransitionTargets(invoke.onError, node, index, out);
  }

  return out;
}

// Computes the set of statically-reachable state paths from the machine's
// initial state. Conservative: dynamic (function) transitions, `#id` targets,
// and unresolved targets over-approximate by marking every sibling reachable,
// so a state is only reported unreachable when NO static or over-approximated
// path leads to it. Never a false positive; may miss (false negative) a truly
// dead state hidden behind a dynamic transition. `staticTargets` (see
// {@link outgoingTargets}) makes the walk exact for config-lowered machines.
function computeReachable(
  rootConfig: AnyConfig,
  index: Map<string, StateNode>,
  staticTargets?: Record<string, string[]>,
): Set<string> {
  const reachable = new Set<string>();
  const queue: string[] = [];

  const markAncestors = (path: string): void => {
    let parent = index.get(path)?.parentPath ?? "";
    while (parent) {
      reachable.add(parent);
      parent = index.get(parent)?.parentPath ?? "";
    }
  };

  const enter = (path: string): void => {
    if (reachable.has(path)) {
      return;
    }
    const node = index.get(path);
    if (!node) {
      return;
    }
    reachable.add(path);
    queue.push(path);
    markAncestors(path);

    if (node.isParallel) {
      for (const child of childrenOf(index, path)) {
        enter(child.path);
      }
    } else if (node.isCompound && node.config.initial) {
      enter(`${path}.${node.config.initial}`);
    }
  };

  if (rootConfig.type === "parallel") {
    // A parallel root activates every top-level region at once.
    for (const child of childrenOf(index, "")) {
      enter(child.path);
    }
  } else if (rootConfig.initial) {
    enter(rootConfig.initial);
  }

  // Worklist: process each newly-entered node's outgoing edges once.
  while (queue.length > 0) {
    const node = index.get(queue.shift() as string);
    if (!node) {
      continue;
    }
    const { targets, opaque } = outgoingTargets(node, index, staticTargets);
    for (const target of targets) {
      enter(target);
    }
    if (opaque) {
      // A dynamic/unresolved transition could target any sibling — mark them
      // all reachable rather than risk a false "unreachable" finding.
      for (const sibling of childrenOf(index, node.parentPath)) {
        enter(sibling.path);
      }
    }
  }

  return reachable;
}

// ─── Lint check helpers ───

interface LintContext {
  machine: AnyStateMachine;
  config: AnyConfig;
  index: Map<string, StateNode>;
  reachable: Set<string>;
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

// Classifies an invoke src as a decision (needs event handling) — by builtin
// src string or by a registered/direct-object DecisionLogic.
function decisionKindOf(
  src: unknown,
  actors: Record<string, AnyActorLogic>,
): "decision" | undefined {
  if (typeof src === "string") {
    if (src === DECIDE_SRC) return "decision";
    return isDecisionLogic(actors[src]) ? "decision" : undefined;
  }
  return isDecisionLogic(src) ? "decision" : undefined;
}

function isAgentLogicNeedingBinding(src: object): boolean {
  return (isTextLogic(src) || isDecisionLogic(src)) && !executorBoundLogics.has(src);
}

// Reports true when a schema exposes a synchronous JSON Schema (so its fields
// can be statically checked for JSON round-tripping).
function schemaExposesJson(schema: unknown): boolean {
  if (!schema) {
    return false;
  }
  try {
    return getJsonSchemaSync(schema as never) !== undefined;
  } catch {
    return false;
  }
}

// A "real" declared output schema: exposes a JSON object schema with at least
// one property (as opposed to the pass-through/unknown default).
function isDeclaredOutputSchema(schema: unknown): boolean {
  if (!schema) {
    return false;
  }
  let json: Record<string, unknown> | undefined;
  try {
    json = getJsonSchemaSync(schema as never);
  } catch {
    return false;
  }
  if (!json) {
    return false;
  }
  const properties = json.properties as Record<string, unknown> | undefined;
  const required = json.required as unknown[] | undefined;
  return (
    (json.type === "object" && !!properties && Object.keys(properties).length > 0) ||
    (Array.isArray(required) && required.length > 0)
  );
}

// ─── Lint checks (each returns its own diagnostics) ───

function checkUnreachableStates(ctx: LintContext): AgentLintDiagnostic[] {
  const out: AgentLintDiagnostic[] = [];
  for (const node of ctx.index.values()) {
    if (!ctx.reachable.has(node.path)) {
      out.push({
        code: "unreachable-state",
        severity: "error",
        path: node.path,
        message:
          `State '${node.path}' is unreachable: no transition, always, onDone, or onError ` +
          `target (from any reachable state) leads to it. Remove it or add a transition.`,
      });
    }
  }
  return out;
}

function checkDecideWithoutEvents(ctx: LintContext): AgentLintDiagnostic[] {
  const out: AgentLintDiagnostic[] = [];
  for (const node of ctx.index.values()) {
    for (const invoke of node.invokes) {
      const kind = decisionKindOf(invoke.src, ctx.actors);
      if (!kind) {
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
          `State '${node.path}' invokes ${kind} source '${srcName}', but neither it nor ` +
          `any ancestor handles any event (no 'on:'), so the ${kind}'s chosen event can ` +
          `never be delivered. Add an 'on:' handler for the candidate events.`,
      });
    }
  }
  return out;
}

function checkUnserializableContext(ctx: LintContext): AgentLintDiagnostic[] {
  const contextSchema = ctx.schemas?.context;
  if (!contextSchema) {
    return [];
  }
  if (schemaExposesJson(contextSchema)) {
    return [];
  }
  return [
    {
      code: "unserializable-context",
      severity: "warning",
      path: "context",
      message:
        "The context schema does not expose a JSON schema (e.g. a `z.custom` without a " +
        "`jsonSchema` extension, such as a messages array), so its fields cannot be " +
        "statically checked for JSON persist/resume round-tripping. This is expected for " +
        "message transcripts; verify any other custom-typed context is JSON-serializable.",
    },
  ];
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

function checkFinalWithoutOutput(ctx: LintContext): AgentLintDiagnostic[] {
  if (!isDeclaredOutputSchema(ctx.schemas?.output)) {
    return [];
  }
  // A root `output` (including the single-final-state sugar that copies one
  // final's output to the root) satisfies the contract for every final path.
  if (ctx.config.output !== undefined) {
    return [];
  }
  const out: AgentLintDiagnostic[] = [];
  for (const node of ctx.index.values()) {
    if (node.parentPath !== "" || !node.isFinal) {
      continue;
    }
    if (node.config.output === undefined) {
      out.push({
        code: "final-without-output",
        severity: "error",
        path: node.path,
        message:
          `The machine declares an output schema, but top-level final state '${node.path}' ` +
          `has no 'output'. Its snapshot output will be undefined and fail the schema. Add ` +
          `an 'output' to this final state (or a root 'output').`,
      });
    }
  }
  return out;
}

// Heuristically detects whether a final-state `output` function reads data off
// the entering `event`, via `fn.toString()`: a property, optional-chain, or
// index access on `event` (`event.x`, `event?.x`, `event[...]`). A bare
// destructured `event` that is only passed through — notably the resolver
// closures xstate's `createMachineFromConfig` generates for
// `setupAgent.fromConfig` output slots (`({ context, event, self }) =>
// evaluateResolvable(...)`) — is not a read and stays quiet, so config-lowered
// machines don't false-flag.
function outputFnReadsEvent(fn: (...args: never[]) => unknown): boolean {
  return /\bevent\s*(?:\.|\?\.|\[)/.test(fn.toString());
}

function checkFinalOutputReadsEvent(ctx: LintContext): AgentLintDiagnostic[] {
  const out: AgentLintDiagnostic[] = [];
  for (const node of ctx.index.values()) {
    if (node.parentPath !== "" || !node.isFinal) {
      continue;
    }
    const output = node.config.output;
    if (typeof output !== "function") {
      continue;
    }
    if (!outputFnReadsEvent(output as (...args: never[]) => unknown)) {
      continue;
    }
    out.push({
      code: "final-output-reads-event",
      severity: "warning",
      path: node.path,
      message:
        `Final state '${node.path}' has an 'output' function that reads 'event'. Final-state ` +
        `'output' functions are evaluated more than once with different events (the entering ` +
        `event, then the machine-done computation) under current xstate behavior, so 'event' ` +
        `is unreliable here. Read 'context' only; capture what you need from the entering ` +
        `event into context in the transition that targets this state. (This guard can relax ` +
        `if xstate guarantees a stable entering event across evaluations.)`,
    });
  }
  return out;
}

// True for `on:` keys that are legitimately not among declared event schemas:
// the catch-all wildcard, partial wildcard patterns, and xstate builtin events.
function isBuiltinOrWildcardEvent(eventType: string): boolean {
  return (
    eventType === "*" ||
    eventType.includes("*") ||
    eventType.startsWith("xstate.") ||
    eventType.startsWith("done.") ||
    eventType.startsWith("error.")
  );
}

// Flags `on:` handlers for events that are neither declared in `schemas.events`
// nor a builtin/wildcard pattern — a likely typo. WARNING, not error: a config
// may legitimately handle events it did not declare a payload schema for (the
// lowering accepts any `on` key), so this only fires when the machine declares
// typed events, and never blocks a run.
function checkUndeclaredEvents(ctx: LintContext): AgentLintDiagnostic[] {
  const declared = ctx.schemas?.events;
  // The reserved `@agent.*` entries setupAgent registers by default (e.g.
  // `'@agent.usage'`) don't count as "the machine declares typed events" — a
  // machine that declared none should stay unlinted here.
  const declaredTypes = new Set(Object.keys(declared ?? {}));
  if ([...declaredTypes].every((type) => type.startsWith("@agent."))) {
    return [];
  }
  const out: AgentLintDiagnostic[] = [];
  for (const node of ctx.index.values()) {
    for (const eventType of Object.keys(node.config.on ?? {})) {
      if (declaredTypes.has(eventType) || isBuiltinOrWildcardEvent(eventType)) {
        continue;
      }
      out.push({
        code: "undeclared-event",
        severity: "warning",
        path: node.path,
        message:
          `State '${node.path}' handles event '${eventType}' in 'on:', but it is not declared ` +
          `in schemas.events and is not a builtin/wildcard pattern. If intentional its payload ` +
          `stays unvalidated; otherwise this is likely a typo.`,
      });
    }
  }
  return out;
}

function checkMissingFinal(ctx: LintContext): AgentLintDiagnostic[] {
  for (const node of ctx.index.values()) {
    if (node.isFinal && ctx.reachable.has(node.path)) {
      return [];
    }
  }
  return [
    {
      code: "missing-final",
      severity: "warning",
      path: "(root)",
      message:
        "The machine has no reachable final state, so a run can never settle 'done' (only " +
        "idle/looping). This is legal for agents that only idle, but verify it is intended.",
    },
  ];
}

const LINT_CHECKS: Array<(ctx: LintContext) => AgentLintDiagnostic[]> = [
  checkUnreachableStates,
  checkDecideWithoutEvents,
  checkUnserializableContext,
  checkDirectObjectSrc,
  checkFinalWithoutOutput,
  checkFinalOutputReadsEvent,
  checkUndeclaredEvents,
  checkMissingFinal,
];

/**
 * Runs static structural checks over a built agent machine and returns the
 * findings ({@link AgentLintDiagnostic}[], empty when clean). Works for
 * TS-authored (`setupAgent(...).createMachine(...)`) and
 * `setupAgent.fromConfig(...)`-compiled machines alike, reading `machine.config`
 * plus the schemas/actor sources the library already retains per machine.
 *
 * No model calls, no API keys — a coding agent that emits an agent machine can
 * call this to catch dead states, undeliverable decisions, un-rebindable
 * invoke srcs, and output-contract gaps before ever running it.
 *
 * @example
 * ```ts
 * const errors = lintAgentMachine(machine).filter((d) => d.severity === 'error');
 * if (errors.length) throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
 * ```
 */
export function lintAgentMachine(
  machine: AnyStateMachine,
  options: LintAgentMachineOptions = {},
): AgentLintDiagnostic[] {
  const config = (machine as { config?: AnyConfig }).config ?? {};
  const index = buildStateIndex(config);
  const reachable = computeReachable(config, index, getMachineStaticTransitionTargets(machine));
  const registered = getRegisteredAgentExecutionOptions(machine);
  const ctx: LintContext = {
    machine,
    config,
    index,
    reachable,
    schemas: registered.schemas as LintContext["schemas"],
    actors:
      (registered.actors as Record<string, AnyActorLogic> | undefined) ??
      (machine as { sources?: { actors?: Record<string, AnyActorLogic> } }).sources?.actors ??
      {},
  };

  const disabled = new Set(options.disable ?? []);
  return LINT_CHECKS.flatMap((check) => check(ctx)).filter((d) => !disabled.has(d.code));
}

/** Options for {@link assertAgentMachine}. */
export interface AssertAgentMachineOptions extends LintAgentMachineOptions {
  /** Also fail on warning-severity findings. Default: errors only. */
  warnings?: boolean;
}

/**
 * Thrown by {@link assertAgentMachine} when lint finds failing diagnostics.
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

/**
 * Asserts a machine passes {@link lintAgentMachine}: returns silently when
 * clean, throws {@link AgentLintError} (with the findings on `.diagnostics`)
 * otherwise. Fails on error-severity findings; set `warnings: true` to fail on
 * warnings too. The one-liner for tests and generation loops:
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
  const diagnostics = lintAgentMachine(machine, options);
  const failing = options.warnings
    ? diagnostics
    : diagnostics.filter((d) => d.severity === "error");
  if (failing.length > 0) {
    throw new AgentLintError(machine.id ?? "(machine)", failing);
  }
}

// ─── Simulation ───

/**
 * Scripted responses for a {@link simulateAgent} playthrough. Each channel is a
 * by-`src` map of FIFO queues, consumed in the order the machine reaches the
 * requests:
 * - `text` — output values for text requests, keyed by request src (the
 *   `setupAgent({ requests })` key, or `agent.generateText`/`agent.streamText`).
 * - `decisions` — the {@link ChosenEvent} to apply for a decision request,
 *   keyed by decision src (usually `agent.decide`).
 * - `invokes` — output values for scripted invokes (notably `agent.userInput`,
 *   and any other actor whose output must be canned), keyed by src.
 */
export interface SimulationScript {
  text?: Record<string, unknown[]>;
  decisions?: Record<string, ChosenEvent[]>;
  invokes?: Record<string, unknown[]>;
}

/** One entry in a {@link SimulateAgentResult.trail}: the state after this step, plus what drove the step. */
export interface SimulationTrailEntry {
  /** The machine state value after applying this step. */
  state: unknown;
  /** The chosen event applied (for a decision request). */
  appliedEvent?: ChosenEvent;
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
 * Throws a descriptive error when the script runs dry mid-request, naming the
 * pending request's kind, src, and id so the missing scripted response is
 * obvious.
 *
 * @example
 * ```ts
 * const { status, snapshot } = simulateAgent(machine, {
 *   input: { topic: 'state machines' },
 *   script: { decisions: { 'agent.decide': [{ type: 'END' }] } },
 * });
 * ```
 */
export async function simulateAgent(
  machine: AnyStateMachine,
  options: SimulateAgentOptions,
): Promise<SimulateAgentResult> {
  const maxSteps = options.maxSteps ?? 100;
  const script: SimulationScript = {
    text: { ...options.script.text },
    decisions: mapValues(options.script.decisions ?? {}, (arr) => [...arr]),
    invokes: mapValues(options.script.invokes ?? {}, (arr) => [...arr]),
  };

  let step = initialAgentStep(machine, options.input);
  const trail: SimulationTrailEntry[] = [];

  for (let i = 0; i < maxSteps; i++) {
    if (step.done) {
      return { status: "done", snapshot: step.snapshot, trail };
    }

    const request = step.requests[0] as AgentStepRequest | undefined;
    if (request) {
      if (request.kind === "decision") {
        // A decision request carries no `src` of its own — correlate it to its
        // invoke src (usually `agent.decide`) via the step's spawn actions.
        const srcById = new Map(pendingInvokes(step).map((invoke) => [invoke.id, invoke.src]));
        const decisionSrc = srcById.get(request.id) ?? request.id;
        const taken = takeFromQueue(script.decisions, decisionSrc);
        if (!taken.found) {
          throw scriptDryError("decision", decisionSrc, request.id, request);
        }
        step = transitionAgentStep(machine, step, taken.value as never);
        trail.push({ state: step.snapshot.value, appliedEvent: taken.value });
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

    // Nothing pending and not done: an intentional wait for an external event.
    return { status: "idle", snapshot: step.snapshot, trail };
  }

  return { status: "exhausted", snapshot: step.snapshot, trail };
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
  return new Error(
    `simulateAgent: script ran dry on a pending ${kind} request for src '${src}' (id '${id}'). ` +
      `Add a '${kind}' entry for '${src}' to the script.${events}`,
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
  /** Canned outputs for text/userInput invokes, keyed by src. A missing src halts that branch with a `needs-output` note. */
  textOutputs?: Record<string, unknown>;
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

type BranchEvent = { type: string; [key: string]: unknown };

// Shared DFS engine for explorePaths/canReach. When `stopWhen` returns true for
// a visited snapshot, exploration halts and the witness path is returned.
async function explore(
  machine: AnyStateMachine,
  options: ExplorePathsOptions,
  stopWhen?: (snapshot: AnyMachineSnapshot) => boolean,
): Promise<{ report: AgentPathReport; witness?: ChosenEvent[] }> {
  const maxDepth = options.maxDepth ?? 8;
  const maxPaths = options.maxPaths ?? 200;
  const textOutputs = options.textOutputs ?? {};

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
  const advance = (step: AgentStep): { step: AgentStep; blockedSrc?: string } => {
    let current = step;
    // Bounded loop: each iteration resolves one text/userInput invoke.
    for (let i = 0; i < 1000; i++) {
      if (current.done) {
        return { step: current };
      }
      const request = current.requests[0] as AgentStepRequest | undefined;
      if (request && request.kind === "text") {
        if (!(request.src in textOutputs)) {
          return { step: current, blockedSrc: request.src };
        }
        current = resolveAgentStep(machine, current, request, textOutputs[request.src]);
        recordState(current.snapshot);
        continue;
      }
      if (request && request.kind === "decision") {
        return { step: current };
      }
      // No request: maybe a pending scripted invoke (userInput), else a wait.
      const [invoke] = pendingInvokes(current);
      if (invoke) {
        if (!(invoke.src in textOutputs)) {
          return { step: current, blockedSrc: invoke.src };
        }
        current = resolveAgentStep(machine, current, invoke.id, textOutputs[invoke.src]);
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

    const { step: settled, blockedSrc } = advance(step);
    if (stopWhen?.(settled.snapshot)) {
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
    const branchEvents: BranchEvent[] =
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
      if (!(settled.snapshot as AnyMachineSnapshot).can(event as never)) {
        prunedByGuard++;
        continue;
      }
      const next = transitionAgentStep(machine, settled, event as never);
      recordState(next.snapshot);
      await visit(next, [...path, event as ChosenEvent], depth + 1);
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
 * an idle wait it forks per externally-accepted event. Text/`userInput` invokes
 * are resolved from `textOutputs` (a by-src canned-output map) — a missing src
 * halts that branch with a `needs-output` terminal rather than throwing.
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
  canReach: boolean;
  /** When reachable, the sequence of chosen/applied events that gets there. */
  witness?: ChosenEvent[];
}

/**
 * Answers "can the machine reach `statePath`?" by exploring its branches (a
 * thin wrapper over {@link explorePaths}). Returns `{ canReach: true, witness }`
 * with the event sequence that reaches it, or `{ canReach: false }`.
 *
 * @example
 * ```ts
 * const { canReach, witness } = await canReach(refundMachine, 'denied', { input: { request: 'x', amount: 5000 } });
 * // canReach → true; witness → [{ type: 'NEEDS_REVIEW' }, { type: 'DENY' }]
 * ```
 */
export async function canReach(
  machine: AnyStateMachine,
  statePath: string,
  options: ExplorePathsOptions = {},
): Promise<CanReachResult> {
  const { witness } = await explore(machine, options, (snapshot) => {
    try {
      return (snapshot as AnyMachineSnapshot).matches(statePath as never);
    } catch {
      return false;
    }
  });
  return witness !== undefined ? { canReach: true, witness } : { canReach: false };
}
