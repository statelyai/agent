import type { AgentMachine } from '../types.js';

export interface GraphNode {
  id: string;
  type: 'state' | 'decide' | 'classify' | 'final';
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Convert an agent machine to a graph representation.
 * TODO: implement AST analysis for edge extraction
 */
export function toGraph(_machine: AgentMachine): Graph {
  throw new Error('toGraph is not yet implemented');
}

/**
 * Convert an agent machine to a Mermaid stateDiagram-v2 string.
 * TODO: implement
 */
export function toMermaid(_machine: AgentMachine): string {
  throw new Error('toMermaid is not yet implemented');
}
