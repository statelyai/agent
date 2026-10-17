/**
 * The pre-run gate pipeline for a model-authored workflow config:
 * validate → vocabulary → lower → lint → explore. Each gate returns a record
 * whose `detail` names the offending path, state, or name, so a repair loop
 * can feed a failed gate straight back to the model.
 */
import type { AnyActorLogic, AnyStateMachine } from "xstate";
import { DECIDE_ACTOR, GENERATE_TEXT_ACTOR, STREAM_TEXT_ACTOR } from "../text-logic.js";
import { explorePaths, lintAgentMachine, type ExplorePathsOptions } from "../verify.js";
import {
  setupAgentFromConfig,
  type AgentWorkflowConfig,
  type FromConfigOptions,
  type SchemaCompiler,
} from "../workflow-config.js";
import { validateAgentConfig } from "./validate-config.js";

/** The gates {@link verifyAgentConfig} runs, in order. */
export type AgentConfigGateName = "validate" | "vocabulary" | "lower" | "lint" | "explore";

/** One gate's outcome. `detail` is a short, model-readable message (one problem per line). */
export interface AgentConfigGate {
  name: AgentConfigGateName;
  ok: boolean;
  detail?: string;
}

/**
 * The names a config may reference. An omitted key is unrestricted; a listed
 * key restricts that kind of reference to exactly these names.
 */
export interface AgentConfigVocabulary {
  /** Invoke srcs (besides `agent.*` builtins) and `actors` keys. */
  actors?: string[];
  /** Invoke srcs (besides `agent.*` builtins) and `requests` keys. */
  requests?: string[];
  /** Named guard references (`guard: "isReady"`, not `{{ }}` templates). */
  guards?: string[];
  /** Named action types (`{ type: "notify" }`). */
  actions?: string[];
  /** Event types an `agent.decide` invoke may list in `allowedEvents`. */
  events?: string[];
  /** Model refs. Each must be a literal string (not a `{{ }}` template) in this set. */
  models?: string[];
}

/** The `explore` options of {@link verifyAgentConfig}. Other keys pass through to `explorePaths`. */
export interface VerifyAgentConfigExploreOptions extends Omit<ExplorePathsOptions, "input"> {
  /** One `explorePaths` run per input. */
  inputs: unknown[];
  /** Terminal statuses every explored path must end in. Default `['done']`. */
  terminals?: Array<"done" | "idle">;
  [key: string]: unknown;
}

/** Options for {@link verifyAgentConfig}. */
export interface VerifyAgentConfigOptions {
  /** The JSON Schema compiler `setupAgent.fromConfig` uses. */
  compileSchema: SchemaCompiler;
  /** Named guard implementations, passed to `setupAgent.fromConfig`. */
  guards?: FromConfigOptions["guards"];
  /** Named action implementations, passed to `setupAgent.fromConfig`. */
  actions?: FromConfigOptions["actions"];
  /** Actor implementations, bound with `machine.provide({ actors })` after lowering. */
  actors?: Record<string, AnyActorLogic>;
  /** The names the config may reference. Omit to skip the vocabulary checks. */
  allow?: AgentConfigVocabulary;
  /** Lint policy. Error findings always fail; `warnings: true` fails on warnings too. */
  lint?: { warnings?: boolean };
  /** Path exploration. Omit to skip the `explore` gate. */
  explore?: VerifyAgentConfigExploreOptions;
}

/** Result of {@link verifyAgentConfig}. */
export interface VerifyAgentConfigResult {
  /** True when every gate that ran passed. */
  ok: boolean;
  /** The gates that ran, in order. A failing gate is the last entry. */
  gates: AgentConfigGate[];
  /** The lowered machine, set when the `lower` gate passed. */
  machine?: AnyStateMachine;
  /** The typed config, set when the `validate` gate passed. */
  config?: AgentWorkflowConfig;
}

const BUILTIN_SRCS: readonly string[] = [DECIDE_ACTOR, GENERATE_TEXT_ACTOR, STREAM_TEXT_ACTOR];
const MAX_DETAIL_LINES = 10;

/**
 * Runs every pre-run gate on a model-authored workflow config and stops at
 * the first failure. Never throws on a bad config: each failure becomes a gate
 * record whose `detail` is a repair prompt.
 *
 * - `validate`: the config's shape, against the shipped JSON Schema.
 * - `vocabulary`: names the config references, against `allow`.
 * - `lower`: `setupAgent.fromConfig` (unresolved guards/actions, bad targets).
 * - `lint`: `lintAgentMachine` (errors fail; warnings fail with `lint.warnings`).
 * - `explore`: `explorePaths` from each `explore.inputs` entry; every terminal
 *   must be one of `explore.terminals`.
 *
 * @example
 * ```ts
 * const result = await verifyAgentConfig(candidate, { compileSchema, allow: { events: ["APPROVE", "DENY"] } });
 * const failed = result.gates.find((gate) => !gate.ok);
 * if (failed) feedback.push(`gate '${failed.name}' failed: ${failed.detail}`);
 * ```
 */
