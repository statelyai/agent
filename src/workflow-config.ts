/**
 * The machines-as-data lowering: `setupAgent(...).fromConfig(config, options)`.
 *
 * Takes a serializable `AgentWorkflowConfig` (the JSON form of an agent
 * machine — published schema at `schemas/agent-workflow.json`, docs at
 * docs/machines-as-data.md), compiles its embedded JSON Schemas with the
 * host-provided `compileSchema`, resolves named guards/actions/actors from
 * `options`, and lowers the whole thing to an ordinary XState machine plus its
 * schema pack. This is what makes LLM-generated and stored-as-JSON machines
 * first-class: the config validates against the shipped schema before any
 * model call, and the resulting machine lints, simulates, and runs like a
 * hand-authored one.
 */
import {
  createMachineFromConfig,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type AsyncActorLogic,
  type MachineJSON,
  type MetaObject,
} from "xstate";
import type { AgentMessage, AgentToolChoice, AgentTools, StandardSchemaV1 } from "./types.js";
import { validateSchemaSync } from "./utils.js";
import { type AgentRequestMode } from "./text-logic.js";
import {
  agentExecutionOptions,
  machineStaticTransitionTargets,
  machineSuspensionPredicates,
  missingActor,
} from "./internal/registry.js";
import {
  createAgentActors,
  createAgentSchemas,
  createRequestActors,
  type AgentRequestInput,
  type AgentSchemaPack,
} from "./setup-agent.js";

// JSON Schema shape accepted from serializable workflow configs.
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
 * a compiled-Zod-from-JSON-Schema pipeline, ...). Core intentionally ships no
 * JSON Schema engine.
 */
export type SchemaCompiler = (
  jsonSchema: Record<string, unknown>,
  name: string,
) => StandardSchemaV1;

// Builtin decision actor src — an `onDone` on one of these is always a config
// error (a decision's output IS its chosen event, delivered via `on`).
const DECIDE_SRC = "agent.decide";

const workflowConfigWholeExpressionPattern = /^\{\{\s*([\s\S]*?)\s*\}\}$/;
const workflowConfigTemplateExpressionPattern = /\{\{\s*([\s\S]*?)\s*\}\}/g;
// Stateless variant for boolean tests (the /g pattern carries lastIndex state).
const workflowConfigHasTemplatePattern = /\{\{[\s\S]*?\}\}/;

type ExpressionScope = {
  context?: unknown;
  event?: unknown;
  input?: unknown;
};

// Normalizes the config's `T | T[]` shorthand fields into an array.
function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

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
  /** JSON Schema reference (`"$schema"`) editors attach to a config file. Ignored by the lowering. */
  $schema?: string;
  key?: string;
  id?: string;
  version?: string;
  description?: string;
  schemas?: {
    input?: JsonSchemaObject;
    context?: JsonSchemaObject;
    events?: Record<string, JsonSchemaObject>;
    emitted?: Record<string, JsonSchemaObject>;
    output?: JsonSchemaObject;
    meta?: JsonSchemaObject;
  };
  context?: Record<string, unknown>;
  requests?: Record<string, AgentWorkflowRequestConfig>;
  actors?: Record<string, AgentWorkflowActorConfig>;
  initial: string;
  states: Record<string, AgentWorkflowStateConfig>;
  /**
   * State tags that mark an INTENTIONAL wait for an external event (a human
   * approval, an inbound webhook, …) — the declarative form of `setupAgent({
   * isSuspended })`, since a config cannot carry a function. Lowered to a
   * `snapshot.hasTag(...)`-any-of predicate so `runAgent` settles those
   * snapshots idle deterministically instead of using its timing heuristic.
   * Every listed tag must appear in some state's `tags` — an unused tag is a
   * build-time error. A `fromConfig(config, { isSuspended })` option takes
   * precedence; a `runAgent({ isSuspended })` host override beats both.
   */
  suspendedTags?: string[];
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
  /** Opt into the structured-output envelope's `reasoning` field (see `AgentTextRequest.reasoning`). */
  reasoning?: boolean;
  temperature?: unknown;
  maxOutputTokens?: unknown;
  topP?: unknown;
  topK?: unknown;
  seed?: unknown;
  stopSequences?: unknown;
  metadata?: unknown;
}

/** An `actors` entry in {@link AgentWorkflowConfig} — declares a placeholder actor source (by key) with no host execution wired from JSON; provide it via `machine.provide({ actors })` after `setupAgent.fromConfig(...)`. */
export interface AgentWorkflowActorConfig {
  input?: JsonSchemaObject;
  output?: JsonSchemaObject;
  description?: string;
}

