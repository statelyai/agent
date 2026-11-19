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
  /**
   * `"text"` (the default) for the indented outline a model reads, or
   * `"mermaid"` for a Mermaid `stateDiagram-v2` diagram. `source` and
   * `helpers` apply to text only.
   */
  format?: "text" | "mermaid";
  /** Marks the state nodes active in this snapshot: `*` in text, the `active` class in Mermaid. */
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

/** A transition's target as said from the state it leaves, with the node it names when it names one. */
interface Target {
  name: string;
  node?: AnyStateNode;
}

/** One transition leaving a state node, as read from its definition. Both formats render from it. */
interface TransitionInfo {
  /** The text line's head: `on GO`, `always`, `after 1s`, `  done`, `choice else`. */
  head: string;
  /** The diagram edge's label: `GO`, `always`, `after 1s`, `payout done`, `else`, or none. */
  label: string;
  /** A `choice` branch: its alternatives are the choice node's, so it carries no `?`. */
  choice: boolean;
  transition: unknown;
  /** Each target it names, in order; a function's are unique by node (by name when it names none). */
  targets: Target[];
  /** Some path goes to a target its source does not spell out (`?`). */
  unknown: boolean;
  /** A function that may decline, stay, or pick among several targets. */
  conditional: boolean;
  guard?: string;
  description?: string;
  human: boolean;
  sets: string[];
}

/** What leaves a state node, in order: transitions, and a header line before each invoke's. */
type TransitionEntry = TransitionInfo | { invoke: string };

const targetOf = (source: AnyStateNode, target: string): Target => {
  const node = resolveTarget(source, target);
  return node ? { name: nameOf(source, node), node } : { name: `${target} ?` };
};

/**
 * Reads one transition. A function's targets come from its return paths: each
 * literal target (`x ?` when it names no state node), `unknown` for one the
 * source does not spell out (a variable's value, a helper call's result), and
 * `conditional` when it may decline, stay, or pick among several.
 */
function readTransition(
  source: AnyStateNode,
  head: string,
  label: string,
  transition: unknown,
  options: { guardKey?: "guard" | "when"; choice?: boolean } = {},
): TransitionInfo {
  const choice = options.choice ?? false;
  const info: TransitionInfo = {
    head,
    label,
    choice,
    transition,
    targets: [],
    unknown: false,
    conditional: false,
    human: false,
    sets: [],
  };
  const code = codeOf(transition);
  if (typeof transition === "string") {
    info.targets = [targetOf(source, transition)];
  } else if (code !== undefined) {
    const read = readTransitionSource(code);
    if (!read) {
      info.unknown = true;
    } else {
      const unique = new Map<AnyStateNode | string, Target>();
      for (const target of read.targets.map((t) => targetOf(source, t))) {
        const key = target.node ?? target.name;
        if (!unique.has(key)) unique.set(key, target);
      }
      info.targets = [...unique.values()];
      info.unknown = read.unknown;
      const count = info.targets.length + (read.unknown ? 1 : 0);
      info.conditional = count > 1 || (!choice && (read.declines || read.stays));
    }
    info.sets = contextKeys(undefined, code);
  } else if (isObject(transition) && !("@expr" in transition)) {
    info.targets = toList(transition.target)
      .filter((t): t is string => typeof t === "string")
      .map((target) => targetOf(source, target));
    info.guard = guardText(transition[options.guardKey ?? "guard"]);
    info.description =
      typeof transition.description === "string" ? transition.description : undefined;
    info.human = isObject(transition.meta) && transition.meta.actor === "human";
    info.sets = contextKeys(transition, undefined);
  } else {
    info.unknown = true;
  }
  return info;
}

/** Where a transition goes, as said in the text: `review`, `review, paying (conditional)`, `?`, `(stays)`. */
function targetText(info: TransitionInfo): string {
  // Two nodes can share a name (`b` and `#m.b` from inside `group`); the text says it once.
  const parts = [...new Set(info.targets.map((target) => target.name))];
  if (info.unknown) parts.push("?");
  if (!parts.length) return "(stays)";
  if (parts.length === 1 && info.unknown) return "?";
  return `${parts.join(", ")}${info.conditional ? " (conditional)" : ""}`;
}

