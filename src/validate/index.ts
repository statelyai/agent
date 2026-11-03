/**
 * Schema validation and pre-run gates for agent workflow configs.
 *
 * Lives behind the `@statelyai/agent/validate` subpath so the core package
 * stays dependency-free. This module imports `ajv`, which is declared as an
 * optional peer dependency.
 */
export { validateAgentConfig } from "./validate-config.js";
export type { AgentConfigDiagnostic, AgentConfigValidationResult } from "./validate-config.js";
export { verifyAgentConfig } from "./verify-config.js";
export type {
  AgentConfigGate,
  AgentConfigGateName,
  AgentConfigVocabulary,
  VerifyAgentConfigExploreOptions,
  VerifyAgentConfigOptions,
  VerifyAgentConfigResult,
} from "./verify-config.js";