/** A `states` entry in {@link AgentWorkflowConfig} — the JSON equivalent of an XState state node config. */
export interface AgentWorkflowStateConfig {
  description?: string;
  type?: "parallel" | "history" | "final" | "choice";
  initial?: string;
  states?: Record<string, AgentWorkflowStateConfig>;
  choice?: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[];
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
 * 'agent.decide'`, the chosen event is delivered automatically and handled by
 * the state's `on` transitions — a decision has no output of its own, so an
 * `onDone` there is always a config error and is rejected at
 * `setupAgent.fromConfig(...)` time. `onError` handles retries-exhausted.
 */
export interface AgentWorkflowInvokeConfig {
  id?: string;
  src: string;
  input?: unknown;
  onDone?: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[];
  onError?: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[];
  meta?: Record<string, unknown>;
}

/**
 * A transition target in {@link AgentWorkflowConfig}
 * (`on`/`always`/`onDone`/`after`/invoke `onDone`/`onError`) — the JSON
 * equivalent of an XState transition config. A string `guard` containing
 * `{{ ... }}` is a template expression evaluated as truthy/falsy; any other
 * string is a named guard reference resolved against the `guards` passed to
 * `setupAgent.fromConfig(config, { guards })` (unresolvable references throw
 * at build time).
 */
export interface AgentWorkflowTransitionConfig {
  target?: string | string[];
  guard?: unknown;
  assign?: Record<string, unknown>;
  actions?: AgentWorkflowActionConfig | AgentWorkflowActionConfig[];
  description?: string;
  reenter?: boolean;
  meta?: Record<string, unknown>;
}

/** An `entry`/`exit`/transition `actions` entry in {@link AgentWorkflowConfig} — a bare context `assign`, an `emit`, or a named action `type` (with template-expression `params`) resolved against the `actions` passed to `setupAgent.fromConfig(config, { actions })`. */
export interface AgentWorkflowActionConfig {
  type?: string;
  params?: unknown;
  assign?: Record<string, unknown>;
  emit?: unknown;
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
    emitted: Object.fromEntries(
      Object.entries(config.schemas?.emitted ?? {}).map(([key, schema]) => [
        key,
        compileSchema(schema as Record<string, unknown>, `emitted.${key}`),
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
  // An optional config field becomes an input-scoped template resolver; an
  // absent one stays absent (so request defaults still apply).
  const resolver = <T>(value: unknown) =>
    value === undefined
      ? undefined
      : ({ input }: { input: unknown }) => evaluateWorkflowConfigValue(value, { input }) as T;

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
        model: ({ input }: { input: unknown }) =>
          String(evaluateWorkflowConfigValue(request.model, { input }) ?? ""),
        system: resolver<string | undefined>(request.system),
        prompt: resolver<string | undefined>(request.prompt),
        messages: resolver<AgentMessage[] | undefined>(request.messages),
        tools: request.tools,
        toolChoice: request.toolChoice as AgentToolChoice | undefined,
        reasoning: request.reasoning,
        temperature: resolver<number | undefined>(request.temperature),
        maxOutputTokens: resolver<number | undefined>(request.maxOutputTokens),
        topP: resolver<number | undefined>(request.topP),
        topK: resolver<number | undefined>(request.topK),
        seed: resolver<number | undefined>(request.seed),
        stopSequences: resolver<string[] | undefined>(request.stopSequences),
        metadata: resolver<unknown>(request.metadata),
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

// ---------------------------------------------------------------------------
// AgentWorkflowConfig → MachineJSON translation.
//
// The config is lowered onto xstate's own JSON layer (`createMachineFromConfig`)
// rather than a hand-rolled interpreter: named guards/actions resolve through
// `sources` (missing refs throw at build time), and every
// template-bearing value becomes one `@expr` slot resolved by the evaluator
// below — which reproduces the documented `{{ dotted.path }}` semantics
// exactly.
// ---------------------------------------------------------------------------

// Language tag for translated `@expr` slots. fromConfig registers the matching
// evaluator itself; host configs never see or set this.
const AGENT_EXPRESSION_LANG = "agent-template";

// True when a config value contains a `{{ ... }}` template anywhere in it.
function containsTemplateExpression(value: unknown): boolean {
  if (typeof value === "string") {
    return workflowConfigHasTemplatePattern.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsTemplateExpression);
  }
  if (value && typeof value === "object") {
    return Object.values(value).some(containsTemplateExpression);
  }
  return false;
}

// Template-bearing values become one JSON-encoded `@expr` slot (whole-value, so
// the evaluator applies today's template semantics verbatim — xstate's
// per-slot recursion is never relied on); template-free values stay literal.
function toWorkflowExpression(value: unknown): unknown {
  if (!containsTemplateExpression(value)) {
    return value;
  }
  return { "@expr": JSON.stringify(value) };
}

// The `evaluators` implementation backing every translated `@expr` slot:
// decodes the JSON-encoded config value and resolves its templates against
// { context, event, input }. The `context` slot additionally validates the
// built context against the config's context schema — this is where a bad
// initial context throws.
function createWorkflowConfigEvaluator(contextSchema: StandardSchemaV1<Record<string, unknown>>) {
  const decoded = new Map<string, unknown>();
  const decode = (source: string): unknown => {
    if (!decoded.has(source)) {
      decoded.set(source, JSON.parse(source));
    }
    return decoded.get(source);
  };

  return ({
    source,
    slot,
    scope,
  }: {
    source: string;
    slot: string;
    scope: Record<string, unknown>;
  }): unknown => {
    const value = decode(source);
    if (slot === "context") {
      return validateSchemaSync(
        contextSchema,
        evaluateWorkflowConfigValue(value, { input: scope.input }),
      );
    }
    return evaluateWorkflowConfigValue(value, {
      context: scope.context,
      event: scope.event,
      input: scope.input,
    });
  };
}

// Host sources + synthetic registrations threaded through translation.
type WorkflowTranslation = {
  guards: Record<string, (args: { context: any; event: any }) => boolean>;
  actions: Record<string, (params: any) => unknown>;
  // Function-valued config guards (JS-built configs), registered under
  // generated names so they survive the JSON layer.
  syntheticGuards: Record<string, (args: { context: any; event: any }) => boolean>;
  // Every transition target the config declares, by dotted state path. The JSON
  // layer erases targets from transitions that carry a context patch (they
  // become opaque resolver functions), so lint reads reachability from here.
  transitionTargets: Record<string, string[]>;
};

// Translates a transition's `guard` into a ConditionJSON: `{{ }}` template →
// `@expr` slot; other string → named guard reference (must be implemented);
// function → synthetic named guard. Anything else is a build error — a guard
// that cannot be resolved must never become an unconditional transition.
function translateWorkflowGuard(
  guard: unknown,
  translation: WorkflowTranslation,
  location: string,
): Record<string, unknown> | undefined {
  if (guard === undefined) {
    return undefined;
  }
  if (typeof guard === "string") {
    if (workflowConfigHasTemplatePattern.test(guard)) {
      return { "@expr": JSON.stringify(guard) };
    }
    if (!(guard in translation.guards)) {
      throw new Error(
        `setupAgent.fromConfig: ${location} references guard '${guard}', which has no ` +
          `implementation. Provide one via fromConfig options: setupAgent.fromConfig(config, ` +
          `{ guards: { '${guard}': ({ context, event }) => ... } }).`,
      );
    }
    return { type: guard };
  }
  if (typeof guard === "function") {
    const name = `__fromConfigGuard${Object.keys(translation.syntheticGuards).length}`;
    translation.syntheticGuards[name] = guard as (args: {
      context: unknown;
      event: unknown;
    }) => boolean;
    return { type: name };
  }
  throw new Error(
    `setupAgent.fromConfig: ${location} has an unsupported guard value. Use a '{{ ... }}' ` +
      `template string, a named guard reference (string), or a function.`,
  );
}

// Translates one entry/exit/transition action config into an ActionJSON.
function translateWorkflowAction(
  action: AgentWorkflowActionConfig,
  translation: WorkflowTranslation,
  location: string,
): Record<string, unknown> {
  if (action.assign !== undefined) {
    return {
      type: "@xstate.assign",
      context: toWorkflowExpression(action.assign),
    };
  }
  if (action.emit !== undefined) {
    return { type: "@xstate.emit", event: toWorkflowExpression(action.emit) };
  }
  if (action.type) {
    if (!(action.type in translation.actions)) {
      throw new Error(
        `setupAgent.fromConfig: ${location} uses named action type '${action.type}', which has ` +
          `no implementation. Provide one via fromConfig options: setupAgent.fromConfig(config, ` +
          `{ actions: { '${action.type}': (params) => ... } }).`,
      );
    }
    return {
      type: action.type,
      ...(action.params !== undefined ? { params: toWorkflowExpression(action.params) } : {}),
    };
  }
  throw new Error(
    `setupAgent.fromConfig: ${location} action must declare 'assign', 'emit', or 'type'.`,
  );
}

// Translates one transition config into a TransitionJSON. All assigns (the
// transition-level `assign` plus action-level `{ assign }` entries, in the
// pre-JSON lowering's fold order) become the transition's `context` patch, NOT
// `@xstate.assign` actions: the JSON layer defers a targeted transition's
// actions to target-state entry, which runs after the target's invoke `input`
// resolves — assigned context must already be visible there.
function translateWorkflowTransition(
  transitionConfig: AgentWorkflowTransitionConfig,
  translation: WorkflowTranslation,
  location: string,
): Record<string, unknown> {
  const actionConfigs = transitionConfig.actions ? toArray(transitionConfig.actions) : [];
  const assignConfigs = [
    ...(transitionConfig.assign !== undefined ? [transitionConfig.assign] : []),
    ...actionConfigs
      .filter((action) => action.assign !== undefined)
      .map((action) => action.assign!),
  ];
  const contextPatch = assignConfigs.length
    ? toWorkflowExpression(Object.assign({}, ...assignConfigs))
    : undefined;
  const actions = actionConfigs
    .filter((action) => action.assign === undefined)
    .map((action) => translateWorkflowAction(action, translation, location));
  const guard = translateWorkflowGuard(transitionConfig.guard, translation, location);

  return {
    ...(transitionConfig.target !== undefined ? { target: transitionConfig.target } : {}),
    ...(guard ? { guard } : {}),
    ...(contextPatch !== undefined ? { context: contextPatch } : {}),
    ...(actions.length ? { actions } : {}),
    ...(transitionConfig.description !== undefined
      ? { description: transitionConfig.description }
      : {}),
    ...(transitionConfig.reenter !== undefined ? { reenter: transitionConfig.reenter } : {}),
    ...(transitionConfig.meta !== undefined ? { meta: transitionConfig.meta } : {}),
  };
}

// Translates a single transition config or first-match array of them.
function translateWorkflowTransitions(
  transitionConfig: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[] | undefined,
  translation: WorkflowTranslation,
  location: string,
) {
  if (!transitionConfig) {
    return undefined;
  }
  return Array.isArray(transitionConfig)
    ? transitionConfig.map((candidate) =>
        translateWorkflowTransition(candidate, translation, location),
      )
    : translateWorkflowTransition(transitionConfig, translation, location);
}

function addTransitionMatch(
  transition: Record<string, unknown> | Record<string, unknown>[] | undefined,
  matches: Record<string, unknown>,
): Record<string, unknown> | Record<string, unknown>[] | undefined {
  if (Array.isArray(transition)) {
    return transition.map((candidate) => addTransitionMatch(candidate, matches)!) as Record<
      string,
      unknown
    >[];
  }
  return transition
    ? {
        ...transition,
        matches: {
          ...(transition.matches as Record<string, unknown> | undefined),
          ...matches,
        },
      }
    : undefined;
}

// Translates an invoke config into an InvokeJSON. `agent.decide` needs no
// special-casing beyond validation: the decision actor auto-delivers the chosen
// event to the invoking actor, so a decide invoke lowers like any other (an
// optional `onDone` observes only a chosen event whose transition stays
// in-state).
function translateWorkflowInvoke(
  invokeConfig: AgentWorkflowInvokeConfig,
  translation: WorkflowTranslation,
  stateKey: string,
): Record<string, unknown> {
  // A decision's output IS its chosen event, delivered automatically via the
  // state's `on` transitions — so an `onDone` on an `agent.decide` invoke can
  // never fire and is always a config error. Reject it early with the state named.
  if (invokeConfig.src === DECIDE_SRC && invokeConfig.onDone !== undefined) {
    throw new Error(
      `setupAgent.fromConfig: state '${stateKey}' declares an 'onDone' on its 'agent.decide' ` +
        `invoke, which is always a config error. A decision has no output of its own — the ` +
        `chosen event is delivered automatically and handled by the state's 'on' transitions. ` +
        `Remove the 'onDone' (use 'on' for the chosen event; 'onError' still handles retries exhausted).`,
    );
  }

  const location = `state '${stateKey}'`;
  return {
    ...(invokeConfig.id !== undefined ? { id: invokeConfig.id } : {}),
    src: invokeConfig.src,
    ...(invokeConfig.input !== undefined
      ? { input: toWorkflowExpression(invokeConfig.input) }
      : {}),
    ...(invokeConfig.onDone !== undefined
      ? {
          onDone: translateWorkflowTransitions(invokeConfig.onDone, translation, location),
        }
      : {}),
    ...(invokeConfig.onError !== undefined
      ? {
          onError: translateWorkflowTransitions(invokeConfig.onError, translation, location),
        }
      : {}),
  };
}

