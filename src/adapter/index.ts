/**
 * `@statelyai/agent/adapter` — the adapter-author seam: the primitives for
 * building a custom `{ generateText, streamText, decide }` executor set or a
 * hand-rolled host loop. Envelope plumbing, model-ref parsing, Standard-Schema
 * / JSON-Schema utilities, structural hashing, and event-pattern matching.
 * @module
 */
export {
  bindRequestExecutor,
  buildEnvelopeSchema,
  getAgentOutputMode,
  isStructuredOutputSchema,
  parseModelRef,
  parseOutput,
  parseStructuredEnvelope,
} from "../text-logic.js";
export type {
  AgentOutputMode,
  AgentRequestExecutor,
  AgentRequestExecutorInfo,
  AgentRequestExecutorResult,
  AgentTextRequest,
  StructuredOutputEnvelope,
  TextLogic,
} from "../text-logic.js";

export {
  getJsonSchema,
  getJsonSchemaSync,
  getMachineStructuralHash,
  isStandardSchema,
  validateSchemaSync,
} from "../utils.js";

export { matchesEventPattern } from "../events.js";

export type { StandardSchemaV1 } from "../types.js";