export async function verifyAgentConfig(
  config: unknown,
  options: VerifyAgentConfigOptions,
): Promise<VerifyAgentConfigResult> {
  const gates: AgentConfigGate[] = [];
  const record = (name: AgentConfigGateName, problems: string[], notes: string[] = []) => {
    const lines = problems.length ? problems : notes;
    gates.push({
      name,
      ok: problems.length === 0,
      ...(lines.length ? { detail: formatDetail(lines) } : {}),
    });
    return problems.length === 0;
  };
  const fail = (extra: Partial<VerifyAgentConfigResult> = {}): VerifyAgentConfigResult => ({
    ok: false,
    gates,
    ...extra,
  });

  const validation = validateAgentConfig(config);
  if (
    !record(
      "validate",
      validation.errors.map((error) => `${error.path} ${error.message}`),
    )
  ) {
    return fail();
  }
  const typed = config as AgentWorkflowConfig;

  if (options.allow && !record("vocabulary", checkVocabulary(typed, options.allow))) {
    return fail({ config: typed });
  }

  let machine: AnyStateMachine;
  try {
    machine = setupAgentFromConfig(typed, {
      compileSchema: options.compileSchema,
      ...(options.guards ? { guards: options.guards } : {}),
      ...(options.actions ? { actions: options.actions } : {}),
    }).machine;
    if (options.actors) machine = machine.provide({ actors: options.actors });
  } catch (error) {
    record("lower", [errorMessage(error)]);
    return fail({ config: typed });
  }
  record("lower", []);

  const diagnostics = lintAgentMachine(machine).map((d) => ({
    failing: d.severity === "error" || options.lint?.warnings === true,
    line: `${d.severity} ${d.code} at '${d.path}': ${d.message}`,
  }));
  const lintOk = record(
    "lint",
    diagnostics.filter((d) => d.failing).map((d) => d.line),
    diagnostics.map((d) => d.line),
  );
  if (!lintOk) return fail({ config: typed, machine });

  if (options.explore && !record("explore", await checkExplore(machine, options.explore))) {
    return fail({ config: typed, machine });
  }

  return { ok: true, gates, config: typed, machine };
}

// ─── vocabulary ───

type ConfigNode = Record<string, unknown>;

/** A config's `T | T[]` field as a list of objects. */
const nodes = (value: unknown): ConfigNode[] =>
  (value === undefined ? [] : Array.isArray(value) ? value : [value]).filter(
    (node): node is ConfigNode => !!node && typeof node === "object",
  );

const hasTemplate = (value: unknown) => typeof value === "string" && value.includes("{{");

const list = (names: readonly string[]) => (names.length ? names.join(", ") : "(none)");

/** Every state in the config, depth-first, with its dotted path. */
function walkStates(states: unknown, prefix = ""): Array<{ path: string; state: ConfigNode }> {
  if (!states || typeof states !== "object") return [];
  return Object.entries(states as Record<string, ConfigNode>).flatMap(([key, state]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [{ path, state }, ...walkStates(state?.states, path)];
  });
}

/** Every transition on a state: `on`, `after`, `always`, `choice`, `onDone`, and invoke done/error. */
function transitionsOf(state: ConfigNode): ConfigNode[] {
  return [
    ...Object.values((state.on ?? {}) as Record<string, unknown>).flatMap(nodes),
    ...Object.values((state.after ?? {}) as Record<string, unknown>).flatMap(nodes),
    ...nodes(state.always),
    ...nodes(state.choice),
    ...nodes(state.onDone),
    ...nodes(state.invoke).flatMap((invoke) => [...nodes(invoke.onDone), ...nodes(invoke.onError)]),
  ];
}