// Config-level structural lint: a plain-string transition `target` must name a
// state at the same level (a sibling key). Relative (`.child`) and absolute
// (`#id`) references are left to xstate to resolve. Every declared target is
// also pushed onto `declaredTargets` (for the static reachability metadata lint
// reads back), including the relative/absolute forms this check skips.
function assertValidTransitionTargets(
  stateKey: string,
  location: string,
  transitionConfig: AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[] | undefined,
  siblingKeys: Set<string>,
  declaredTargets: string[],
): void {
  if (!transitionConfig) {
    return;
  }
  for (const transition of toArray(transitionConfig)) {
    const targets = transition.target === undefined ? [] : toArray(transition.target);
    for (const target of targets) {
      if (typeof target !== "string") {
        continue;
      }
      declaredTargets.push(target);
      if (target.startsWith("#") || target.startsWith(".")) {
        continue;
      }
      const head = target.split(".")[0]!;
      if (!siblingKeys.has(head)) {
        throw new Error(
          `setupAgent.fromConfig: state '${stateKey}' has a ${location} transition targeting ` +
            `'${target}', which is not a state at that level. Valid targets: ${
              [...siblingKeys].join(", ") || "(none)"
            }.`,
        );
      }
    }
  }
}

// Validates every sibling-resolved transition target declared on one state, and
// returns every target it declares (for the static reachability metadata).
function assertStateTransitionTargets(
  stateKey: string,
  stateConfig: AgentWorkflowStateConfig,
  siblingKeys: Set<string>,
): string[] {
  const declaredTargets: string[] = [];
  const invokes = stateConfig.invoke ? toArray(stateConfig.invoke) : [];
  const sources: readonly (readonly [
    string,
    AgentWorkflowTransitionConfig | AgentWorkflowTransitionConfig[] | undefined,
  ])[] = [
    ...Object.entries(stateConfig.on ?? {}).map(
      ([eventType, transition]) => [`'on.${eventType}'`, transition] as const,
    ),
    ...Object.entries(stateConfig.after ?? {}).map(
      ([delay, transition]) => [`'after.${delay}'`, transition] as const,
    ),
    ["'always'", stateConfig.always],
    ["'onDone'", stateConfig.onDone],
    ["'choice'", stateConfig.choice],
    ...invokes.flatMap(
      (invoke) =>
        [
          ["invoke 'onDone'", invoke.onDone],
          ["invoke 'onError'", invoke.onError],
        ] as const,
    ),
  ];
  for (const [location, transition] of sources) {
    assertValidTransitionTargets(stateKey, location, transition, siblingKeys, declaredTargets);
  }
  return declaredTargets;
}

