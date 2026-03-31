import type { AgentAdapter } from './types.js';

/**
 * Create a custom adapter for AI primitives (classify/decide).
 */
export function createAdapter(impl: AgentAdapter): AgentAdapter {
  return impl;
}
