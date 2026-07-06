import type { AnyStateMachine, AsyncActorLogic, MetaObject } from "xstate";
import type { AgentMessage, AgentToolChoice, AgentTools, StandardSchemaV1 } from "./types.js";
import { validateSchemaSync } from "./utils.js";
import { DECIDE_ACTOR, type AgentRequestMode } from "./text-logic.js";
import { sendDecision } from "./decision.js";
import { missingActor } from "./internal/registry.js";
import {
  createAgentSchemas,
  createRequestActors,
  setupAgent,
  type AgentRequestInput,
  type AgentSchemaPack,
} from "./setup-agent.js";

// Minimal JSON Schema shape recognized by `minimalSchemaCompiler`; other compilers may accept the full spec.
type JsonSchemaObject = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  items?: JsonSchemaObject;
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: unknown;
  [key: string]: unknown;
};

/**
 * Compiles a JSON Schema object (from an `AgentWorkflowConfig`) into a
 * runtime `StandardSchemaV1` validator. `setupAgent.fromConfig(...)` calls
 * this once per schema in the config (context/events/input/output/meta,
 * request input/output) — bring your own engine (Ajv, @cfworker/json-schema,
 * a compiled-Zod-from-JSON-Schema pipeline, ...) or pass the exported
 * `minimalSchemaCompiler` to explicitly opt into the built-in subset
 * validator.
 */
export type SchemaCompiler = (
  jsonSchema: Record<string, unknown>,
  name: string,
) => StandardSchemaV1;

/**
 * Built-in, zero-dependency `SchemaCompiler`. Honors ONLY this JSON Schema
 * keyword subset:
 *
 *   - `type` (single string; if an array, only the first entry is checked)
 *   - `properties` / `required` (for `type: 'object'`)
 *   - `items` (for `type: 'array'`)
 *   - `enum`
 *   - `const`
 *
 * Everything else — `anyOf`/`oneOf`/`allOf`/`not`, `pattern`, `format`,
 * `minLength`/`maxLength`, `minimum`/`maximum`, `multipleOf`,
 * `additionalProperties`, `$ref`, and every other JSON Schema keyword — is
 * IGNORED. A value can silently pass validation despite violating a keyword
 * outside this subset. This exists for zero-dependency, low-stakes config
 * boundaries; pass a real JSON Schema engine (e.g. Ajv) as `compileSchema`
 * for anything that needs full JSON Schema semantics.
 */
export const minimalSchemaCompiler: SchemaCompiler = function minimalSchemaCompiler(
  schema: Record<string, unknown> | undefined,
  name = "schema",
): StandardSchemaV1 {
  const resolvedSchema = (schema ?? {}) as JsonSchemaObject;

  return {
    "~standard": {
      version: 1,
      vendor: "statelyai-agent-json-schema",
      validate(value: unknown) {
        const issues: { message: string }[] = [];
        validateJsonSchemaValue(resolvedSchema, value, name, issues);
        return issues.length > 0 ? { issues } : { value };
      },
      jsonSchema: {
        input: () => resolvedSchema,
      },
    },
  };
};

// Backs `minimalSchemaCompiler`, the built-in opt-in `SchemaCompiler`. JS
// callers should pass a real Standard Schema validator such as Zod to
// setupAgent(...); this intentionally covers only the small JSON Schema
// subset documented on `minimalSchemaCompiler`.
function validateJsonSchemaValue(
  schema: JsonSchemaObject,
  value: unknown,
  path: string,
  issues: { message: string }[],
) {
  if (schema.const !== undefined && value !== schema.const) {
    issues.push({ message: `${path} must equal ${JSON.stringify(schema.const)}` });
    return;
  }

  if (schema.enum && !schema.enum.some((item) => item === value)) {
    issues.push({ message: `${path} must be one of ${schema.enum.join(", ")}` });
    return;
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (!type) {
    return;
  }

  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push({ message: `${path} must be an object` });
      return;
    }

    const objectValue = value as Record<string, unknown>;
    for (const requiredKey of schema.required ?? []) {
      if (!(requiredKey in objectValue)) {
        issues.push({ message: `${path}.${requiredKey} is required` });
      }
    }

    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in objectValue) {
        validateJsonSchemaValue(propertySchema, objectValue[key], `${path}.${key}`, issues);
      }
    }
    return;
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      issues.push({ message: `${path} must be an array` });
      return;
    }

    if (schema.items) {
      value.forEach((item, index) =>
        validateJsonSchemaValue(schema.items!, item, `${path}[${index}]`, issues),
      );
    }
    return;
  }

  const ok =
    (type === "string" && typeof value === "string") ||
    (type === "number" && typeof value === "number") ||
    (type === "integer" && Number.isInteger(value)) ||
    (type === "boolean" && typeof value === "boolean") ||
    (type === "null" && value === null);

  if (!ok) {
    issues.push({ message: `${path} must be ${type}` });
  }
}