// Recursively translates one AgentWorkflowStateConfig into a StateNodeJSON.
// `stateKey` names this state (for errors); `siblingKeys` is the set of state
// keys at this level (for transition-target validation); `path` is the dotted
// ancestor path (for the state-done event translation).
function translateWorkflowState(
  stateKey: string,
  stateConfig: AgentWorkflowStateConfig,
  siblingKeys: Set<string>,
  path: string[],
  translation: WorkflowTranslation,
): Record<string, unknown> {
  const location = `state '${stateKey}'`;
  // State paths are '.'-joined here (transition-target keys, the synthetic
  // `@state.<path>` done id), so a key containing a '.' would be indistinguishable
  // from a nested path — mis-keying static targets and false-flagging the
  // reachability lint. Reject it at build time instead.
  if (stateKey.includes(".")) {
    throw new Error(
      `setupAgent.fromConfig: state key '${stateKey}' contains a '.', which is reserved as the ` +
        `state-path separator. Rename the state (e.g. '${stateKey.replace(/\./g, "_")}').`,
    );
  }
  const childKeys = new Set(Object.keys(stateConfig.states ?? {}));
  const childPath = [...path, stateKey];
  translation.transitionTargets[childPath.join(".")] = assertStateTransitionTargets(
    stateKey,
    stateConfig,
    siblingKeys,
  );

  // The JSON layer has no state-level `onDone`; translate it to the state's
  // own done event, keyed by an explicit synthetic id (the `@state.` prefix
  // avoids colliding with the machine id — states themselves cannot declare
  // ids in an AgentWorkflowConfig).
  const doneStateId =
    stateConfig.onDone !== undefined ? `@state.${childPath.join(".")}` : undefined;
  const translatedOn = {
    ...Object.fromEntries(
      Object.entries(stateConfig.on ?? {}).map(([eventType, transitionConfig]) => [
        eventType,
        translateWorkflowTransitions(transitionConfig, translation, location),
      ]),
    ),
    ...(doneStateId
      ? {
          "xstate.done.state": addTransitionMatch(
            translateWorkflowTransitions(stateConfig.onDone, translation, location),
            { stateId: doneStateId },
          ),
        }
      : {}),
  };

  return {
    ...(stateConfig.description !== undefined ? { description: stateConfig.description } : {}),
    ...(stateConfig.type !== undefined ? { type: stateConfig.type } : {}),
    ...(doneStateId ? { id: doneStateId } : {}),
    ...(stateConfig.initial !== undefined ? { initial: stateConfig.initial } : {}),
    ...(stateConfig.states !== undefined
      ? {
          states: Object.fromEntries(
            Object.entries(stateConfig.states).map(([key, child]) => [
              key,
              translateWorkflowState(key, child, childKeys, childPath, translation),
            ]),
          ),
        }
      : {}),
    ...(stateConfig.choice !== undefined
      ? {
          choice: toArray(stateConfig.choice).map((branch) => {
            if (branch.actions !== undefined) {
              throw new Error(
                `setupAgent.fromConfig: state '${stateKey}' has a 'choice' branch with ` +
                  `'actions', which is not supported. Use 'assign' on the branch, or move the ` +
                  `actions to the target state's 'entry'.`,
              );
            }
            const when = translateWorkflowGuard(branch.guard, translation, location);
            return {
              ...(when ? { when } : {}),
              target: branch.target,
              ...(branch.assign !== undefined
                ? { context: toWorkflowExpression(branch.assign) }
                : {}),
              ...(branch.description !== undefined ? { description: branch.description } : {}),
              ...(branch.reenter !== undefined ? { reenter: branch.reenter } : {}),
              ...(branch.meta !== undefined ? { meta: branch.meta } : {}),
            };
          }),
        }
      : {}),
    ...(stateConfig.invoke !== undefined
      ? {
          invoke: Array.isArray(stateConfig.invoke)
            ? stateConfig.invoke.map((invoke) =>
                translateWorkflowInvoke(invoke, translation, stateKey),
              )
            : translateWorkflowInvoke(stateConfig.invoke, translation, stateKey),
        }
      : {}),
    ...(Object.keys(translatedOn).length ? { on: translatedOn } : {}),
    ...(stateConfig.always !== undefined
      ? {
          always: translateWorkflowTransitions(stateConfig.always, translation, location),
        }
      : {}),
    ...(stateConfig.after !== undefined
      ? {
          after: Object.fromEntries(
            Object.entries(stateConfig.after).map(([delay, transitionConfig]) => [
              delay,
              translateWorkflowTransitions(transitionConfig, translation, location),
            ]),
          ),
        }
      : {}),
    ...(stateConfig.entry !== undefined
      ? {
          entry: toArray(stateConfig.entry).map((action) =>
            translateWorkflowAction(action, translation, location),
          ),
        }
      : {}),
    ...(stateConfig.exit !== undefined
      ? {
          exit: toArray(stateConfig.exit).map((action) =>
            translateWorkflowAction(action, translation, location),
          ),
        }
      : {}),
    ...(stateConfig.tags !== undefined ? { tags: stateConfig.tags } : {}),
    ...(stateConfig.output !== undefined
      ? { output: toWorkflowExpression(stateConfig.output) }
      : {}),
    ...(stateConfig.meta !== undefined ? { meta: stateConfig.meta } : {}),
  };
}

