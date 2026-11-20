/**
 * Static checks over a workflow config's state graph. A config is data, so
 * every transition target is a literal and the graph is known before the
 * config lowers. The `lint` gate of `verifyAgentConfig` runs these next to
 * `lintAgentMachine`.
 */
import { isEventPattern, matchesEventPattern } from "../events.js";
import { ACT_ACTOR, DECIDE_ACTOR } from "../text-logic.js";
import type { AgentWorkflowConfig } from "../workflow-config.js";

/** One finding from {@link lintAgentConfig}, shaped like `AgentLintDiagnostic`. */
export interface AgentConfigLintDiagnostic {
  code:
    | "unreachable-state"
    | "state-cannot-finish"
    | "decide-event-without-schema"
    | "decide-event-unhandled";
  severity: "error";
  /** Dotted state path. */
  path: string;
  message: string;
}

interface LintConfigOptions {
  /** Non-final state paths that may wait forever; `state-cannot-finish` treats them as finishing. */
  terminalStates?: readonly string[];
}

type ConfigNode = Record<string, unknown>;

interface GraphNode {
  key: string;
  path: string;
  state: ConfigNode;
  parent: GraphNode | undefined;
  children: GraphNode[];
}

const toList = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const nodes = (value: unknown): ConfigNode[] =>
  toList(value).filter((node): node is ConfigNode => !!node && typeof node === "object");

const isPlainObject = (value: unknown): value is ConfigNode =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Runs the config graph checks. Never throws: a config whose targets cannot
 * all be resolved statically skips the two graph checks (`unreachable-state`,
 * `state-cannot-finish`) rather than risk a false finding.
 */
export function lintAgentConfig(
  config: AgentWorkflowConfig,
  options: LintConfigOptions = {},
): AgentConfigLintDiagnostic[] {
  const root: GraphNode = {
    key: "",
    path: "",
    state: config as unknown as ConfigNode,
    parent: undefined,
    children: [],
  };
  const byPath = new Map<string, GraphNode>();
  const build = (parent: GraphNode) => {
    for (const [key, state] of Object.entries(
      (parent.state.states ?? {}) as Record<string, ConfigNode>,
    )) {
      const node: GraphNode = {
        key,
        path: parent.path ? `${parent.path}.${key}` : key,
        state: isPlainObject(state) ? state : {},
        parent,
        children: [],
      };
      parent.children.push(node);
      byPath.set(node.path, node);
      build(node);
    }
  };
  build(root);

  const graph = buildEdges(config, root, byPath);
  return [
    ...(graph ? checkGraph(root, byPath, graph, options) : []),
    ...checkDecisionEvents(config, byPath),
  ];
}

// ─── graph ───

interface Edges {
  /** Targets a state's own transitions enter while it is active (`on`, `after`, `always`, `choice`, invoke results). */
  active: Map<GraphNode, GraphNode[]>;
  /** Targets of a compound or parallel state's own `onDone`, taken when it completes. */
  done: Map<GraphNode, GraphNode[]>;
}

/** Every transition target as a node, or `undefined` when any target does not resolve. */
function buildEdges(
  config: AgentWorkflowConfig,
  root: GraphNode,
  byPath: Map<string, GraphNode>,
): Edges | undefined {
  const edges: Edges = { active: new Map(), done: new Map() };
  let resolved = true;
  const resolve = (from: GraphNode, target: string): GraphNode | undefined => {
    if (target.startsWith("#")) {
      const id = config.id;
      const rest = target.slice(1);
      if (!id) return undefined;
      if (rest === id) return root;
      return rest.startsWith(`${id}.`) ? byPath.get(rest.slice(id.length + 1)) : undefined;
    }
    if (target.startsWith(".")) return byPath.get(`${from.path}${target}`);
    const base = from.parent?.path;
    return byPath.get(base ? `${base}.${target}` : target);
  };
  const targetsOf = (from: GraphNode, transitions: unknown): GraphNode[] =>
    nodes(transitions).flatMap((transition) =>
      toList(transition.target).flatMap((target) => {
        const node = typeof target === "string" ? resolve(from, target) : undefined;
        if (!node) resolved = false;
        return node ? [node] : [];
      }),
    );

  for (const node of byPath.values()) {
    const { state } = node;
    edges.active.set(node, [
      ...Object.values((state.on ?? {}) as Record<string, unknown>).flatMap((t) =>
        targetsOf(node, t),
      ),
      ...Object.values((state.after ?? {}) as Record<string, unknown>).flatMap((t) =>
        targetsOf(node, t),
      ),
      ...targetsOf(node, state.always),
      ...targetsOf(node, state.choice),
      ...nodes(state.invoke).flatMap((invoke) => [
        ...targetsOf(node, invoke.onDone),
        ...targetsOf(node, invoke.onError),
      ]),
    ]);
    edges.done.set(node, targetsOf(node, state.onDone));
  }
  return resolved ? edges : undefined;
}

const isFinal = (node: GraphNode) => node.state.type === "final";
const isParallel = (node: GraphNode) => node.state.type === "parallel";
const isHistory = (node: GraphNode) => node.state.type === "history";