const workflowConfigWholeExpressionPattern = /^\{\{\s*([\s\S]*?)\s*\}\}$/;
const workflowConfigTemplateExpressionPattern = /\{\{\s*([\s\S]*?)\s*\}\}/g;

type ExpressionScope = {
  context?: unknown;
  event?: unknown;
  input?: unknown;
  output?: unknown;
};

// Static workflow configs cannot carry functions, so this tiny expression
// layer lowers JSON/YAML values into normal JS values before machine creation.
// Resolves a dotted path (e.g. "context.foo.bar") against the scope object.
function evaluateWorkflowConfigPath(expression: string, scope: ExpressionScope): unknown {
  const parts = expression.trim().split(".").filter(Boolean);
  let current: unknown = scope;

  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// Recursively lowers a config value: whole/partial `{{ expr }}` template strings, arrays, and objects are all resolved against `scope`.
function evaluateWorkflowConfigValue(value: unknown, scope: ExpressionScope): unknown {
  if (typeof value === "string") {
    const wholeMatch = value.match(workflowConfigWholeExpressionPattern);
    if (wholeMatch?.[1]) {
      return evaluateWorkflowConfigPath(wholeMatch[1], scope);
    }

    return value.replace(workflowConfigTemplateExpressionPattern, (_match, expression: string) => {
      const resolved = evaluateWorkflowConfigPath(expression, scope);
      return resolved === undefined || resolved === null ? "" : String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => evaluateWorkflowConfigValue(item, scope));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, evaluateWorkflowConfigValue(item, scope)]),
    );
  }

  return value;
}

// Type guard for a plain (non-array) JSON object.
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Serializable JSON/YAML machine definition — the config a database, visual
 * editor, or LLM could produce and hand to `setupAgent.fromConfig(config, {
 * compileSchema })` to get back the same kind of `AnyStateMachine`
 * TypeScript `setupAgent(...)` authoring would build. JS/TS authoring should
 * use `setupAgent(...)` directly instead of this JSON form. Any `unknown`-
 * typed field here (`model`, `guard`, action `params`, …) accepts either a
 * literal JSON value or a `"{{ path.to.value }}"` template-expression string
 * resolved against `{ context, event, input, output }` at machine-build/
 * transition time — see the sibling `evaluateWorkflowConfigValue` lowering.
 */
export interface AgentWorkflowConfig {
  key?: string;
  id?: string;
  version?: string;
  description?: string;
  schemas?: {
    input?: JsonSchemaObject;
    context?: JsonSchemaObject;
    events?: Record<string, JsonSchemaObject>;
    output?: JsonSchemaObject;
    meta?: JsonSchemaObject;
  };
  context?: Record<string, unknown>;
  requests?: Record<string, AgentWorkflowRequestConfig>;
  actors?: Record<string, AgentWorkflowActorConfig>;
  initial: string;
  states: Record<string, AgentWorkflowStateConfig>;
  meta?: Record<string, unknown>;
}

/** A `requests` entry in {@link AgentWorkflowConfig} — the JSON equivalent of a `setupAgent({ requests })` `TextLogicConfig`. Fields beyond `input`/`output`/`tools`/`mode`/`description` are `unknown` because they accept template-expression strings (see {@link AgentWorkflowConfig}). */
export interface AgentWorkflowRequestConfig {
  mode?: AgentRequestMode;
  description?: string;
  model: unknown;
  system?: unknown;
  prompt?: unknown;
  messages?: unknown;
  input: JsonSchemaObject;
  output: JsonSchemaObject;
  tools?: AgentTools;
  toolChoice?: AgentToolChoice | unknown;
  temperature?: unknown;
  maxTokens?: unknown;
  topP?: unknown;
  topK?: unknown;
  seed?: unknown;
  stopSequences?: unknown;
  metadata?: unknown;
}

