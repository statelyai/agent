import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv from "ajv";
import { describe, expect, test } from "vitest";
import {
  setupAgent,
  type AgentWorkflowConfig,
  type SchemaCompiler,
  type StandardSchemaV1,
} from "./index.js";
import { validateAgentConfig } from "./validate/index.js";

const workflowSchema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/agent-workflow.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

// The published schema is draft 2020-12, so it needs Ajv's 2020 build.
const ajv = new Ajv2020({ strict: false, allowUnionTypes: true });
const validateWorkflow = ajv.compile(workflowSchema);

/** Validates a config against schemas/agent-workflow.json, returning Ajv's error text. */
function schemaErrors(config: unknown): string[] {
  if (validateWorkflow(config)) {
    return [];
  }
  return (validateWorkflow.errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message}`,
  );
}

/** Same ~15-line Ajv-to-StandardSchema adapter used in setup-agent.test.ts. */
function ajvCompiler(): SchemaCompiler {
  const schemaAjv = new Ajv({ strict: false });

  return (jsonSchema, name): StandardSchemaV1 => {
    const validateFn = schemaAjv.compile(jsonSchema);

    return {
      "~standard": {
        version: 1,
        vendor: "ajv",
        validate(value: unknown) {
          if (validateFn(value)) {
            return { value };
          }
          return {
            issues: (validateFn.errors ?? []).map((error) => ({
              message: `${name}${error.instancePath} ${error.message}`,
            })),
          };
        },
        jsonSchema: { input: () => jsonSchema },
      },
    };
  };
}

const exampleWorkflow = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../examples/json-agent/workflow.json", import.meta.url)),
    "utf8",
  ),
) as AgentWorkflowConfig;

// Exercises every area the schema was corrected in: a bare named-guard string,
// root `actors`, request `reasoning`, and tool `inputSchema`/`outputSchema`.
const kitchenSinkWorkflow = {
  $schema: "https://stately.ai/schemas/agent-workflow.json",
  key: "kitchen-sink",
  id: "kitchen-sink",
  version: "1",
  schemas: {
    input: { type: "object", properties: {} },
    context: { type: "object", properties: { topic: { type: "string" } } },
    events: { GO: { type: "object", properties: {} } },
  },
  context: { topic: "{{ input.topic }}" },
  requests: {
    summarize: {
      model: "openai/gpt-5.4-mini",
      prompt: "Summarize {{ input.topic }}",
      reasoning: true,
      toolChoice: "auto",
      tools: {
        lookup: {
          description: "Look a term up.",
          inputSchema: { type: "object", properties: { term: { type: "string" } } },
          outputSchema: { type: "object", properties: { definition: { type: "string" } } },
        },
      },
      input: { type: "object", properties: { topic: { type: "string" } } },
      output: { type: "object", properties: { summary: { type: "string" } } },
    },
  },
  actors: {
    fetchDocs: {
      description: "Host-provided actor, wired via machine.provide({ actors }).",
      input: { type: "object", properties: { topic: { type: "string" } } },
      output: { type: "object", properties: { docs: { type: "string" } } },
    },
  },
  initial: "waiting",
  states: {
    waiting: {
      on: {
        // Bare string = named guard reference resolved against options.guards.
        GO: { target: "fetching", guard: "isReady" },
      },
    },
    fetching: {
      invoke: {
        src: "fetchDocs",
        input: { topic: "{{ context.topic }}" },
        onDone: { target: "done" },
      },
    },
    done: { type: "final" },
  },
} satisfies AgentWorkflowConfig;

describe("schemas/agent-workflow.json", () => {
  test("validates the JSON agent example workflow", () => {
    expect(schemaErrors(exampleWorkflow)).toEqual([]);
  });

  test("validates a config using bare-string guards, root actors, reasoning, and tool schemas", () => {
    expect(schemaErrors(kitchenSinkWorkflow)).toEqual([]);
  });

  test("validates a whole-string {{ }} expression guard", () => {
    expect(
      schemaErrors({
        initial: "a",
        states: {
          a: { on: { GO: { target: "b", guard: "{{ context.ready }}" } } },
          b: { type: "final" },
        },
      }),
    ).toEqual([]);
  });

  test("rejects an unknown top-level key", () => {
    expect(schemaErrors({ initial: "a", states: { a: {} }, guards: {} })).toContainEqual(
      expect.stringContaining("additional properties"),
    );
  });

  test("rejects an object guard, which the lowering throws on", () => {
    expect(
      schemaErrors({
        initial: "a",
        states: {
          a: { on: { GO: { target: "b", guard: { type: "isReady", params: {} } } } },
          b: { type: "final" },
        },
      }),
    ).not.toEqual([]);
  });

  test("rejects a {{ }} expression toolChoice, which is never evaluated", () => {
    expect(
      schemaErrors({
        initial: "a",
        states: { a: { type: "final" } },
        requests: {
          ask: {
            model: "openai/gpt-5.4-mini",
            toolChoice: "{{ context.toolChoice }}",
            input: { type: "object" },
            output: { type: "object" },
          },
        },
      }),
    ).not.toEqual([]);
  });

  test("rejects a request missing its required input/output schemas", () => {
    expect(
      schemaErrors({
        initial: "a",
        states: { a: { type: "final" } },
        requests: { ask: { model: "openai/gpt-5.4-mini" } },
      }),
    ).not.toEqual([]);
  });

  test("rejects a state key containing a '.', the reserved path separator", () => {
    expect(() =>
      setupAgent.fromConfig(
        {
          initial: "a.b",
          states: { "a.b": { type: "final" } },
        } as unknown as AgentWorkflowConfig,
        { compileSchema: ajvCompiler() },
      ),
    ).toThrow(/state key 'a\.b' contains a '\.'/);
  });

  test("schema-valid configs are accepted by setupAgent.fromConfig", () => {
    expect(() =>
      setupAgent.fromConfig(exampleWorkflow, { compileSchema: ajvCompiler() }),
    ).not.toThrow();
    expect(() =>
      setupAgent.fromConfig(kitchenSinkWorkflow, {
        compileSchema: ajvCompiler(),
        guards: { isReady: () => true },
      }),
    ).not.toThrow();
  });
});

describe("validateAgentConfig", () => {
  test("accepts configs the shipped schema allows", () => {
    expect(validateAgentConfig(exampleWorkflow)).toEqual({ valid: true, errors: [] });
    expect(validateAgentConfig(kitchenSinkWorkflow)).toEqual({ valid: true, errors: [] });
  });

  test("reports diagnostics with a JSON Pointer path for an invalid config", () => {
    const result = validateAgentConfig({
      key: "broken",
      // `initial` and `states` are missing; `requests` has the wrong type.
      requests: "nope",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    for (const error of result.errors) {
      expect(error.severity).toBe("error");
      expect(error.path.startsWith("/")).toBe(true);
      expect(typeof error.message).toBe("string");
      expect(typeof error.keyword).toBe("string");
    }
    expect(result.errors.some((error) => error.path === "/requests")).toBe(true);
  });

  test("agrees with a directly-compiled Ajv validator", () => {
    const config = { key: "x" };
    expect(validateAgentConfig(config).valid).toBe(schemaErrors(config).length === 0);
  });
});