/** One transition, as a line: `on GO (human) if context.ready → review; sets draft - description`. */
function transitionLine(info: TransitionInfo): string {
  const { head, human, guard, sets, description } = info;
  return `${head}${human ? " (human)" : ""}${guard ? ` if ${guard}` : ""} → ${targetText(info)}${sets.length ? `; sets ${sets.join(", ")}` : ""}${
    description ? ` - ${oneLine(description)}` : ""
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

/** Every transition leaving one state node, in order: `on`, `onDone`, `always`, `after`, invokes, `choice`. */
function readTransitions(node: AnyStateNode, json: Json, delays: Json): TransitionEntry[] {
  const entries: TransitionEntry[] = [];
  const push = (head: string, label: string, value: unknown) => {
    for (const transition of toList(value)) {
      entries.push(readTransition(node, head, label, transition));
    }
  };
  for (const [event, value] of Object.entries(isObject(json.on) ? json.on : {})) {
    // fromConfig lowers a state-level `onDone` to its own done event.
    if (event === "xstate.done.state") push("onDone", "onDone", value);
    else push(`on ${event}`, event, value);
  }
  push("onDone", "onDone", json.onDone);
  push("always", "always", json.always);
  for (const [key, value] of Object.entries(isObject(json.after) ? json.after : {})) {
    const after = `after ${delayText(key, delays)}`;
    push(after, after, value);
  }
  for (const invoke of toList(json.invoke)) {
    if (!isObject(invoke)) continue;
    const src = typeof invoke.src === "string" ? invoke.src : "(inline)";
    const id = typeof invoke.id === "string" && invoke.id !== src ? ` (${invoke.id})` : "";
    const name = typeof invoke.id === "string" ? invoke.id : src;
    entries.push({ invoke: `invoke ${src}${id}` });
    push("  done", `${name} done`, invoke.onDone);
    push("  error", `${name} error`, invoke.onError);
  }
  if (json.choice !== undefined) {
    const branches = toList(json.choice);
    branches.forEach((branch, index) => {
      const guarded = isObject(branch) && branch.when !== undefined;
      const head = guarded || index === 0 ? "choice" : "choice else";
      entries.push(
        readTransition(node, head, head === "choice" ? "" : "else", branch, {
          guardKey: "when",
          choice: true,
        }),
      );
    });
  }
  return entries;
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
  if (source) {
    for (const key of ["entry", "exit"] as const) {
      for (const action of toList(json[key])) {
        const code = sourceLines(action, pad);
        if (code.length) lines.push(`${pad}${key}`, ...code);
      }
    }
  }
  for (const entry of readTransitions(node, json, delays)) {
    if ("invoke" in entry) {
      lines.push(`${pad}${entry.invoke}`);
      continue;
    }
    lines.push(`${pad}${transitionLine(entry)}`);
    if (source) lines.push(...sourceLines(entry.transition, pad));
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
  const description = node.description ? ` - ${oneLine(node.description)}` : "";
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
    lines.push(`  ${type}${description ? ` - ${oneLine(description)}` : ""}`);
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
        typeof property.description === "string" ? ` - ${oneLine(property.description)}` : "";
      lines.push(
        `    ${field}${required.has(field) ? "" : "?"}${fieldType ? `: ${fieldType}` : ""}${fieldDescription}`,
      );
    }
  }
  return lines;
}

/** Words Mermaid's state diagram grammar reserves or its lexer reads as keywords, so never used as a bare id. */
const MERMAID_RESERVED = new Set([
  "as",
  "class",
  "classdef",
  "click",
  "default",
  "direction",
  "end",
  "hide",
  "href",
  "note",
  "scale",
  "state",
  "statediagram",
  "style",
]);

const MERMAID_ENTITIES: Record<string, string> = {
  "#": "#35;",
  ":": "#58;",
  ";": "#59;",
  '"': "#quot;",
  "<": "#lt;",
  ">": "#gt;",
};

/** Text Mermaid reads as written: one line, with the characters its grammar uses as entity codes. */
const mermaidText = (text: string) =>
  oneLine(text).replace(/[#:;"<>]/g, (char) => MERMAID_ENTITIES[char]!);

/** An edge's label: the event, `?` when a function may go elsewhere or nowhere, and the guard. */
function edgeLabel(info: TransitionInfo): string {
  const label = `${info.label}${info.conditional && !info.choice ? "?" : ""}`;
  return info.guard ? `${label}${label ? " " : ""}[${info.guard}]` : label;
}

/** Whether `ancestor` contains `node` (and is not `node`). */
const contains = (ancestor: AnyStateNode, node: AnyStateNode) =>
  node.path.length > ancestor.path.length &&
  ancestor.path.every((key, index) => node.path[index] === key);

/** The nearest node whose diagram block can hold an edge: never inside a parallel node, where `--` separates regions. */
function blockOf(node: AnyStateNode | undefined): AnyStateNode | undefined {
  while (node && node.type === "parallel") node = node.parent;
  return node;
}

/** The machine as a Mermaid `stateDiagram-v2`; see {@link describeMachine}. */
function describeMermaid(machine: AnyStateMachine, options: DescribeMachineOptions): string {
  const json = machineToJSON(machine) as Json;
  const delays = isObject(json.delays) ? json.delays : {};
  const root = machine.root;

  // Every state node with its JSON, depth-first.
  const nodes: Array<[AnyStateNode, Json]> = [];
  const collect = (node: AnyStateNode, nodeJson: Json) => {
    nodes.push([node, nodeJson]);
    const childJson = isObject(nodeJson.states) ? nodeJson.states : {};
    for (const [key, child] of Object.entries(node.states)) {
      collect(child, isObject(childJson[key]) ? childJson[key] : {});
    }
  };
  collect(root, json);

  const transitionsOf = new Map(
    nodes.map(([node, nodeJson]) => [
      node,
      readTransitions(node, nodeJson, delays).filter(
        (entry): entry is TransitionInfo => !("invoke" in entry),
      ),
    ]),
  );

  // Ids: a state's key when no other state shares it, else its path; then made safe and unique.
  // Mermaid names the top-level `[*]` markers `root_start` and `root_end`.
  const used = new Set<string>(["root_start", "root_end"]);
  const allocate = (candidate: string) => {
    let id = candidate.replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z_]/.test(id) || MERMAID_RESERVED.has(id.toLowerCase())) id = `s_${id}`;
    let unique = id;
    for (let n = 2; used.has(unique); n++) unique = `${id}_${n}`;
    used.add(unique);
    return unique;
  };
  const keyCounts = new Map<string, number>();
  for (const [node] of nodes.slice(1)) keyCounts.set(node.key, (keyCounts.get(node.key) ?? 0) + 1);
  const ids = new Map<AnyStateNode, string>();
  const assign = (node: AnyStateNode, candidate: string) => {
    const id = allocate(candidate);
    ids.set(node, id);
    if (!Object.keys(node.states).length) return;
    // Mermaid names a block's `[*]` markers `<id>_start` and `<id>_end`; a state holding one moves.
    for (const marker of [`${id}_start`, `${id}_end`]) {
      const holder = [...ids].find(([, held]) => held === marker)?.[0];
      // Assigned again, so a composite holder reserves its own new markers.
      if (holder) assign(holder, marker);
      else used.add(marker);
    }
  };
  // The machine is a composite state when it is parallel or a transition targets it.
  const rootTargeted = [...transitionsOf.values()].some((list) =>
    list.some((info) => info.targets.some((target) => target.node === root)),
  );
  if (root.type === "parallel" || rootTargeted) assign(root, machine.id);
  for (const [node] of nodes.slice(1)) {
    assign(node, keyCounts.get(node.key) === 1 ? node.key : node.path.join("_"));
  }

  // Edges, each in the block of the nearest node that holds both ends.
  const edges = new Map<AnyStateNode | undefined, string[]>();
  const addEdge = (block: AnyStateNode | undefined, ...lines: string[]) => {
    const key = blockOf(block);
    edges.set(key, [...(edges.get(key) ?? []), ...lines]);
  };
  const unknownIds: string[] = [];
  for (const [node, transitions] of transitionsOf) {
    if (!transitions.length) continue;
    let from = ids.get(node);
    if (from === undefined) {
      // Transitions on the machine itself leave any state.
      from = allocate("any_state");
      addEdge(root, `state "any state" as ${from}`);
    }
    for (const info of transitions) {
      const label = edgeLabel(info);
      const suffix = label ? ` : ${mermaidText(label)}` : "";
      for (const target of info.targets) {
        if (target.node && ids.has(target.node)) {
          let block = node === root ? root : node.parent;
          while (block && !contains(block, target.node)) block = block.parent;
          addEdge(block, `${from} --> ${ids.get(target.node)}${suffix}`);
        } else {
          const id = allocate(`${from}_unknown`);
          unknownIds.push(id);
          addEdge(
            node === root ? root : node.parent,
            `state "${mermaidText(target.name)}" as ${id}`,
            `${from} --> ${id}${suffix}`,
          );
        }
      }
      if (info.unknown) {
        const id = allocate(`${from}_unknown`);
        unknownIds.push(id);
        addEdge(
          node === root ? root : node.parent,
          `state "?" as ${id}`,
          `${from} --> ${id}${suffix}`,
        );
      }
    }
  }

  /** The lines inside a node's block: initial, children, finals, then the edges it holds. */
  const inner = (node: AnyStateNode, nodeJson: Json, pad: string): string[] => {
    const lines: string[] = [];
    const initial =
      typeof nodeJson.initial === "string" ? node.states[nodeJson.initial] : undefined;
    if (node.type === "compound" && initial) lines.push(`${pad}[*] --> ${ids.get(initial)}`);
    const childJson = isObject(nodeJson.states) ? nodeJson.states : {};
    Object.entries(node.states).forEach(([key, child], index) => {
      if (node.type === "parallel" && index > 0) lines.push(`${pad}--`);
      lines.push(...declare(child, isObject(childJson[key]) ? childJson[key] : {}, pad));
    });
    for (const child of Object.values(node.states)) {
      if (child.type === "final") lines.push(`${pad}${ids.get(child)} --> [*]`);
    }
    for (const line of edges.get(node) ?? []) lines.push(`${pad}${line}`);
    return lines;
  };
  const historyIds: string[] = [];
  /**
   * A state node's declaration: its label when its id differs from its key, then its block.
   * A history node is labeled `H` (shallow) or `H*` (deep). A choice node has no label, so a
   * note keeps its key when its id differs.
   */
  const declare = (node: AnyStateNode, nodeJson: Json, pad: string): string[] => {
    const id = ids.get(node)!;
    if (node.type === "history") {
      historyIds.push(id);
      return [`${pad}state "${nodeJson.history === "deep" ? "H*" : "H"}" as ${id}`];
    }
    if (node.type === "choice") {
      const lines = [`${pad}state ${id} <<choice>>`];
      if (id !== node.key) lines.push(`${pad}note right of ${id} : ${mermaidText(node.key)}`);
      return lines;
    }
    const lines: string[] = [];
    const labelled = id !== node.key;
    if (labelled) lines.push(`${pad}state "${mermaidText(node.key)}" as ${id}`);
    if (Object.keys(node.states).length) {
      lines.push(`${pad}state ${id} {`, ...inner(node, nodeJson, `${pad}  `), `${pad}}`);
    } else if (!labelled) {
      lines.push(`${pad}${id}`);
    }
    return lines;
  };

  const lines = ["stateDiagram-v2"];
  if (ids.has(root)) {
    lines.push(...declare(root, json, "  "));
    for (const line of edges.get(undefined) ?? []) lines.push(`  ${line}`);
  } else {
    lines.push(...inner(root, json, "  "));
  }
  if (unknownIds.length) {
    lines.push("  classDef unknown stroke-dasharray:5", `  class ${unknownIds.join(",")} unknown`);
  }
  if (historyIds.length) {
    lines.push("  classDef history font-style:italic", `  class ${historyIds.join(",")} history`);
  }
  const active = new Set(options.snapshot?.nodes.map((node) => node.id) ?? []);
  const activeIds = nodes.flatMap(([node]) =>
    node !== root && active.has(node.id) ? [ids.get(node)!] : [],
  );
  if (activeIds.length) {
    lines.push(
      "  classDef active font-weight:bold,stroke-width:3px",
      `  class ${activeIds.join(",")} active`,
    );
  }
  return lines.join("\n");
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
 * With `format: "mermaid"`, the same states and transitions render as a
 * Mermaid `stateDiagram-v2` diagram: one edge per target, labeled with the
 * event (`always`, `after 5s`, `payout done`, `[guard]`), `?` after the label
 * of a function that may go elsewhere or nowhere, and a dashed `?` node for a
 * target its source does not spell out.
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
  if (options.format === "mermaid") return describeMermaid(machine, options);
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