/** An `actors` entry in {@link AgentWorkflowConfig} — declares a placeholder actor source (by key) with no host execution wired from JSON; provide it via `machine.provide({ actorSources })` after `setupAgent.fromConfig(...)`. */
export interface AgentWorkflowActorConfig {
  input?: JsonSchemaObject;
  output?: JsonSchemaObject;
  description?: string;
}

/** A `states` entry in {@link AgentWorkflowConfig} — the JSON equivalent of an XState state node config. */
export interface AgentWorkflowStateConfig {
  description?: string;
  type?: "parallel" | "history" | "final";
  initial?: string;
  states?: Record<string, AgentWorkflowStateConfig>;
  invoke?: AgentWorkflowInvokeConfig | AgentWorkflowInvokeConfig[];
  on?: Record<string, AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[]>;
  always?: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[];
  onDone?: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[];
  after?: Record<string, AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[]>;
  entry?: AgentWorkflowActionConfig | AgentWorkflowActionConfig[];
  exit?: AgentWorkflowActionConfig | AgentWorkflowActionConfig[];
  tags?: string[];
  output?: unknown;
  meta?: Record<string, unknown>;
}

/**
 * An `invoke` entry in {@link AgentWorkflowStateConfig}. For `src:
 * 'agent.decide'`, `onDone` must be omitted — decision delivery is automatic
 * (equivalent to `onDone: sendDecision()` in TS authoring), since a
 * decision's output *is* the chosen event and there is no function value to
 * express in JSON; only `onError` (retries exhausted) is configurable here.
 */
export interface AgentWorkflowInvokeConfig {
  id?: string;
  src: string;
  input?: unknown;
  onDone?: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[];
  onError?: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[];
  meta?: Record<string, unknown>;
}

/** A transition target in {@link AgentWorkflowConfig} (`on`/`always`/`onDone`/`after`/invoke `onDone`/`onError`) — the JSON equivalent of an XState transition config. `guard`, when a string, is a template expression evaluated as truthy/falsy. */
export interface AgentWorkflowTransitionConfig {
  target?: string | string[];
  guard?: unknown;
  assign?: Record<string, unknown>;
  actions?: AgentWorkflowActionConfig | AgentWorkflowActionConfig[];
  description?: string;
  reenter?: boolean;
  meta?: Record<string, unknown>;
}

/** An `entry`/`exit`/transition `actions` entry in {@link AgentWorkflowConfig} — either a named action `type` (with template-expression `params`) or a bare context `assign`. */
export interface AgentWorkflowActionConfig {
  type: string;
  params?: unknown;
  assign?: Record<string, unknown>;
  [key: string]: unknown;
}

// Compiles a config's JSON Schemas (context/events/input/output/meta) into an AgentSchemaPack via the caller's SchemaCompiler.
function createSchemasFromWorkflowConfig(
  config: AgentWorkflowConfig,
  compileSchema: SchemaCompiler,
): AgentSchemaPack<
  StandardSchemaV1<Record<string, unknown>>,
  Record<string, StandardSchemaV1>,
  StandardSchemaV1,
  StandardSchemaV1,
  StandardSchemaV1<MetaObject>
> {
  return createAgentSchemas({
    context: compileSchema(
      (config.schemas?.context ?? { type: "object" }) as Record<string, unknown>,
      "context",
    ) as StandardSchemaV1<Record<string, unknown>>,
    events: Object.fromEntries(
      Object.entries(config.schemas?.events ?? {}).map(([key, schema]) => [
        key,
        compileSchema(schema as Record<string, unknown>, `event.${key}`),
      ]),
    ),
    input: compileSchema((config.schemas?.input ?? {}) as Record<string, unknown>, "input"),
    output: compileSchema((config.schemas?.output ?? {}) as Record<string, unknown>, "output"),
    meta: compileSchema(
      (config.schemas?.meta ?? {}) as Record<string, unknown>,
      "meta",
    ) as StandardSchemaV1<MetaObject>,
  });
}

