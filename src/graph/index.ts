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
import ts from 'typescript';
import type {
  AgentMachine,
  MachineConfig,
  StateConfig,
  TransitionResult,
} from '../types.js';

export interface AgentGraphNodeData {
  type: 'state' | 'choice' | 'final';
}

export interface AgentGraphEdgeData {
  event?: string;
  guard?: {
    type: string;
  };
  actions?: {
    context?: boolean;
    input?: boolean;
  };
}

export interface AgentGraph
  extends StatelyGraph<AgentGraphNodeData, AgentGraphEdgeData> {}
export interface AgentGraphNode
  extends StatelyGraphNode<AgentGraphNodeData> {}
export interface AgentGraphEdge
  extends StatelyGraphEdge<AgentGraphEdgeData> {}

type InternalMachine = AgentMachine & {
  __config?: MachineConfig<any, any, any, any, any>;
};

type EdgeCandidate = {
  target: string;
  guard?: string;
  hasContext?: boolean;
  hasInput?: boolean;
};

/**
 * Convert an agent machine to a Stately graph-compatible plain JSON object.
 *
 * Finite states come directly from the authored `states` object. Edges are
 * inferred from static transition objects and transition handler ASTs.
 */
export function toGraph(machine: AgentMachine): AgentGraph {
  const config = (machine as InternalMachine).__config;
  if (!config) {
    throw new Error('Machine config metadata is unavailable for graph export');
  }

  const nodes: Array<NodeConfig<AgentGraphNodeData>> = Object.entries(
    config.states
  ).map(([id, state]) => ({
    id,
    label: id,
    data: {
      type: getNodeType(state as StateConfig),
    },
  }));

  const edges: Array<EdgeConfig<AgentGraphEdgeData>> = [];
  for (const [sourceId, state] of Object.entries(config.states)) {
    const stateConfig = state as StateConfig;

    if (stateConfig.onDone) {
      edges.push(
        ...getTransitionEdges({
          sourceId,
          event: 'done',
          transition: stateConfig.onDone,
          ordinalOffset: edges.length,
        })
      );
    }

    if (!stateConfig.on) {
      continue;
    }

    for (const [event, transition] of Object.entries(stateConfig.on)) {
      edges.push(
        ...getTransitionEdges({
          sourceId,
          event,
          transition,
          ordinalOffset: edges.length,
        })
      );
    }
  }

  return createGraph<AgentGraphNodeData, AgentGraphEdgeData>({
    id: machine.id,
    initialNodeId:
      typeof config.initial === 'string' ? config.initial : undefined,
    nodes,
    edges,
  });
}

export function toMermaid(machine: AgentMachine): string {
  return toMermaidState(toMermaidStateGraph(toGraph(machine)));
}

function getNodeType(state: StateConfig): AgentGraphNodeData['type'] {
  if (state.type === 'final') {
    return 'final';
  }

  if (state.type === 'choice') {
    return 'choice';
  }

  return 'state';
}

function toMermaidStateGraph(graph: AgentGraph): MermaidStateGraph {
  const nodes: Array<NodeConfig<StateNodeData>> = graph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    data: {
      ...(node.data.type === 'choice' ? { stateType: 'choice' as const } : {}),
    },
  }));

  const edges: Array<EdgeConfig<StateEdgeData>> = graph.edges.map((edge) => ({
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    label: edge.label ?? undefined,
    data: {},
  }));

  if (graph.initialNodeId) {
    const startId = `${graph.id}.__start`;
    nodes.push({
      id: startId,
      data: { isStart: true },
    });
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
    nodes.push({
      id: endId,
      data: { isEnd: true },
    });
    edges.push({
      id: `${node.id}:final`,
      sourceId: node.id,
      targetId: endId,
      data: {},
    });
  }

  return createGraph<StateNodeData, StateEdgeData, StateGraphData>({
    id: graph.id,
    type: graph.type,
    initialNodeId: graph.initialNodeId ?? undefined,
    data: {
      diagramType: 'stateDiagram',
    },
    nodes,
    edges,
  });
}

function getTransitionEdges(args: {
  sourceId: string;
  event: string;
  transition: unknown;
  ordinalOffset: number;
}): Array<EdgeConfig<AgentGraphEdgeData>> {
  const candidates =
    typeof args.transition === 'function'
      ? analyzeTransitionFunction(args.transition)
      : analyzeTransitionObject(args.transition);

  return candidates.map((candidate, index) => ({
    id: `${args.sourceId}:${args.event}:${args.ordinalOffset + index}`,
    sourceId: args.sourceId,
    targetId: candidate.target,
    label: getEdgeLabel(args.event, candidate.guard),
    data: {
      event: args.event,
      ...(candidate.guard
        ? {
            guard: {
              type: candidate.guard,
            },
          }
        : {}),
      ...((candidate.hasContext || candidate.hasInput)
        ? {
            actions: {
              ...(candidate.hasContext ? { context: true } : {}),
              ...(candidate.hasInput ? { input: true } : {}),
            },
          }
        : {}),
    },
  }));
}