// Recursively collects every final state's translated `output` value.
function collectTranslatedFinalOutputs(
  states: Record<string, any> | undefined,
  outputs: unknown[] = [],
) {
  for (const state of Object.values(states ?? {})) {
    if (state?.type === "final" && state.output !== undefined) {
      outputs.push(state.output);
    }
    collectTranslatedFinalOutputs(state?.states, outputs);
  }
  return outputs;
}

// Translates a whole AgentWorkflowConfig into the MachineJSON accepted by
// xstate's createMachineFromConfig.
function translateWorkflowConfig(
  config: AgentWorkflowConfig,
  translation: WorkflowTranslation,
): MachineJSON {
  const rootKeys = new Set(Object.keys(config.states));
  const states = Object.fromEntries(
    Object.entries(config.states).map(([key, state]) => [
      key,
      translateWorkflowState(key, state, rootKeys, [], translation),
    ]),
  );

  const json: Record<string, unknown> = {
    "@exprLang": AGENT_EXPRESSION_LANG,
    ...(config.id !== undefined ? { id: config.id } : {}),
    ...(config.description !== undefined ? { description: config.description } : {}),
    // The whole context is always one `@expr` slot (even template-free) so the
    // evaluator can validate the built context against the context schema.
    ...(config.context !== undefined
      ? { context: { "@expr": JSON.stringify(config.context) } }
      : {}),
    initial: config.initial,
    states,
    ...(config.meta !== undefined ? { meta: config.meta } : {}),
  };

  // Single-final-state root-output sugar (mirrors setupAgent's
  // withRootOutputFromSingleFinal): when no root `output` is declared and
  // exactly one final state has one, promote it so `snapshot.output` is set.
  const finalOutputs = collectTranslatedFinalOutputs(states);
  if (json.output === undefined && finalOutputs.length === 1) {
    json.output = finalOutputs[0];
  }

  return json as unknown as MachineJSON;
}