// Lowers a config's `requests` map into an AgentRequestInput, compiling schemas and turning each unknown-typed field into a template-expression resolver.
function createRequestsFromWorkflowConfig(
  config: AgentWorkflowConfig,
  compileSchema: SchemaCompiler,
): AgentRequestInput<Record<string, { input: StandardSchemaV1; output: StandardSchemaV1 }>> {
  return Object.fromEntries(
    Object.entries(config.requests ?? {}).map(([key, request]) => [
      key,
      {
        mode: request.mode,
        description: request.description,
        schemas: {
          input: compileSchema(request.input as Record<string, unknown>, `${key}.input`),
          output: compileSchema(request.output as Record<string, unknown>, `${key}.output`),
        },
        model: ({ input }) => String(evaluateWorkflowConfigValue(request.model, { input }) ?? ""),
        system:
          request.system === undefined
            ? undefined
            : ({ input }) =>
                evaluateWorkflowConfigValue(request.system, { input }) as string | undefined,
        prompt:
          request.prompt === undefined
            ? undefined
            : ({ input }) =>
                evaluateWorkflowConfigValue(request.prompt, { input }) as string | undefined,
        messages:
          request.messages === undefined
            ? undefined
            : ({ input }) =>
                evaluateWorkflowConfigValue(request.messages, { input }) as
                  | AgentMessage[]
                  | undefined,
        tools: request.tools,
        toolChoice: request.toolChoice as AgentToolChoice | undefined,
        temperature:
          request.temperature === undefined
            ? undefined
            : ({ input }) =>
                evaluateWorkflowConfigValue(request.temperature, { input }) as number | undefined,
        maxTokens:
          request.maxTokens === undefined
            ? undefined
            : ({ input }) =>
                evaluateWorkflowConfigValue(request.maxTokens, { input }) as number | undefined,
        topP:
          request.topP === undefined
            ? undefined
            : ({ input }) =>
                evaluateWorkflowConfigValue(request.topP, { input }) as number | undefined,
        topK:
          request.topK === undefined
            ? undefined
            : ({ input }) =>
                evaluateWorkflowConfigValue(request.topK, { input }) as number | undefined,
        seed:
          request.seed === undefined
            ? undefined
            : ({ input }) =>
                evaluateWorkflowConfigValue(request.seed, { input }) as number | undefined,
        stopSequences:
          request.stopSequences === undefined
            ? undefined
            : ({ input }) =>
                evaluateWorkflowConfigValue(request.stopSequences, { input }) as
                  | string[]
                  | undefined,
        metadata:
          request.metadata === undefined
            ? undefined
            : ({ input }) => evaluateWorkflowConfigValue(request.metadata, { input }),
      },
    ]),
  ) as AgentRequestInput<Record<string, { input: StandardSchemaV1; output: StandardSchemaV1 }>>;
}

// Builds one `missingActor(...)` placeholder per key in config.actors, to be replaced via machine.provide(...) by the caller.
function createActorPlaceholdersFromWorkflowConfig(config: AgentWorkflowConfig) {
  return Object.fromEntries(
    Object.keys(config.actors ?? {}).map((key) => [key, missingActor(key)]),
  ) as Record<string, AsyncActorLogic<unknown, unknown>>;
}

// Lowers an action config's `assign` map into an xstate assign-style transition function.
function createAssignAction(assignConfig: Record<string, unknown>) {
  return ({ context, event }: { context: Record<string, unknown>; event: unknown }) => ({
    context: Object.fromEntries(
      Object.entries(assignConfig).map(([key, value]) => [
        key,
        evaluateWorkflowConfigValue(value, { context, event }),
      ]),
    ),
  });
}

// Lowers an entry/exit `actions` config (single or array) into xstate action entries.
function lowerWorkflowActions(
  actionConfig: AgentWorkflowActionConfig | AgentWorkflowActionConfig[] | undefined,
) {
  if (!actionConfig) {
    return undefined;
  }

  const actions = Array.isArray(actionConfig) ? actionConfig : [actionConfig];
  return actions.map((action) =>
    action.assign
      ? createAssignAction(action.assign)
      : {
          type: action.type,
          params: ({ context, event }: { context: unknown; event: unknown }) =>
            evaluateWorkflowConfigValue(action.params, { context, event }),
        },
  );
}

// Evaluates a transition config's `guard` (string template expression, guard function, or omitted ⇒ always matches).
function workflowTransitionMatches(
  transitionConfig: AgentWorkflowTransitionConfig,
  scope: { context: unknown; event: unknown },
) {
  if (transitionConfig.guard === undefined) {
    return true;
  }

  if (typeof transitionConfig.guard === "string") {
    return Boolean(evaluateWorkflowConfigValue(transitionConfig.guard, scope));
  }

  return typeof transitionConfig.guard === "function"
    ? transitionConfig.guard(scope as never)
    : false;
}