function analyzeTransitionObject(transition: unknown): EdgeCandidate[] {
  const target =
    transition && typeof transition === 'object'
      ? (transition as TransitionResult).target
      : undefined;

  if (
    transition
    && typeof transition === 'object'
    && 'target' in transition
    && typeof target === 'string'
  ) {
    return [
      {
        target,
        hasContext: 'context' in transition,
        hasInput: 'input' in transition,
      },
    ];
  }

  return [];
}

function analyzeTransitionFunction(fn: Function): EdgeCandidate[] {
  const source = fn.toString();
  const file = ts.createSourceFile(
    'transition.ts',
    `const __transition = ${source};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const transitionFunction = findTransitionFunction(file);

  if (!transitionFunction) {
    return [];
  }

  const candidates: EdgeCandidate[] = [];
  const ancestors: ts.Node[] = [];

  function visit(node: ts.Node) {
    if (node !== transitionFunction && isFunctionLike(node)) {
      return;
    }

    if (
      ts.isArrowFunction(node)
      && !ts.isBlock(node.body)
      && ts.isExpression(node.body)
    ) {
      candidates.push(
        ...analyzeTransitionExpression(
          node.body,
          findGuardForReturnLike(node, ancestors, file),
          file
        )
      );
    }

    if (ts.isReturnStatement(node) && node.expression) {
      candidates.push(
        ...analyzeTransitionExpression(
          node.expression,
          findGuardForReturnLike(node, ancestors, file),
          file
        )
      );
    }

    ancestors.push(node);
    ts.forEachChild(node, visit);
    ancestors.pop();
  }

  visit(transitionFunction);

  return candidates;
}

function findTransitionFunction(file: ts.SourceFile): ts.FunctionLike | undefined {
  let transitionFunction: ts.FunctionLike | undefined;

  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === '__transition'
      && node.initializer
      && isFunctionLike(node.initializer)
    ) {
      transitionFunction = node.initializer;
      return;
    }

    if (!transitionFunction) {
      ts.forEachChild(node, visit);
    }
  }

  visit(file);
  return transitionFunction;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLike {
  return (
    ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
  );
}

function analyzeTransitionExpression(
  expression: ts.Expression,
  guard: string | undefined,
  file: ts.SourceFile
): EdgeCandidate[] {
  let current = expression;

  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }

  if (ts.isConditionalExpression(current)) {
    const condition = current.condition.getText(file);

    return [
      ...analyzeTransitionExpression(
        current.whenTrue,
        combineGuards(guard, condition),
        file
      ),
      ...analyzeTransitionExpression(
        current.whenFalse,
        combineGuards(guard, `!(${condition})`),
        file
      ),
    ];
  }

  const object = unwrapParenthesizedObject(current);
  const target = object ? getStringProperty(object, 'target') : undefined;
  if (!target) {
    return [];
  }

  return [
    {
      target,
      guard,
      hasContext: object ? hasProperty(object, 'context') : false,
      hasInput: object ? hasProperty(object, 'input') : false,
    },
  ];
}

function unwrapParenthesizedObject(
  expression: ts.Expression
): ts.ObjectLiteralExpression | undefined {
  let current = expression;

  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }

  return ts.isObjectLiteralExpression(current) ? current : undefined;
}

function getStringProperty(
  object: ts.ObjectLiteralExpression,
  name: string
): string | undefined {
  const property = object.properties.find((candidate) => {
    return (
      ts.isPropertyAssignment(candidate)
      && ts.isIdentifier(candidate.name)
      && candidate.name.text === name
    );
  });

  if (!property || !ts.isPropertyAssignment(property)) {
    return undefined;
  }

  const initializer = property.initializer;
  return ts.isStringLiteralLike(initializer) ? initializer.text : undefined;
}

function hasProperty(object: ts.ObjectLiteralExpression, name: string): boolean {
  return object.properties.some((candidate) => {
    return (
      ts.isPropertyAssignment(candidate)
      && ts.isIdentifier(candidate.name)
      && candidate.name.text === name
    );
  });
}

function findGuardForReturnLike(
  returnNode: ts.Node,
  ancestors: ts.Node[],
  file: ts.SourceFile
): string | undefined {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (!ancestor || !ts.isIfStatement(ancestor)) {
      continue;
    }

    if (containsNode(ancestor.thenStatement, returnNode)) {
      return ancestor.expression.getText(file);
    }

    if (ancestor.elseStatement && containsNode(ancestor.elseStatement, returnNode)) {
      return `!(${ancestor.expression.getText(file)})`;
    }
  }

  return undefined;
}

function containsNode(parent: ts.Node, child: ts.Node): boolean {
  if (parent === child) {
    return true;
  }

  let found = false;
  function visit(node: ts.Node) {
    if (node === child) {
      found = true;
      return;
    }

    if (!found) {
      ts.forEachChild(node, visit);
    }
  }

  visit(parent);
  return found;
}

function getEdgeLabel(event: string, guard: string | undefined): string {
  if (!guard) {
    return event;
  }

  return `${event} [${guard}]`;
}

function combineGuards(
  outer: string | undefined,
  inner: string
): string {
  if (!outer) {
    return inner;
  }

  return `(${outer}) && (${inner})`;
}
