/**
 * `@statelyai/agent/policy` — deciders that live outside a machine:
 * `decideNext` asks a model for the next event of any XState snapshot, and
 * `createPolicyDecider` runs a policy machine as a decide executor.
 *
 * Machines that decide with `agent.decide` do not need this module.
 * @module
 */
export { decideNext } from "../decide-next.js";
export type { DecideNextOptions, DecideNextResult } from "../decide-next.js";
export { createPolicyDecider } from "../policy-decider.js";
export type { PolicyDeciderOptions } from "../policy-decider.js";