// Lowers a matched transition config into an xstate transition result object (target/context/description/reenter/meta).
function lowerWorkflowTransitionResult(
  transitionConfig: AgentWorkflowTransitionConfig,
  scope: { context: unknown; event: unknown },
) {
  return {
    ...(transitionConfig.target !== undefined ? { target: transitionConfig.target } : {}),
    ...(transitionConfig.assign
      ? {
          context: Object.fromEntries(
            Object.entries(transitionConfig.assign).map(([key, value]) => [
              key,
              evaluateWorkflowConfigValue(value, scope),
            ]),
          ),
        }
      : {}),
    ...(transitionConfig.description !== undefined
      ? { description: transitionConfig.description }
      : {}),
    ...(transitionConfig.reenter !== undefined ? { reenter: transitionConfig.reenter } : {}),
    ...(transitionConfig.meta !== undefined ? { meta: transitionConfig.meta } : {}),
  };
}

// Lowers a single transition config into an xstate transition function.
function lowerWorkflowTransition(transitionConfig: AgentWorkflowTransitionConfig) {
  return ({ context, event }: { context: unknown; event: unknown }) => {
    const scope = { context, event };
    return workflowTransitionMatches(transitionConfig, scope)
      ? lowerWorkflowTransitionResult(transitionConfig, scope)
      : undefined;
  };
}

// Lowers a single transition config or a first-match array of them into one xstate transition function.
function lowerWorkflowTransitionOrArray(
  transitionConfig: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[] | undefined,
) {
  if (!transitionConfig) {
    return undefined;
  }

  return Array.isArray(transitionConfig)
    ? ({ context, event }: { context: unknown; event: unknown }) => {
        const scope = { context, event };
        const transition = transitionConfig.find((candidate) =>
          workflowTransitionMatches(candidate, scope),
        );
        return transition ? lowerWorkflowTransitionResult(transition, scope) : undefined;
      }
    : lowerWorkflowTransition(transitionConfig);
}

// Lowers an invoke config into an xstate invoke config; special-cases `agent.decide` to auto-wire `sendDecision()` as onDone.
function lowerWorkflowInvoke(invokeConfig: AgentWorkflowInvokeConfig) {
  const isDecideInvoke = invokeConfig.src === DECIDE_ACTOR;

  if (isDecideInvoke && invokeConfig.onDone !== undefined) {
    throw new Error(
      `setupAgent.fromConfig: invoke '${invokeConfig.id ?? invokeConfig.src}' targets ` +
        `'${DECIDE_ACTOR}' and declares an 'onDone'. Decision delivery is automatic — a ` +
        `decision has no output value of its own, its output IS the chosen event, which ` +
        `is delivered via 'sendDecision()' — so 'onDone' cannot be configured from JSON. ` +
        `Only 'onError' (retries-exhausted) is configurable here.`,
    );
  }

  return {
    ...(invokeConfig.id !== undefined ? { id: invokeConfig.id } : {}),
    src: invokeConfig.src,
    ...(invokeConfig.input !== undefined
      ? {
          input: ({ context, event }: { context: unknown; event: unknown }) =>
            evaluateWorkflowConfigValue(invokeConfig.input, { context, event }),
        }
      : {}),
    ...(isDecideInvoke
      ? { onDone: sendDecision() }
      : invokeConfig.onDone !== undefined
        ? { onDone: lowerWorkflowTransitionOrArray(invokeConfig.onDone) }
        : {}),
    ...(invokeConfig.onError !== undefined
      ? { onError: lowerWorkflowTransitionOrArray(invokeConfig.onError) }
      : {}),
    ...(invokeConfig.meta !== undefined ? { meta: invokeConfig.meta } : {}),
  };
}

