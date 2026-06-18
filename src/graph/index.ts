import {
  createGraph,
  type EdgeConfig,
  type Graph as StatelyGraph,
  type GraphEdge as StatelyGraphEdge,
  type GraphNode as StatelyGraphNode,
  type NodeConfig,
} from '@statelyai/graph';
import {
  toMermaidState,
  type MermaidStateGraph,
  type StateEdgeData,
  type StateGraphData,
  type StateNodeData,
} from '@statelyai/graph/mermaid';

export interface AgentGraphNodeData {
  type: 'state' | 'final';
}

export interface AgentGraphEdgeData {
  event?: string;
  source?: 'event' | 'invoke.done' | 'always';
}

export interface AgentGraphData {}

export type AgentGraphWarningCode =
  | 'missing-initial'
  | 'dangling-target'
  | 'unreachable-state'
  | 'dead-end-state'
  | 'missing-invoke-id';

export interface AgentGraphWarning {
  code: AgentGraphWarningCode;
  state: string;
  event?: string;
  target?: string;
  message: string;
}

export interface AgentGraphAnalysis {
  graph: AgentGraph;
  warnings: AgentGraphWarning[];
}

export interface AgentGraph
  extends StatelyGraph<AgentGraphNodeData, AgentGraphEdgeData, AgentGraphData> {}
export interface AgentGraphNode
  extends StatelyGraphNode<AgentGraphNodeData> {}
export interface AgentGraphEdge
  extends StatelyGraphEdge<AgentGraphEdgeData> {}

export type XStateLikeMachine = {
  id: string;
  config: XStateLikeConfig;
};

type XStateLikeConfig = {
  id?: string;
  initial?: unknown;
  states?: Record<string, XStateLikeState>;
};

type XStateLikeState = {
  type?: string;
  on?: Record<string, unknown> | string;
  always?: unknown;
  invoke?: unknown;
};

export function toGraph(machine: XStateLikeMachine): AgentGraph {
  return analyzeGraph(machine).graph;
}

export function analyzeGraph(machine: XStateLikeMachine): AgentGraphAnalysis {
  const config = machine.config;
  const stateEntries = Object.entries(config.states ?? {});
  const nodes: Array<NodeConfig<AgentGraphNodeData>> = stateEntries.map(
    ([id, state]) => ({
      id,
      label: id,
      data: { type: state.type === 'final' ? 'final' : 'state' },
    })
  );
  const edges: Array<EdgeConfig<AgentGraphEdgeData>> = [];
  const warnings: AgentGraphWarning[] = [];
  const stateIds = new Set(stateEntries.map(([id]) => id));
  const initial = typeof config.initial === 'string' ? config.initial : undefined;
  let edgeIndex = 0;

  if (initial && !stateIds.has(initial)) {
    warnings.push({
      code: 'missing-initial',
      state: initial,
      message: `Initial state '${initial}' does not exist.`,
    });
  }

  for (const [sourceId, state] of stateEntries) {
    for (const target of collectTargets(state.always)) {
      edges.push(edge(edgeIndex++, sourceId, target, 'always', ''));
      warnIfDanglingTarget(warnings, stateIds, sourceId, target, '');
    }

    for (const [event, transition] of Object.entries(normalizeOn(state.on))) {
      for (const target of collectTargets(transition)) {
        edges.push(edge(edgeIndex++, sourceId, target, 'event', event));
        warnIfDanglingTarget(warnings, stateIds, sourceId, target, event);
      }
    }

    for (const invoke of normalizeInvokes(state.invoke)) {
      if (!hasDurableInvokeId(invoke)) {
        warnings.push({
          code: 'missing-invoke-id',
          state: sourceId,
          event: 'invoke',
          message: `Invoke in state '${sourceId}' is missing a durable id.`,
        });
      }
    }

    for (const target of collectInvokeDoneTargets(state.invoke)) {
      edges.push(edge(edgeIndex++, sourceId, target, 'invoke.done', `done.invoke.${sourceId}`));
      warnIfDanglingTarget(
        warnings,
        stateIds,
        sourceId,
        target,
        `done.invoke.${sourceId}`
      );
    }
  }

  const reachable = collectReachableStates(initial, stateEntries, edges, stateIds);
  for (const [stateId, state] of stateEntries) {
    if (initial && stateId !== initial && !reachable.has(stateId)) {
      warnings.push({
        code: 'unreachable-state',
        state: stateId,
        message: `State '${stateId}' is not reachable from initial state '${initial}'.`,
      });
    }

    if (state.type !== 'final' && isDeadEndState(state)) {
      warnings.push({
        code: 'dead-end-state',
        state: stateId,
        message: `State '${stateId}' has no outgoing transitions, invokes, or event handlers.`,
      });
    }
  }

  return {
    graph: createGraph<AgentGraphNodeData, AgentGraphEdgeData, AgentGraphData>({
      id: machine.id,
      initialNodeId: typeof config.initial === 'string' ? config.initial : undefined,
      nodes,
      edges,
    }),
    warnings,
  };
}

