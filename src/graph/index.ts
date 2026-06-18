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

export interface AgentGraphWarning {
  state: string;
  event: string;
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
  let edgeIndex = 0;

  for (const [sourceId, state] of stateEntries) {
    for (const target of collectTargets(state.always)) {
      edges.push(edge(edgeIndex++, sourceId, target, 'always', ''));
    }

    for (const [event, transition] of Object.entries(normalizeOn(state.on))) {
      for (const target of collectTargets(transition)) {
        edges.push(edge(edgeIndex++, sourceId, target, 'event', event));
      }
    }

    for (const target of collectInvokeDoneTargets(state.invoke)) {
      edges.push(edge(edgeIndex++, sourceId, target, 'invoke.done', `done.invoke.${sourceId}`));
    }
  }

  return {
    graph: createGraph<AgentGraphNodeData, AgentGraphEdgeData, AgentGraphData>({
      id: machine.id,
      initialNodeId: typeof config.initial === 'string' ? config.initial : undefined,
      nodes,
      edges,
    }),
    warnings: [],
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
  const invokes = Array.isArray(invoke) ? invoke : invoke ? [invoke] : [];
  return invokes.flatMap((item) =>
    item && typeof item === 'object'
      ? collectTargets((item as { onDone?: unknown }).onDone)
      : []
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
