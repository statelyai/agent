import { toGraph, type AgentGraph, type AgentGraphEdge } from '../graph/index.js';
import type { AgentMachine, MachineConfig, StateConfig } from '../types.js';

export interface XStateMachineConfig {
  id: string;
  initial?: string;
  meta: {
    agent: {
      format: '@statelyai/agent/xstate-visualization';
      runnable: false;
      note: string;
    };
  };
  states: Record<string, XStateStateConfig>;
}

export interface XStateStateConfig {
  type?: 'final';
  on?: Record<string, XStateTransitionConfig | XStateTransitionConfig[]>;
  always?: XStateTransitionConfig | XStateTransitionConfig[];
  invoke?: {
    id: string;
    src: string;
    onDone?: XStateTransitionConfig | XStateTransitionConfig[];
  };
  onDone?: XStateTransitionConfig | XStateTransitionConfig[];
  meta?: {
    agent?: {
      type?: 'choice';
      invoke?: boolean;
    };
  };
}

export interface XStateTransitionConfig {
  target: string;
  guard?: {
    type: string;
  };
  actions?: string[];
  meta?: {
    agent?: {
      event?: string;
      updates?: {
        context?: boolean;
        input?: boolean;
        messages?: boolean;
      };
    };
  };
}

type InternalMachine = AgentMachine & {
  __config?: MachineConfig<any, any, any, any, any>;
};

/**
 * Convert an agent machine to a serializable XState-like machine config for
 * visualization. Guards, actions, and invokes are symbolic metadata, so this
 * object is not a runnable replacement for the agent machine.
 */
export function toXStateVisualization(machine: AgentMachine): XStateMachineConfig {
  const config = (machine as InternalMachine).__config;
  if (!config) {
    throw new Error('Machine config metadata is unavailable for XState export');
  }

  const graph = toGraph(machine);
  const states: Record<string, XStateStateConfig> = {};

  for (const [stateId, state] of Object.entries(config.states)) {
    const stateConfig = state as StateConfig;
    const xstateState: XStateStateConfig = {};

    if (stateConfig.type === 'final') {
      xstateState.type = 'final';
    }

    const meta: NonNullable<XStateStateConfig['meta']>['agent'] = {};
    if (stateConfig.invoke) {
      meta.invoke = true;
      xstateState.invoke = {
        id: `invoke.${stateId}`,
        src: `invoke.${stateId}`,
      };
    }

    const regularEdges = graph.edges.filter((edge) =>
      edge.sourceId === stateId
      && edge.data.source !== 'invoke.done'
      && edge.data.source !== 'always'
    );

    for (const [event, edges] of groupEdgesByEvent(regularEdges)) {
      const formatted = formatTransitions(edges);
      if (!formatted) {
        continue;
      }

      xstateState.on ??= {};
      xstateState.on[event] = formatted;
    }

    if (stateConfig.always) {
      const alwaysEdges = graph.edges.filter((edge) =>
        edge.sourceId === stateId
        && edge.data.source === 'always'
      );

      const formattedAlways = formatTransitions(alwaysEdges);
      if (formattedAlways) {
        xstateState.always = formattedAlways;
      }
    }

    if (stateConfig.onDone) {
      const doneEdges = graph.edges.filter((edge) =>
        edge.sourceId === stateId
        && edge.data.source === 'invoke.done'
      );

      const formattedDone = formatTransitions(doneEdges);
      if (formattedDone) {
        if (xstateState.invoke) {
          xstateState.invoke.onDone = formattedDone;
        } else {
          xstateState.onDone = formattedDone;
        }
      }
    }

    if (Object.keys(meta).length > 0) {
      xstateState.meta = { agent: meta };
    }

    states[stateId] = xstateState;
  }

  return {
    id: machine.id,
    ...(typeof graph.initialNodeId === 'string'
      ? { initial: graph.initialNodeId }
      : {}),
    meta: {
      agent: {
        format: '@statelyai/agent/xstate-visualization',
        runnable: false,
        note: 'Generated for visualization. Runtime semantics remain in the agent machine.',
      },
    },
    states,
  };
}

/**
 * @deprecated Use `toXStateVisualization(...)` to make the visualization-only
 * contract explicit.
 */
export const toXStateMachine = toXStateVisualization;

function groupEdgesByEvent(
  edges: AgentGraph['edges']
): Map<string, AgentGraphEdge[]> {
  const grouped = new Map<string, AgentGraphEdge[]>();

  for (const edge of edges) {
    const event = edge.data.event;
    if (!event) {
      continue;
    }

    grouped.set(event, [...(grouped.get(event) ?? []), edge]);
  }

  return grouped;
}

function formatTransitions(
  edges: AgentGraphEdge[]
): XStateTransitionConfig | XStateTransitionConfig[] | undefined {
  const transitions = edges.map(formatTransition);

  if (transitions.length === 0) {
    return undefined;
  }

  return transitions.length === 1 ? transitions[0]! : transitions;
}

function formatTransition(edge: AgentGraphEdge): XStateTransitionConfig {
  const actions = [
    ...(edge.data.actions?.context ? ['assignContext'] : []),
    ...(edge.data.actions?.input ? ['assignInput'] : []),
    ...(edge.data.actions?.messages ? ['assignMessages'] : []),
  ];

  return {
    target: edge.targetId,
    ...(edge.data.guard ? { guard: edge.data.guard } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    meta: {
      agent: {
        event: edge.data.event,
        ...(edge.data.actions
          ? {
              updates: {
                ...(edge.data.actions.context ? { context: true } : {}),
                ...(edge.data.actions.input ? { input: true } : {}),
                ...(edge.data.actions.messages ? { messages: true } : {}),
              },
            }
          : {}),
      },
    },
  };
}