// Recursively collects every tag declared by any state in the config.
function collectDeclaredStateTags(
  states: Record<string, AgentWorkflowStateConfig> | undefined,
  tags = new Set<string>(),
): Set<string> {
  for (const state of Object.values(states ?? {})) {
    for (const tag of state.tags ?? []) {
      tags.add(tag);
    }
    collectDeclaredStateTags(state.states, tags);
  }
  return tags;
}

// Resolves the machine-carried suspension predicate for a fromConfig machine:
// the host `options.isSuspended` function when given, else the config's
// declarative `suspendedTags` lowered to a hasTag-any-of predicate. A
// `suspendedTags` entry no state declares is a typo'd silent no-op — the
// machine would never test as suspended there — so it throws at build time.
function resolveSuspensionPredicate(
  config: AgentWorkflowConfig,
  options: FromConfigOptions,
): ((snapshot: AnyMachineSnapshot) => boolean) | undefined {
  if (options.isSuspended) {
    return options.isSuspended;
  }
  const suspendedTags = config.suspendedTags ?? [];
  if (!suspendedTags.length) {
    return undefined;
  }
  const declaredTags = collectDeclaredStateTags(config.states);
  const unknown = suspendedTags.filter((tag) => !declaredTags.has(tag));
  if (unknown.length) {
    throw new Error(
      `setupAgent.fromConfig: 'suspendedTags' lists ${unknown
        .map((tag) => `'${tag}'`)
        .join(", ")}, which no state declares in its 'tags'. Tag the waiting state(s) — e.g. ` +
        `"tags": ["${unknown[0]}"] — or remove the entry.`,
    );
  }
  return (snapshot) => suspendedTags.some((tag) => snapshot.hasTag(tag));
}

