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
import type { StandardSchemaV1 } from "./types.js";
import { getJsonSchemaSync } from "./utils.js";

/** Options for {@link describeMachine}. */
export interface DescribeMachineOptions {
  /** Marks the state nodes active in this snapshot with `*`. */
  snapshot?: AnyMachineSnapshot;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toList = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The source of a function as serialized (`{ "@code" }`) or as a live function. */
function codeOf(value: unknown): string | undefined {
  if (typeof value === "function") return String(value);
  if (isObject(value) && typeof value["@code"] === "string") return value["@code"];
  return undefined;
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

/**
 * The keys of the object literal whose `{` is at `open` in `text`, at its top
 * level: `a`, `b` for `{ a: 1, b, ...c }`, and `…c` for a spread, whose keys
 * cannot be read. Strings, templates and nested brackets are skipped over.
 */
function objectKeys(text: string, open: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      depth++;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      if (--depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (c === ",") {
      expectKey = true;
      continue;
    }
    if (expectKey && !/\s/.test(c)) {
      expectKey = false;
      if (text.startsWith("...", i)) {
        const spread = /^\.\.\.\s*([\w$.]+)(\()?/.exec(text.slice(i));
        keys.push(`…${spread?.[1] ?? ""}${spread?.[2] ? "()" : ""}`);
        continue;
      }
      const key = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))?.[0];
      if (key) {
        keys.push(key);
        i += key.length - 1;
      }
    }
  }
  return keys;
}

/** Every key of each object literal that follows a match of `at` in `code`; `…name` when what follows is not a literal. */
function keysInSource(code: string, at: RegExp, keys: Set<string>): void {
  for (const match of code.matchAll(at)) {
    const open = match.index + match[0].length - 1;
    if (code[open] === "{") {
      for (const key of objectKeys(code, open)) keys.add(key);
    } else {
      const from = /^[\w$.]+(\()?/.exec(code.slice(open));
      keys.add(from ? `…${from[0]}${from[1] ? ")" : ""}` : "…");
    }
  }
}

/** What a transition sets in context: a declarative patch's keys, or each `context: { … }` in a function's source. */
function contextKeys(transition: Json | undefined, code: string | undefined): string[] {
  const keys = new Set<string>();
  if (code) keysInSource(code, /\bcontext\s*:\s*[^\s]/g, keys);
  if (transition) {
    const context = decodeExpr(transition.context);
    const contextCode = codeOf(context);
    if (contextCode) keysInSource(contextCode, /=>\s*\(\s*\{|\breturn\s*\{/g, keys);
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
 * True when a transition function's source has a path that returns no
 * transition, so it may not be taken. Matches minified source too: `void 0`
 * for `undefined`, and a ternary `?` with no spaces (but not `?.` or `??`).
 */
const mayDecline = (code: string) =>
  /\bundefined\b|\bnull\b|\bvoid 0\b|\breturn\s*;|\bif\s*\(|(?<!\?)\?(?![.?])|&&/.test(code);

/**
 * Where a transition written as a function goes: every string literal after a
 * `target:` that names a real state node, `(conditional)` when it may decline
 * or pick among several, `(stays)` when its source has no `target`, `?` when
 * it names none that resolves.
 */
function targetsInSource(source: AnyStateNode, code: string, choice: boolean): string {
  const found = new Set<AnyStateNode>();
  for (const [, expression] of code.matchAll(/\btarget\s*:\s*(\[[^\]]*\]|[^,}\n]+)/g)) {
    for (const [, , literal] of expression!.matchAll(/(['"`])([^'"`$]+)\1/g)) {
      const node = resolveTarget(source, literal!);
      if (node) found.add(node);
    }
  }
  const names = [...found].map((node) => nameOf(source, node));
  if (names.length) {
    const conditional = names.length > 1 || (!choice && mayDecline(code));
    return `${names.join(", ")}${conditional ? " (conditional)" : ""}`;
  }
  return /\btarget\s*:/.test(code) ? "?" : "(stays)";
}

/** One transition, as a line: `on GO if context.ready → review; sets draft — description`. */
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
    sets = contextKeys(transition, undefined);
  } else {
    to = "?";
    sets = [];
  }
  return `${head}${guard ? ` if ${guard}` : ""} → ${to}${sets.length ? `; sets ${sets.join(", ")}` : ""}${
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

/** Every transition leaving one state node, as lines at `pad`. */
function transitionLines(node: AnyStateNode, json: Json, delays: Json, pad: string): string[] {
  const lines: string[] = [];
  const push = (head: string, value: unknown) => {
    for (const transition of toList(value)) {
      lines.push(`${pad}${transitionLine(node, head, transition)}`);
    }
  };
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
      lines.push(`${pad}${transitionLine(node, head, branch, { guardKey: "when", choice: true })}`);
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
  const label =
    typeof interaction?.label === "string" ? ` [interaction: "${oneLine(interaction.label)}"]` : "";
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
 * each with its guard (`if …`), where it goes (`→ review`), and what it sets
 * in context (`sets draft, attempts`). An `Events` section lists the
 * machine's event schemas with their descriptions and fields.
 *
 * A transition written as a function shows the targets its source names
 * (`→ review (conditional)` when it may decline or pick among several),
 * `(stays)` when its source has no `target`, or `→ ?` when no target can be
 * read. A `setupAgent.fromConfig(...)` machine is read from its config, so
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
  const root = machine.root;

  const lines = [`Machine ${machine.id}`];
  if (root.description) lines.push(`Goal: ${root.description.trim()}`);

  const rootTransitions = transitionLines(root, json, delays, "  ");
  if (rootTransitions.length) lines.push("Any state:", ...rootTransitions);

  const initial = typeof json.initial === "string" ? ` (initial: ${json.initial})` : "";
  lines.push(`States${initial}${options.snapshot ? " (* = current)" : ""}:`);
  const walk = (node: AnyStateNode, nodeJson: Json, depth: number) => {
    const pad = "  ".repeat(depth);
    const mark = active.has(node.id) ? `${pad.slice(2)}* ` : pad;
    lines.push(`${mark}${stateLine(node, nodeJson)}`);
    lines.push(...transitionLines(node, nodeJson, delays, `${pad}    `));
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
  return lines.join("\n");
}
