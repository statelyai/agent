import type { AgentAdapter } from './types.js';

/**
 * Create a custom adapter for model execution.
 */
export function createAdapter(impl: AgentAdapter): AgentAdapter {
  return impl;
}