// Implementation backing the public `setupAgent.fromConfig(...)` namespace member (see setup-agent.ts) — translates an AgentWorkflowConfig into MachineJSON and builds the machine through xstate's createMachineFromConfig.
export function setupAgentFromConfig(
  config: AgentWorkflowConfig,
  options: FromConfigOptions,
): FromConfigResult {
  if (!options || typeof options.compileSchema !== "function") {
    throw new Error(
      "setupAgent.fromConfig(...) requires a 'compileSchema' option: " +
        "{ compileSchema: (jsonSchema, name) => StandardSchemaV1 }. Bring your own JSON " +
        "Schema engine (Ajv, @cfworker/json-schema, a compiled-Zod-from-JSON-Schema " +
        "pipeline, ...). Core intentionally ships no JSON Schema engine.",
    );
  }

  const { compileSchema } = options;
  const schemas = createSchemasFromWorkflowConfig(config, compileSchema);
  const requests = createRequestsFromWorkflowConfig(config, compileSchema);
  const requestActors = createRequestActors(requests);
  const actors = createAgentActors(
    createActorPlaceholdersFromWorkflowConfig(config),
    requestActors,
  ) as Record<string, AnyActorLogic>;

  const translation: WorkflowTranslation = {
    guards: options.guards ?? {},
    actions: options.actions ?? {},
    syntheticGuards: {},
    transitionTargets: {},
  };
  const json = translateWorkflowConfig(config, translation);

  const machine = createMachineFromConfig(json, {
    guards: Object.fromEntries(
      Object.entries({
        ...translation.guards,
        ...translation.syntheticGuards,
      }).map(([name, implementation]) => [
        name,
        // xstate calls guard implementations with its full guard-args object;
        // narrow to the documented fromConfig guard scope.
        (args: { context: unknown; event: unknown }) =>
          Boolean(implementation({ context: args.context, event: args.event })),
      ]),
    ),
    ...(options.actions ? { actions: options.actions } : {}),
    // createMachineFromConfig embeds `sources.actors[src]` as the
    // invoke's src DIRECTLY — but runAgent's executor rebinding needs srcs to
    // stay string keys resolved through the machine's sources. Mapping
    // each key to itself satisfies the JSON layer's every-src-implemented
    // assertion while keeping `src` a string; the real logic is then bound via
    // `.provide({ actors })` below (and remains host-rebindable).
    actors: Object.fromEntries(Object.keys(actors).map((key) => [key, key])) as never,
    evaluators: {
      [AGENT_EXPRESSION_LANG]: createWorkflowConfigEvaluator(schemas.context),
    },
  }).provide({ actors });

  // What setupAgent's wrapped createMachine registers for runAgent: the
  // schemas/actors this machine executes with.
  agentExecutionOptions.set(machine as object, { schemas, actors, models: {} });
  // The config's transition targets, which the JSON layer erases from
  // `machine.config` whenever a transition carries a context patch. Keyed on the
  // root config object so lint still sees them after `machine.provide(...)`.
  if (machine.config) {
    machineStaticTransitionTargets.set(machine.config as object, translation.transitionTargets);
  }
  // The wait-state predicate (options.isSuspended, or the config's declarative
  // `suspendedTags`), carried on the root config like setupAgent's — so it
  // survives further `machine.provide(...)` executor rebinding.
  const isSuspended = resolveSuspensionPredicate(config, options);
  if (isSuspended && machine.config) {
    machineSuspensionPredicates.set(machine.config as object, isSuspended);
  }
  return { machine, schemas };
}