// Recursively lowers one AgentWorkflowStateConfig into an xstate state node config.
function lowerWorkflowState(stateConfig: AgentWorkflowStateConfig): Record<string, unknown> {
  return {
    ...(stateConfig.description !== undefined ? { description: stateConfig.description } : {}),
    ...(stateConfig.type !== undefined ? { type: stateConfig.type } : {}),
    ...(stateConfig.initial !== undefined ? { initial: stateConfig.initial } : {}),
    ...(stateConfig.states !== undefined
      ? {
          states: Object.fromEntries(
            Object.entries(stateConfig.states).map(([key, child]) => [
              key,
              lowerWorkflowState(child),
            ]),
          ),
        }
      : {}),
    ...(stateConfig.invoke !== undefined
      ? {
          invoke: Array.isArray(stateConfig.invoke)
            ? stateConfig.invoke.map(lowerWorkflowInvoke)
            : lowerWorkflowInvoke(stateConfig.invoke),
        }
      : {}),
    ...(stateConfig.on !== undefined
      ? {
          on: Object.fromEntries(
            Object.entries(stateConfig.on).map(([eventType, transitionConfig]) => [
              eventType,
              lowerWorkflowTransitionOrArray(transitionConfig),
            ]),
          ),
        }
      : {}),
    ...(stateConfig.always !== undefined
      ? { always: lowerWorkflowTransitionOrArray(stateConfig.always) }
      : {}),
    ...(stateConfig.onDone !== undefined
      ? { onDone: lowerWorkflowTransitionOrArray(stateConfig.onDone) }
      : {}),
    ...(stateConfig.after !== undefined
      ? {
          after: Object.fromEntries(
            Object.entries(stateConfig.after).map(([delay, transitionConfig]) => [
              delay,
              lowerWorkflowTransitionOrArray(transitionConfig),
            ]),
          ),
        }
      : {}),
    ...(stateConfig.entry !== undefined ? { entry: lowerWorkflowActions(stateConfig.entry) } : {}),
    ...(stateConfig.exit !== undefined ? { exit: lowerWorkflowActions(stateConfig.exit) } : {}),
    ...(stateConfig.tags !== undefined ? { tags: stateConfig.tags } : {}),
    ...(stateConfig.output !== undefined
      ? {
          output: ({ context, event }: { context: unknown; event: unknown }) =>
            evaluateWorkflowConfigValue(stateConfig.output, { context, event }),
        }
      : {}),
    ...(stateConfig.meta !== undefined ? { meta: stateConfig.meta } : {}),
  };
}

// Implementation backing the public `setupAgent.fromConfig(...)` namespace member (see setup-agent.ts) — lowers an AgentWorkflowConfig into a real state machine.
export function setupAgentFromConfig(
  config: AgentWorkflowConfig,
  options: FromConfigOptions,
): AnyStateMachine {
  if (!options || typeof options.compileSchema !== "function") {
    throw new Error(
      "setupAgent.fromConfig(...) requires a 'compileSchema' option: " +
        "{ compileSchema: (jsonSchema, name) => StandardSchemaV1 }. Bring your own JSON " +
        "Schema engine (Ajv, @cfworker/json-schema, ...), or pass the exported " +
        "`minimalSchemaCompiler` to explicitly opt into the built-in subset validator " +
        "(type/properties/required/items/enum/const only — everything else is ignored).",
    );
  }

  const { compileSchema } = options;
  const schemas = createSchemasFromWorkflowConfig(config, compileSchema);
  const requests = createRequestsFromWorkflowConfig(config, compileSchema);
  const requestActors = createRequestActors(requests);
  const actors = createActorPlaceholdersFromWorkflowConfig(config);
  const agent = setupAgent({
    schemas,
    actorSources: {
      ...actors,
      ...requestActors,
    },
  });

  return agent.createMachine({
    ...(config.id !== undefined ? { id: config.id } : {}),
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.context !== undefined
      ? {
          context: ({ input }: { input: unknown }) =>
            validateSchemaSync(
              schemas.context,
              evaluateWorkflowConfigValue(config.context, { input }),
            ),
        }
      : {}),
    initial: config.initial,
    states: Object.fromEntries(
      Object.entries(config.states).map(([key, state]) => [key, lowerWorkflowState(state)]),
    ),
    ...(config.meta !== undefined ? { meta: config.meta } : {}),
  } as never);
}

/** Options for `setupAgent.fromConfig(...)`. */
export interface FromConfigOptions {
  /**
   * Compile a JSON Schema from the config into a runtime validator. Bring
   * your own engine (Ajv, @cfworker/json-schema, ...) or pass the exported
   * `minimalSchemaCompiler` to explicitly opt into the built-in subset
   * validator (type/properties/required/items/enum/const only).
   */
  compileSchema: SchemaCompiler;
}