function checkVocabulary(config: AgentWorkflowConfig, allow: AgentConfigVocabulary): string[] {
  const problems: string[] = [];
  const checkModel = (where: string, model: unknown) => {
    if (!allow.models) return;
    if (typeof model !== "string" || hasTemplate(model)) {
      problems.push(`${where} needs a literal string model ref; allowed: ${list(allow.models)}`);
    } else if (!allow.models.includes(model)) {
      problems.push(`${where} uses model '${model}'; allowed: ${list(allow.models)}`);
    }
  };

  for (const [kind, declared, allowed] of [
    ["request", config.requests, allow.requests],
    ["actor", config.actors, allow.actors],
  ] as const) {
    if (!allowed) continue;
    for (const key of Object.keys(declared ?? {})) {
      if (!allowed.includes(key)) {
        problems.push(`${kind} '${key}' is not in the vocabulary; allowed: ${list(allowed)}`);
      }
    }
  }
  for (const [key, request] of Object.entries(config.requests ?? {})) {
    checkModel(`request '${key}'`, request.model);
  }

  // An omitted `actors` list leaves non-request srcs unrestricted; an omitted
  // `requests` list admits the config's own declared requests.
  const srcs = allow.actors
    ? [...BUILTIN_SRCS, ...allow.actors, ...(allow.requests ?? Object.keys(config.requests ?? {}))]
    : undefined;

  for (const { path, state } of walkStates(config.states)) {
    for (const invoke of nodes(state.invoke)) {
      const src = String(invoke.src);
      if (srcs && !srcs.includes(src)) {
        problems.push(`state '${path}' invokes unknown src '${src}'; allowed: ${list(srcs)}`);
        continue;
      }
      if (!BUILTIN_SRCS.includes(src)) continue;
      const input = invoke.input;
      if ((allow.models || (src === DECIDE_ACTOR && allow.events)) && !isPlainObject(input)) {
        problems.push(`state '${path}': '${src}' input must be a literal object`);
        continue;
      }
      checkModel(`state '${path}': '${src}'`, (input as ConfigNode | undefined)?.model);
      if (src !== DECIDE_ACTOR || !allow.events) continue;
      const allowedEvents = (input as ConfigNode).allowedEvents;
      if (!Array.isArray(allowedEvents) || allowedEvents.length === 0) {
        problems.push(
          `state '${path}': agent.decide needs a literal, non-empty allowedEvents list; allowed: ${list(allow.events)}`,
        );
        continue;
      }
      for (const type of allowedEvents) {
        if (typeof type !== "string" || !allow.events.includes(type)) {
          problems.push(
            `state '${path}': agent.decide allowedEvents entry '${String(type)}' is not allowed; allowed: ${list(allow.events)}`,
          );
        }
      }
    }

    const actionsAt: Array<[string, unknown]> = [
      ["entry", state.entry],
      ["exit", state.exit],
    ];
    for (const transition of transitionsOf(state)) {
      const guard = transition.guard;
      if (
        allow.guards &&
        typeof guard === "string" &&
        !hasTemplate(guard) &&
        !allow.guards.includes(guard)
      ) {
        problems.push(
          `state '${path}' uses unknown named guard '${guard}'; allowed: ${list(allow.guards)}`,
        );
      }
      actionsAt.push(["a transition", transition.actions]);
    }
    if (!allow.actions) continue;
    for (const [where, actions] of actionsAt) {
      for (const action of nodes(actions)) {
        if (typeof action.type === "string" && !allow.actions.includes(action.type)) {
          problems.push(
            `state '${path}' ${where} uses unknown named action '${action.type}'; allowed: ${list(allow.actions)}`,
          );
        }
      }
    }
  }
  return problems;
}

const isPlainObject = (value: unknown): value is ConfigNode =>
  !!value && typeof value === "object" && !Array.isArray(value);

// ─── explore ───

async function checkExplore(
  machine: AnyStateMachine,
  options: VerifyAgentConfigExploreOptions,
): Promise<string[]> {
  const { inputs, terminals = ["done"], ...rest } = options;
  const allowed: readonly string[] = terminals;
  const maxDepth = options.maxDepth ?? 8;
  const problems = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    const at = inputs.length > 1 ? `input ${index}: ` : "";
    let report;
    try {
      report = await explorePaths(machine, { ...rest, input } as ExplorePathsOptions);
    } catch (error) {
      problems.add(`${at}exploration threw: ${errorMessage(error)}`);
      continue;
    }
    for (const terminal of report.terminals) {
      if (allowed.includes(terminal.status)) continue;
      const trail = `path [${terminal.path.map((event) => event.type).join(", ")}]`;
      const state = JSON.stringify(terminal.state);
      switch (terminal.status) {
        case "max-depth":
          problems.add(
            `${at}${trail} hit maxDepth ${maxDepth} in state ${state} without ending; the workflow may loop`,
          );
          break;
        case "needs-output":
          problems.add(
            `${at}${trail} reached '${terminal.missingSrc}' in state ${state}, which has no canned output to explore with`,
          );
          break;
        case "error":
          problems.add(
            `${at}${trail} errored in state ${state} with no onError: ${errorMessage(terminal.error)}`,
          );
          break;
        default:
          problems.add(
            `${at}${trail} ends '${terminal.status}' in state ${state}; every path must end ${allowed.map((t) => `'${t}'`).join(" or ")}`,
          );
      }
    }
    if (report.hitPathCap) {
      problems.add(
        `${at}hit the path cap (${options.maxPaths ?? 200} paths) before exploring every path; the workflow branches too much to verify`,
      );
    }
  }
  return [...problems];
}

// ─── helpers ───

function formatDetail(lines: string[]): string {
  const shown = lines.slice(0, MAX_DETAIL_LINES);
  const hidden = lines.length - shown.length;
  return [...shown, ...(hidden > 0 ? [`(${hidden} more)`] : [])].join("\n");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
