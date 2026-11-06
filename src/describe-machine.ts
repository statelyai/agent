/**
 * A machine, described in plain text for a model to read: the prompt for a
 * model that proposes an improved machine, or extra context for a decider.
 *
 * The text is read from the machine's own definition (`machineToJSON`):
 * for a `setupAgent.fromConfig(...)` machine that is the lowered JSON config,
 * so every target, guard and context patch is data; for a TS-authored machine,
 * transitions written as functions are read from their source.
 *
 * @module
 */
import {
  machineToJSON,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type AnyStateNode,
} from "xstate";
import { getAgentExecutionOptions } from "./internal/registry.js";
import { readContextSource, readTransitionSource } from "./internal/transition-source.js";
import type { StandardSchemaV1 } from "./types.js";
import { getJsonSchemaSync } from "./utils.js";

/** Options for {@link describeMachine}. */
export interface DescribeMachineOptions {
  /** Marks the state nodes active in this snapshot with `*`. */
  snapshot?: AnyMachineSnapshot;
  /**
   * Prints each transition written as a function under its line, so one read
   * shows both where it goes and what it computes.
   */
  source?: boolean;
  /**
   * Functions the machine's transitions call by name (guards, reducers), each
   * printed with its source in a `Helpers` section, so a call such as
   * `withinLimit(context.turn, context.limit)` can be read through.
   */
  helpers?: Record<string, (...args: never[]) => unknown>;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toList = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The source of a function as serialized (`{ "@code" }`) or as a live function. */
function codeOf(value: unknown): string | undefined {
  const code =
    typeof value === "function"
      ? String(value)
      : isObject(value) && typeof value["@code"] === "string"
        ? value["@code"]
        : undefined;
  return code === undefined ? undefined : unbundle(code);
}

/** Source as written: vite SSR's named-import rewrites (`(0, __vite_ssr_import_3__.f)`) undone; a default import's `.default` stays, as bare `default` would not parse. */
function unbundle(code: string): string {
  return code
    .replace(/\(0,\s*__vite_ssr_import_\d+__\.(?!default\b)([\w$]+)\)/g, "$1")
    .replace(/__vite_ssr_import_\d+__\.(?!default\b)/g, "");
}

/** The decoded value of a fromConfig `{ "@expr": "<json>" }` slot, or the value itself. */
function decodeExpr(value: unknown): unknown {
  if (isObject(value) && typeof value["@expr"] === "string") {
    try {
      return JSON.parse(value["@expr"]);
    } catch {
      return value["@expr"];
    }
  }
  return value;
}

/** A target as written, resolved from the state the transition leaves: `#id`, `.child`, or a sibling (`sibling.child`). */
function resolveTarget(source: AnyStateNode, target: string): AnyStateNode | undefined {
  if (target.startsWith("#")) {
    try {
      return source.machine.getStateNodeById(target.slice(1));
    } catch {
      return undefined;
    }
  }
  const [from, path] = target.startsWith(".")
    ? [source, target.slice(1)]
    : [source.parent ?? source, target];
  let node: AnyStateNode | undefined = from;
  for (const key of path.split(".")) node = node?.states[key];
  return node;
}

/** A target as said from where the transition starts: a sibling by key, else its path below the machine. */
const nameOf = (source: AnyStateNode, target: AnyStateNode) =>
  target.parent === source.parent ? target.key : target.path.join(".");

/** What a transition sets in context: a declarative patch's keys, or each returned `context` in a function's source. */
function contextKeys(transition: Json | undefined, code: string | undefined): string[] {
  const keys = new Set<string>();
  if (code) for (const key of readTransitionSource(code)?.context ?? []) keys.add(key);
  if (transition) {
    const context = decodeExpr(transition.context);
    const contextCode = codeOf(context);
    if (contextCode) for (const key of readContextSource(contextCode) ?? ["…"]) keys.add(key);
    else if (isObject(context)) for (const key of Object.keys(context)) keys.add(key);
    for (const action of toList(transition.actions)) {
      if (isObject(action) && action.type === "@xstate.assign") {
        const assigned = decodeExpr(action.context);
        if (isObject(assigned)) for (const key of Object.keys(assigned)) keys.add(key);
      }
    }
  }
  return [...keys];
}

/** A guard as said in the text: a template's dotted path, a named guard, or `guarded` when it is code. */
function guardText(guard: unknown): string | undefined {
  if (guard === undefined || guard === null) return undefined;
  const decoded = decodeExpr(guard);
  if (typeof decoded === "string") {
    return oneLine(/^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(decoded)?.[1] ?? decoded);
  }
  if (isObject(decoded) && typeof decoded.type === "string") {
    // fromConfig registers function guards under generated names.
    return decoded.type.startsWith("__fromConfigGuard") ? "guarded" : decoded.type;
  }
  return "guarded";
}

/**
 * Where a transition written as a function goes, read from its return paths:
 * each literal target (`x ?` when it names no state node), `?` for one the
 * source does not spell out (a variable's value, a helper call's result),
 * `(conditional)` when it may decline, stay, or pick among several, and
 * `(stays)` when no path names a target.
 */
function targetsInSource(source: AnyStateNode, code: string, choice: boolean): string {
  const read = readTransitionSource(code);
  if (!read) return "?";
  const names = read.targets.map((target) => {
    const node = resolveTarget(source, target);
    return node ? nameOf(source, node) : `${target} ?`;
  });
  const parts = [...new Set(names)];
  if (read.unknown) parts.push("?");
  if (!parts.length) return "(stays)";
  if (parts.length === 1 && read.unknown) return "?";
  const conditional = parts.length > 1 || (!choice && (read.declines || read.stays));
  return `${parts.join(", ")}${conditional ? " (conditional)" : ""}`;
}

/** One transition, as a line: `on GO (human) if context.ready → review; sets draft — description`. */
function transitionLine(
  source: AnyStateNode,
  head: string,
  transition: unknown,
  options: { guardKey?: "guard" | "when"; choice?: boolean } = {},
): string {
  const code = codeOf(transition);
  let to: string;
  let guard: string | undefined;
  let description: string | undefined;
  let human = false;
  let sets: string[];
  if (typeof transition === "string") {
    const node = resolveTarget(source, transition);
    to = node ? nameOf(source, node) : `${transition} ?`;
    sets = [];
  } else if (code !== undefined) {
    to = targetsInSource(source, code, options.choice ?? false);
    sets = contextKeys(undefined, code);
  } else if (isObject(transition) && !("@expr" in transition)) {
    const targets = toList(transition.target).filter((t): t is string => typeof t === "string");
    to = targets.length
      ? targets
          .map((target) => {
            const node = resolveTarget(source, target);
            return node ? nameOf(source, node) : `${target} ?`;
          })
          .join(", ")
      : "(stays)";
    guard = guardText(transition[options.guardKey ?? "guard"]);
    description = typeof transition.description === "string" ? transition.description : undefined;
    human = isObject(transition.meta) && transition.meta.actor === "human";
    sets = contextKeys(transition, undefined);
  } else {
    to = "?";
    sets = [];
  }
  return `${head}${human ? " (human)" : ""}${guard ? ` if ${guard}` : ""} → ${to}${sets.length ? `; sets ${sets.join(", ")}` : ""}${
    description ? ` — ${oneLine(description)}` : ""
  }`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${ms / 1000}s`;
}

/** An `after` key as said: `1s`, or a named delay with its duration when it is a number (`slow (5s)`). */
function delayText(key: string, delays: Json): string {
  if (/^\d+(\.\d+)?$/.test(key)) return formatMs(Number(key));
  const delay = delays[key];
  return typeof delay === "number" ? `${key} (${formatMs(delay)})` : key;
}

/** A transition function's source (or a config transition's context function), dedented, at `pad`. */
function sourceLines(transition: unknown, pad: string): string[] {
  const code =
    codeOf(transition) ??
    (isObject(transition) ? codeOf(decodeExpr(transition.context)) : undefined);
  if (!code) return [];
  const [first = "", ...rest] = code.split("\n");
  const indent = Math.min(
    ...rest.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)![0].length),
  );
  return [first, ...rest.map((line) => line.slice(Number.isFinite(indent) ? indent : 0))]
    .filter((line) => line.trim())
    .map((line) => `${pad}  | ${line.trimEnd()}`);
}

/** Every transition leaving one state node, as lines at `pad`. */
function transitionLines(
  node: AnyStateNode,
  json: Json,
  delays: Json,
  pad: string,
  source: boolean,
): string[] {
  const lines: string[] = [];
  const line = (
    head: string,
    transition: unknown,
    options?: Parameters<typeof transitionLine>[3],
  ) => {
    lines.push(`${pad}${transitionLine(node, head, transition, options)}`);
    if (source) lines.push(...sourceLines(transition, pad));
  };
  const push = (head: string, value: unknown) => {
    for (const transition of toList(value)) line(head, transition);
  };
  if (source) {
    for (const key of ["entry", "exit"] as const) {
      for (const action of toList(json[key])) {
        const code = sourceLines(action, pad);
        if (code.length) lines.push(`${pad}${key}`, ...code);
      }
    }
  }
  for (const [event, value] of Object.entries(isObject(json.on) ? json.on : {})) {
    // fromConfig lowers a state-level `onDone` to its own done event.
    push(event === "xstate.done.state" ? "onDone" : `on ${event}`, value);
  }
  push("onDone", json.onDone);
  push("always", json.always);
  for (const [key, value] of Object.entries(isObject(json.after) ? json.after : {})) {
    push(`after ${delayText(key, delays)}`, value);
  }
  for (const invoke of toList(json.invoke)) {
    if (!isObject(invoke)) continue;
    const src = typeof invoke.src === "string" ? invoke.src : "(inline)";
    const id = typeof invoke.id === "string" && invoke.id !== src ? ` (${invoke.id})` : "";
    lines.push(`${pad}invoke ${src}${id}`);
    push("  done", invoke.onDone);
    push("  error", invoke.onError);
  }
  if (json.choice !== undefined) {
    const branches = toList(json.choice);
    branches.forEach((branch, index) => {
      const guarded = isObject(branch) && branch.when !== undefined;
      const head = guarded || index === 0 ? "choice" : "choice else";
      line(head, branch, { guardKey: "when", choice: true });
    });
  }
  return lines;
}

/** The state node's line: key, type, tags, interaction label, description. */
function stateLine(node: AnyStateNode, json: Json): string {
  let marker = "";
  if (node.type === "final" || node.type === "choice" || node.type === "parallel") {
    marker = ` (${node.type})`;
  } else if (node.type === "history") {
    marker = json.history === "deep" ? " (history, deep)" : " (history)";
  } else if (node.type === "compound" && typeof json.initial === "string") {
    marker = ` (initial: ${json.initial})`;
  }
  const tags = node.tags.length ? ` [tags: ${node.tags.join(", ")}]` : "";
  const interaction = (node.meta as { interaction?: { label?: unknown } } | undefined)?.interaction;
  const label = !interaction
    ? ""
    : typeof interaction.label === "string"
      ? ` [interaction: "${oneLine(interaction.label)}"]`
      : typeof interaction.label === "function"
        ? " [interaction: computed label]"
        : " [interaction]";
  const description = node.description ? ` — ${oneLine(node.description)}` : "";
  return `${node.key}${marker}${tags}${label}${description}`;
}

/** The machine's events with their schema descriptions and fields, sorted by type. */
function eventLines(machine: AnyStateMachine): string[] {
  // An agent machine's registered schemas, else a plain machine's own `schemas.events`.
  const schemas = (getAgentExecutionOptions(machine)?.schemas?.events ??
    machine.schemas?.events ??
    {}) as Record<string, StandardSchemaV1>;
  const lines: string[] = [];
  for (const type of Object.keys(schemas).sort()) {
    if (type.startsWith("@agent.") || type.startsWith("xstate.")) continue;
    let schema: Json | undefined;
    try {
      schema = getJsonSchemaSync(schemas[type]);
    } catch {
      schema = undefined;
    }
    const direct = (schemas[type] as { description?: unknown }).description;
    const description =
      typeof schema?.description === "string"
        ? schema.description
        : typeof direct === "string"
          ? direct
          : undefined;
    lines.push(`  ${type}${description ? ` — ${oneLine(description)}` : ""}`);
    const properties = isObject(schema?.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
    for (const [field, property] of Object.entries(properties)) {
      if (!isObject(property)) continue;
      const fieldType = Array.isArray(property.enum)
        ? property.enum.map((value) => JSON.stringify(value)).join(" | ")
        : Array.isArray(property.type)
          ? property.type.join(" | ")
          : typeof property.type === "string"
            ? property.type
            : undefined;
      const fieldDescription =
        typeof property.description === "string" ? ` — ${oneLine(property.description)}` : "";
      lines.push(
        `    ${field}${required.has(field) ? "" : "?"}${fieldType ? `: ${fieldType}` : ""}${fieldDescription}`,
      );
    }
  }
  return lines;
}

/**
 * Describes a machine in plain text for a model to read. The machine's
 * `description` is its goal, so it leads: `Machine <id>`, then `Goal: …`.
 * Then every state node, indented by depth, with its type, tags, interaction
 * label and description (`*` marks the active ones when `snapshot` is given),
 * and under it every transition leaving it, one per line: `on EVENT`,
 * `always`, `after <delay>`, invoke `done`/`error`, and `choice` branches,
 * each with `(human)` when its `meta.actor` is `"human"`, its guard (`if …`),
 * where it goes (`→ review`), and what it sets in context (`sets draft,
 * attempts`). An `Events` section lists the machine's event schemas with their
 * descriptions and fields.
 *
 * A transition written as a function shows the targets its source names
 * (`→ review (conditional)` when it may decline or pick among several),
 * `(stays)` when its source has no `target`, or `→ ?` when no target can be
 * read (a variable's value, a helper call's result). Function sources are
 * parsed, so every return path counts: ternaries, `&&`/`||`, early returns and
 * local constants. With `source: true`, each function is printed under its
 * line, along with entry and exit actions; pass `helpers` to print the
 * functions they call by name. A `setupAgent.fromConfig(...)` machine is read from its config, so
 * its targets, guards and context patches are always known.
 *
 * @example
 * ```ts
 * const prompt = `Propose a better machine for this goal.\n\n${describeMachine(machine)}`;
 * ```
 */
export function describeMachine(
  machine: AnyStateMachine,
  options: DescribeMachineOptions = {},
): string {
  const json = machineToJSON(machine) as Json;
  const delays = isObject(json.delays) ? json.delays : {};
  const active = new Set(options.snapshot?.nodes.map((node) => node.id) ?? []);
  const source = options.source ?? false;
  const root = machine.root;

  const lines = [`Machine ${machine.id}`];
  if (root.description) lines.push(`Goal: ${root.description.trim()}`);

  const rootTransitions = transitionLines(root, json, delays, "  ", source);
  if (rootTransitions.length) lines.push("Any state:", ...rootTransitions);

  const initial = typeof json.initial === "string" ? ` (initial: ${json.initial})` : "";
  lines.push(`States${initial}${options.snapshot ? " (* = current)" : ""}:`);
  const walk = (node: AnyStateNode, nodeJson: Json, depth: number) => {
    const pad = "  ".repeat(depth);
    const mark = active.has(node.id) ? `${pad.slice(2)}* ` : pad;
    lines.push(`${mark}${stateLine(node, nodeJson)}`);
    lines.push(...transitionLines(node, nodeJson, delays, `${pad}    `, source));
    const childJson = isObject(nodeJson.states) ? nodeJson.states : {};
    for (const [key, child] of Object.entries(node.states)) {
      walk(child, isObject(childJson[key]) ? childJson[key] : {}, depth + 1);
    }
  };
  const rootStates = isObject(json.states) ? json.states : {};
  for (const [key, child] of Object.entries(root.states)) {
    walk(child, isObject(rootStates[key]) ? rootStates[key] : {}, 1);
  }

  const events = eventLines(machine);
  if (events.length) lines.push("Events:", ...events);
  const helpers = Object.entries(options.helpers ?? {});
  if (helpers.length) {
    lines.push("Helpers:");
    for (const [name, helper] of helpers) lines.push(`  ${name}`, ...sourceLines(helper, "  "));
  }
  return lines.join("\n");
}
