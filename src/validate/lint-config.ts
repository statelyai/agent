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
  const queue: GraphNode[] = [];
  const enter = (node: GraphNode) => {
    for (let at: GraphNode | undefined = node; at && at !== root; at = at.parent) {
      if (!reached.has(at)) {
        reached.add(at);
        queue.push(at);
      }
    }
    const below =
      isHistory(node) && node.parent ? defaultChildren(node.parent) : defaultChildren(node);
    for (const child of below) if (!reached.has(child)) enter(child);
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
 * guards are ignored, an ancestor's transitions count for its descendants,
 * and a parallel state counts as completing when any one region can.
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
  // A final child completes its parent: the machine when the parent is the
  // root, else the parent's `onDone`, or an enclosing parallel state's.
  const completes = (final: GraphNode): boolean => {
    const parent = final.parent!;
    if (parent === root) return true;
    if (anyLive(edges.done.get(parent))) return true;
    const enclosing = parent.parent;
    return (
      !!enclosing &&
      enclosing !== root &&
      isParallel(enclosing) &&
      anyLive(edges.done.get(enclosing))
    );
  };
  const isLive = (node: GraphNode): boolean => {
    if (ancestors(node).some((at) => terminals.has(at.path))) return true;
    if (isHistory(node)) return node.parent!.children.some((sibling) => live.has(sibling));
    if (node.children.length > 0) return defaultChildren(node).some((child) => live.has(child));
    if (isFinal(node) && completes(node)) return true;
    return ancestors(node).some((at) => anyLive(edges.active.get(at)));
  };

  for (let changed = true; changed;) {
    changed = false;
    for (const node of byPath.values()) {
      if (!live.has(node) && isLive(node)) {
        live.add(node);
        changed = true;
      }
    }
  }
  return live;
}

// ─── decision events ───

/** The `on` keys of a state and its ancestors, with whether every transition on the key is tagged `actor: "human"`. */
function handledEvents(node: GraphNode): Map<string, boolean> {
  const handled = new Map<string, boolean>();
  for (let at: GraphNode | undefined = node; at; at = at.parent) {
    for (const [type, transitions] of Object.entries(
      (at.state.on ?? {}) as Record<string, unknown>,
    )) {
      const human = nodes(transitions).every(
        (t) => (t.meta as ConfigNode | undefined)?.actor === "human",
      );
      handled.set(type, (handled.get(type) ?? true) && human);
    }
  }
  return handled;
}

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
      const handled = handledEvents(node);
      const listed = allowedEvents === undefined ? undefined : toList(allowedEvents);
      const concrete = (types: unknown[]) =>
        types.filter((type): type is string => typeof type === "string" && !isEventPattern(type));

      // The events the model may send: the listed ones, or every handled
      // event a model is offered (not human-only, not library-delivered).
      const candidates = listed
        ? concrete(listed)
        : concrete([...handled].filter(([, human]) => !human).map(([type]) => type)).filter(
            (type) => !type.startsWith("xstate.") && !type.startsWith("@agent."),
          );

      for (const type of candidates) {
        const handlers = [...handled].filter(([key]) => matchesEventPattern(type, key));
        if (listed && handlers.length === 0) {
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
        // A human-only event is never offered (`decide-allows-human-event`).
        if (handlers.length > 0 && handlers.every(([, human]) => human)) continue;
        // Listed payloads close the choice: the model picks one of them.
        if (type in schemas || (isPlainObject(payloads) && payloads[type] !== undefined)) continue;
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