/** The states entering `node` activates below it: the initial child, or every region of a parallel state. */
function defaultChildren(node: GraphNode): GraphNode[] {
  if (node.children.length === 0) return [];
  if (isParallel(node)) return node.children;
  const initial = node.children.find((child) => child.key === node.state.initial);
  // A missing or unknown initial fails lowering; count every child rather than guess.
  return initial ? [initial] : node.children;
}

function checkGraph(
  root: GraphNode,
  byPath: Map<string, GraphNode>,
  edges: Edges,
  options: LintConfigOptions,
): AgentConfigLintDiagnostic[] {
  // Reachability over-approximates: guards are ignored, every edge is taken,
  // and a history state stands for its parent's default entry.
  const reached = new Set<GraphNode>();
  const entered = new Set<GraphNode>();
  const queue: GraphNode[] = [];
  const enter = (node: GraphNode) => {
    if (entered.has(node)) return;
    entered.add(node);
    for (let at: GraphNode | undefined = node; at && at !== root; at = at.parent) {
      if (!reached.has(at)) {
        reached.add(at);
        queue.push(at);
      }
      // Entering one region of a parallel state enters every other region.
      if (at.parent && isParallel(at.parent)) {
        for (const region of at.parent.children) enter(region);
      }
    }
    const below =
      isHistory(node) && node.parent ? defaultChildren(node.parent) : defaultChildren(node);
    for (const child of below) enter(child);
  };
  for (const child of defaultChildren(root)) enter(child);
  while (queue.length) {
    const node = queue.pop()!;
    for (const target of [...edges.active.get(node)!, ...edges.done.get(node)!]) enter(target);
  }

  const diagnostics: AgentConfigLintDiagnostic[] = [];
  for (const node of byPath.values()) {
    // Report the outermost unreachable state; its children follow from it.
    if (reached.has(node) || (node.parent && node.parent !== root && !reached.has(node.parent))) {
      continue;
    }
    diagnostics.push({
      code: "unreachable-state",
      severity: "error",
      path: node.path,
      message:
        `State '${node.path}' is unreachable: it is not an initial state, and no transition from ` +
        `a reachable state targets it. Add a transition that targets '${node.path}', or delete the state.`,
    });
  }

  // A config with no final state is a long-running service: nothing to finish.
  const finals = [...byPath.values()].filter(isFinal);
  if (finals.length === 0) return diagnostics;

  const live = finishingStates(root, byPath, edges, new Set(options.terminalStates ?? []));
  for (const node of byPath.values()) {
    if (!reached.has(node) || live.has(node) || node.children.length > 0 || isHistory(node)) {
      continue;
    }
    diagnostics.push({
      code: "state-cannot-finish",
      severity: "error",
      path: node.path,
      message:
        `State '${node.path}' can never reach a final state: no path of transitions from it ` +
        `(events, 'after', 'always', choice branches, invoke 'onDone'/'onError') leads to one, so ` +
        `a run that enters it never finishes. Add a transition from it toward a final state, or ` +
        `list it in lint.terminalStates if it waits forever on purpose.`,
    });
  }
  return diagnostics;
}

/**
 * The states from which some path ends the machine, as a fixpoint. Generous
 * where the config is ambiguous, so a reported state truly has no way out:
 * guards are ignored, an ancestor's transitions count for its descendants, a
 * sibling region's transition out of its region counts for every state in a
 * parallel state, and a parallel state counts as completing when any one
 * region can.
 */
function finishingStates(
  root: GraphNode,
  byPath: Map<string, GraphNode>,
  edges: Edges,
  terminals: Set<string>,
): Set<GraphNode> {
  const live = new Set<GraphNode>();
  const anyLive = (targets: GraphNode[] | undefined) => !!targets?.some((t) => live.has(t));
  const ancestors = (node: GraphNode) => {
    const chain: GraphNode[] = [];
    for (let at: GraphNode | undefined = node; at && at !== root; at = at.parent) chain.push(at);
    return chain;
  };
  const within = (node: GraphNode, scope: GraphNode) => {
    for (let at: GraphNode | undefined = node; at; at = at.parent) if (at === scope) return true;
    return false;
  };
  // A state that just became done ends the machine (the root), takes its
  // `onDone`, or, as a region, completes its parallel parent in turn.
  const completes = (done: GraphNode): boolean => {
    if (done === root) return true;
    if (anyLive(edges.done.get(done))) return true;
    return isParallel(done.parent!) && completes(done.parent!);
  };
  // A transition from any state in another region of a parallel ancestor that
  // leaves that region also moves this state.
  const siblingRegionExits = (node: GraphNode): boolean =>
    ancestors(node).some(
      (at) =>
        isParallel(at.parent!) &&
        at.parent!.children.some(
          (region) =>
            region !== at &&
            [...byPath.values()].some(
              (state) =>
                within(state, region) &&
                [...edges.active.get(state)!, ...edges.done.get(state)!].some(
                  (target) => !within(target, region) && live.has(target),
                ),
            ),
        ),
    );
  const isLive = (node: GraphNode): boolean => {
    if (ancestors(node).some((at) => terminals.has(at.path))) return true;
    if (isHistory(node)) return node.parent!.children.some((sibling) => live.has(sibling));
    if (node.children.length > 0) return defaultChildren(node).some((child) => live.has(child));
    if (isFinal(node) && completes(node.parent!)) return true;
    return ancestors(node).some((at) => anyLive(edges.active.get(at))) || siblingRegionExits(node);
  };

  // The root is a target too (`#<id>` resets the machine): live when its initial state is.
  for (let changed = true; changed;) {
    changed = false;
    for (const node of [root, ...byPath.values()]) {
      if (!live.has(node) && isLive(node)) {
        live.add(node);
        changed = true;
      }
    }
  }
  return live;
}

