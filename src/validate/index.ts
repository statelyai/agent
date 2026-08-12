/**
 * Schema validation for agent workflow configs.
 *
 * Lives behind the `@statelyai/agent/validate` subpath so the core package
 * stays dependency-free. This module imports `ajv`, which is declared as an
 * optional peer dependency.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

/**
 * One schema-validation finding from {@link validateAgentConfig}. `path` is a
 * JSON Pointer into the config (`/states/idle/invoke`, `/` for the root) and
 * `message` explains what the schema rejected. Mirrors the shape of
 * `AgentLintDiagnostic` so config validation and machine linting report the
 * same way.
 */
export interface AgentConfigDiagnostic {
  severity: "error";
  /** JSON Pointer into the config (`/` for the root). */
  path: string;
  message: string;
  /** The schema keyword that failed (`required`, `type`, `enum`, ...). */
  keyword: string;
}

/** Result of {@link validateAgentConfig}. */
export interface AgentConfigValidationResult {
  valid: boolean;
  errors: AgentConfigDiagnostic[];
}

let compiledWorkflowValidator: ValidateFunction | undefined;

/**
 * Resolves `schemas/agent-workflow.json` relative to this module. The built
 * output is flat (`dist/validate.mjs`), while the source lives one level
 * deeper (`src/validate/index.ts`), so both candidates are checked.
 */
function resolveSchemaPath(): string {
  const candidates = ["../schemas/agent-workflow.json", "../../schemas/agent-workflow.json"];
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) {
      return path;
    }
  }
  throw new Error("Could not locate schemas/agent-workflow.json");
}

function getWorkflowValidator(): ValidateFunction {
  if (!compiledWorkflowValidator) {
    const schema = JSON.parse(readFileSync(resolveSchemaPath(), "utf8")) as Record<string, unknown>;
    // The published schema is draft 2020-12, so it needs Ajv's 2020 build.
    const ajv = new Ajv2020({ strict: false, allowUnionTypes: true, allErrors: true });
    compiledWorkflowValidator = ajv.compile(schema);
  }
  return compiledWorkflowValidator;
}

/**
 * Validates a value against the shipped `schemas/agent-workflow.json` before
 * you hand it to `setupAgent(...).fromConfig(...)`. Returns diagnostics rather
 * than throwing; `valid: true` means the config is structurally sound (it does
 * not check that named guards/actions/actors are implemented, which
 * `fromConfig` does). The compiled validator is cached across calls.
 */
export function validateAgentConfig(config: unknown): AgentConfigValidationResult {
  const validate = getWorkflowValidator();
  if (validate(config)) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: (validate.errors ?? []).map((error) => ({
      severity: "error" as const,
      path: error.instancePath || "/",
      message: error.message ?? "is invalid",
      keyword: error.keyword,
    })),
  };
}