/**
 * What `setupAgent.fromConfig(...)` returns: the built machine plus the
 * schema pack compiled from the config's `schemas` (with `compileSchema`).
 * The pack is what hosts need for the runtime work the machine's types can't
 * do for a JSON-authored agent — e.g. validating an inbound raw event:
 *
 * @example
 * ```ts
 * const { machine, schemas } = setupAgent.fromConfig(config, { compileSchema });
 * const event = parseAgentEvent(snapshot, raw, { events: schemas.events });
 * ```
 */
export interface FromConfigResult {
  machine: AnyStateMachine;
  /** Compiled `context`/`events`/`input`/`output`/`meta`/`emitted` schemas — the same pack `runAgent` executes this machine with. */
  schemas: AgentSchemaPack<
    StandardSchemaV1<Record<string, unknown>>,
    Record<string, StandardSchemaV1>,
    StandardSchemaV1,
    StandardSchemaV1,
    StandardSchemaV1<MetaObject>
  >;
}

/** Options for `setupAgent.fromConfig(...)`. */
export interface FromConfigOptions {
  /**
   * Compile a JSON Schema from the config into a runtime validator. Bring
   * your own engine (Ajv, @cfworker/json-schema, a compiled-Zod-from-JSON-Schema
   * pipeline, ...). Core intentionally ships no JSON Schema engine.
   */
  compileSchema: SchemaCompiler;
  /**
   * Host guard implementations for named guard references in the config
   * (`guard: "isFromHuman"`). Each is called with `{ context, event }` and
   * returns a boolean. A named guard reference with no implementation here is
   * a build-time error — a guard is never silently dropped.
   */
  guards?: Record<string, (args: { context: any; event: any }) => boolean>;
  /**
   * Host action implementations for named action types in the config
   * (`{ type: "notify", params: ... }`). Each is called with the
   * template-resolved `params` as its only argument — pull context/event data
   * into `params` via `{{ ... }}` templates. A named action type with no
   * implementation here is a build-time error.
   */
  actions?: Record<string, (params: any) => unknown>;
  /**
   * Detects a snapshot that is an INTENTIONAL wait for an external event —
   * the same machine-carried predicate `setupAgent({ isSuspended })` declares
   * for TS-authored machines, registered here because a function cannot live
   * in the workflow config itself. Takes precedence over the config's
   * declarative {@link AgentWorkflowConfig.suspendedTags}; a
   * `runAgent({ isSuspended })` host override beats both. Travels with the
   * machine through `machine.provide(...)`.
   */
  isSuspended?: (snapshot: AnyMachineSnapshot) => boolean;
}