// ─── decision events ───

/** The `on` keys of `states`, with whether any transition on the key is tagged `actor: "human"` (the runtime then never offers it; see `getHumanEventTypes`). */
function handledEvents(states: GraphNode[]): Map<string, boolean> {
  const handled = new Map<string, boolean>();
  for (const at of states) {
    for (const [type, transitions] of Object.entries(
      (at.state.on ?? {}) as Record<string, unknown>,
    )) {
      const human = nodes(transitions).some(
        (t) => (t.meta as ConfigNode | undefined)?.actor === "human",
      );
      handled.set(type, (handled.get(type) ?? false) || human);
    }
  }
  return handled;
}

const descendants = (node: GraphNode): GraphNode[] => [node, ...node.children.flatMap(descendants)];

/** True for a literal `allowedEvents`: omitted, or a string or string list with no `{{ }}` template. */
const isLiteralEventList = (value: unknown) =>
  value === undefined ||
  toList(value).every((entry) => typeof entry === "string" && !entry.includes("{{"));

const isOfferable = (type: string) =>
  !isEventPattern(type) && !type.startsWith("xstate.") && !type.startsWith("@agent.");

function checkDecisionEvents(
  config: AgentWorkflowConfig,
  byPath: Map<string, GraphNode>,
): AgentConfigLintDiagnostic[] {
  const schemas = (config.schemas?.events ?? {}) as Record<string, unknown>;
  const diagnostics: AgentConfigLintDiagnostic[] = [];
  for (const node of byPath.values()) {
    for (const invoke of nodes(node.state.invoke)) {
      const src = invoke.src;
      if ((src !== DECIDE_ACTOR && src !== ACT_ACTOR) || !isPlainObject(invoke.input)) continue;
      // A raw `@expr` input is opaque; the vocabulary gate rejects it.
      if (typeof invoke.input["@expr"] === "string") continue;
      const { allowedEvents, payloads } = invoke.input;
      // A templated list resolves at run time, so its events are unknown here.
      if (!isLiteralEventList(allowedEvents)) continue;

      const scope: GraphNode[] = [];
      for (let at: GraphNode | undefined = node; at; at = at.parent) scope.push(at);
      // States in other regions of a parallel ancestor may be active too; the
      // runtime offers the events they handle.
      const concurrent = scope.flatMap((at) =>
        at.parent && isParallel(at.parent)
          ? at.parent.children.filter((region) => region !== at).flatMap(descendants)
          : [],
      );
      const own = [...handledEvents(scope).keys()].filter(isOfferable);
      const offered = [...handledEvents([...scope, ...concurrent])];

      // The events the model may send: the listed ones, with each pattern
      // expanded over the events this state and its ancestors handle, or
      // every such event when the list is omitted.
      const listed = allowedEvents === undefined ? undefined : (toList(allowedEvents) as string[]);
      const candidates = new Set(
        listed
          ? listed.flatMap((entry) =>
              isEventPattern(entry)
                ? own.filter((type) => matchesEventPattern(type, entry))
                : [entry],
            )
          : own,
      );

      for (const type of candidates) {
        const handlers = offered.filter(([key]) => matchesEventPattern(type, key));
        if (handlers.length === 0) {
          diagnostics.push({
            code: "decide-event-unhandled",
            severity: "error",
            path: node.path,
            message:
              `State '${node.path}' lists '${type}' in ${src} allowedEvents, but neither ` +
              `'${node.path}' nor an ancestor handles it, so the model is never offered it. Add an ` +
              `'on.${type}' transition, or remove '${type}' from allowedEvents.`,
          });
          continue;
        }
        // A human event is never offered (`decide-allows-human-event`).
        if (handlers.some(([, human]) => human)) continue;
        // Listed payloads close the choice: the model picks one of them. A
        // templated payloads value resolves at run time and may list any event.
        if (type in schemas || (payloads !== undefined && !isPlainObject(payloads))) continue;
        if (isPlainObject(payloads) && payloads[type] !== undefined) continue;
        diagnostics.push({
          code: "decide-event-without-schema",
          severity: "error",
          path: node.path,
          message:
            `State '${node.path}' lets ${src} send '${type}', but schemas.events has no '${type}' ` +
            `entry, so the payload the model sends reaches the machine unvalidated. Add ` +
            `schemas.events.${type} (use { "type": "object", "properties": {} } for an event with no payload).`,
        });
      }
    }
  }
  return diagnostics;
}