export function toMermaid(machine: XStateLikeMachine): string {
  return toMermaidState(toMermaidStateGraph(toGraph(machine)));
}

function edge(
  index: number,
  sourceId: string,
  targetId: string,
  source: NonNullable<AgentGraphEdgeData['source']>,
  event?: string
): EdgeConfig<AgentGraphEdgeData> {
  return {
    id: `${sourceId}:${event ?? source}:${targetId}:${index}`,
    sourceId,
    targetId,
    label: event || undefined,
    data: { source, ...(event ? { event } : {}) },
  };
}

function normalizeOn(on: XStateLikeState['on']): Record<string, unknown> {
  if (!on || typeof on === 'string' || Array.isArray(on)) {
    return {};
  }
  return on;
}

function collectInvokeDoneTargets(invoke: unknown): string[] {
  return normalizeInvokes(invoke).flatMap((item) =>
    item && typeof item === 'object'
      ? collectTargets((item as { onDone?: unknown }).onDone)
      : []
  );
}

function normalizeInvokes(invoke: unknown): unknown[] {
  return Array.isArray(invoke) ? invoke : invoke ? [invoke] : [];
}

function hasDurableInvokeId(invoke: unknown): boolean {
  return (
    !!invoke
    && typeof invoke === 'object'
    && typeof (invoke as { id?: unknown }).id === 'string'
    && (invoke as { id: string }).id.length > 0
  );
}

function collectTargets(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (typeof value === 'string') {
    return [stripTarget(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectTargets);
  }

  if (typeof value !== 'object') {
    return [];
  }

  const target = (value as { target?: unknown }).target;
  if (Array.isArray(target)) {
    return target.filter((item): item is string => typeof item === 'string').map(stripTarget);
  }

  return typeof target === 'string' ? [stripTarget(target)] : [];
}

function stripTarget(target: string): string {
  return target.replace(/^#/, '').split('.').at(-1) ?? target;
}

function warnIfDanglingTarget(
  warnings: AgentGraphWarning[],
  stateIds: Set<string>,
  state: string,
  target: string,
  event?: string
) {
  if (stateIds.has(target)) {
    return;
  }

  warnings.push({
    code: 'dangling-target',
    state,
    event: event || undefined,
    target,
    message: `Transition from '${state}' targets missing state '${target}'.`,
  });
}

function collectReachableStates(
  initial: string | undefined,
  stateEntries: [string, XStateLikeState][],
  edges: Array<EdgeConfig<AgentGraphEdgeData>>,
  stateIds: Set<string>
): Set<string> {
  const firstState = stateEntries[0]?.[0];
  const start = initial && stateIds.has(initial) ? initial : firstState;
  const reachable = new Set<string>();

  if (!start) {
    return reachable;
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!stateIds.has(edge.targetId)) {
      continue;
    }
    const targets = adjacency.get(edge.sourceId) ?? [];
    targets.push(edge.targetId);
    adjacency.set(edge.sourceId, targets);
  }

  const queue = [start];
  while (queue.length > 0) {
    const state = queue.shift()!;
    if (reachable.has(state)) {
      continue;
    }
    reachable.add(state);
    queue.push(...(adjacency.get(state) ?? []));
  }

  return reachable;
}

function isDeadEndState(state: XStateLikeState): boolean {
  return (
    Object.keys(normalizeOn(state.on)).length === 0
    && collectTargets(state.always).length === 0
    && normalizeInvokes(state.invoke).length === 0
  );
}

function toMermaidStateGraph(graph: AgentGraph): MermaidStateGraph {
  const nodes: Array<NodeConfig<StateNodeData>> = graph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    data: {},
  }));

  const edges: Array<EdgeConfig<StateEdgeData>> = graph.edges.map((graphEdge) => ({
    id: graphEdge.id,
    sourceId: graphEdge.sourceId,
    targetId: graphEdge.targetId,
    label: graphEdge.label ?? undefined,
    data: {},
  }));

  if (graph.initialNodeId) {
    const startId = `${graph.id}.__start`;
    nodes.push({ id: startId, data: { isStart: true } });
    edges.unshift({
      id: `${startId}:initial`,
      sourceId: startId,
      targetId: graph.initialNodeId,
      data: {},
    });
  }

  for (const node of graph.nodes) {
    if (node.data.type !== 'final') {
      continue;
    }
    const endId = `${node.id}.__end`;
    nodes.push({ id: endId, data: { isEnd: true } });
    edges.push({
      id: `${node.id}:final`,
      sourceId: node.id,
      targetId: endId,
      data: {},
    });
  }

  return createGraph<StateNodeData, StateEdgeData, StateGraphData>({
    id: graph.id,
    initialNodeId: graph.initialNodeId ?? undefined,
    data: { diagramType: 'stateDiagram' },
    nodes,
    edges,
  });
}
