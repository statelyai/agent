import type { AnyMachineSnapshot, AnyStateMachine } from "xstate";
import type {
  AgentMessage,
  AssistantMessage,
  FilePart,
  ImagePart,
  StandardSchemaV1,
  SystemMessage,
  TextPart,
  ToolCallPart,
  ToolMessage,
  ToolResultPart,
  UserMessage,
} from "./types.js";

/**
 * Walks a context value and returns the dot-paths of the first few values that
 * would NOT survive a JSON persist/resume round-trip (persist with XState's
 * `actor.getPersistedSnapshot()`, resume with `createActor(machine, { snapshot })`):
 * `Date`, `Map`, `Set`, `RegExp`, functions, `undefined`, `bigint`, class
 * instances (non-plain objects), and circular references. Plain objects,
 * arrays, and JSON primitives are walked/allowed. Returns `[]` for a
 * fully-JSON-safe value. Cheap and bounded (stops after `limit` findings) —
 * intended for a dev-only warning at the moment persistence matters.
 */
export function findNonSerializableContextPaths(context: unknown, limit = 5): string[] {
  const paths: string[] = [];
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string): void => {
    if (paths.length >= limit) {
      return;
    }
    if (value === null) {
      return;
    }
    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") {
      return;
    }
    if (type === "undefined" || type === "bigint" || type === "function" || type === "symbol") {
      paths.push(`${path} (${type})`);
      return;
    }
    // Objects. `seen` holds only the current ancestor chain: a value revisited
    // while still on the chain is a true cycle; a shared (DAG) reference is
    // not — JSON.stringify duplicates those fine — so entries are removed
    // again after their children are walked.
    const obj = value as object;
    if (seen.has(obj)) {
      paths.push(`${path} (circular)`);
      return;
    }

    if (Array.isArray(value)) {
      seen.add(obj);
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      seen.delete(obj);
      return;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      // Plain object — walk its entries.
      seen.add(obj);
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        walk(item, `${path}.${key}`);
      }
      seen.delete(obj);
      return;
    }

    // Any other object (Date, Map, Set, RegExp, class instance, …) does not
    // round-trip through JSON.
    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
    paths.push(`${path} (${ctorName})`);
  };

  walk(context, "context");
  return paths;
}

/**
 * A stable, dependency-free structural fingerprint of a machine — a short hex
 * `djb2` hash over its **structural** config only: state ids/nesting, transition
 * event types and targets, invoke `src`s, `initial`, and any other serializable
 * config fields. Function values (context/output builders, prompts, inline
 * guards/actions) are excluded entirely, so two machines that differ only in
 * their prompts or executors hash identically; adding/removing/retargeting a
 * state or transition changes the hash.
 *
 * Used by {@link runAgent} to stamp settled snapshots with a `version` and to
 * detect a structurally-edited machine on resume. It is a change detector, not
 * a cryptographic digest — collisions are possible but unlikely for real
 * configs. Declare `createMachine({ version })` to pin an explicit version instead.
 */
export function getMachineStructuralHash(machine: AnyStateMachine): string {
  return djb2Hex(stableStructuralString((machine as { config: unknown }).config));
}

/**
 * The version a machine is stamped with everywhere: an explicitly declared
 * `createMachine({ version })` when present, else its
 * {@link getMachineStructuralHash}. Single source of truth so `runAgent`,
 * `provideExecutors`/`traceTransitions` trace envelopes, and the event-log
 * helpers (`initEntry`, `createReplayEntry`, `replay`) never disagree.
 * @internal
 */
export function resolveMachineVersion(machine: AnyStateMachine): string {
  return (machine as { version?: string }).version ?? getMachineStructuralHash(machine);
}

// Deterministic structural serialization: sorted object keys, function/
// undefined/symbol values omitted, cycles collapsed. Not reversible — only used
// as hash input, so the exact string shape is irrelevant as long as it is
// stable for a given structural config.
function stableStructuralString(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null) {
    return "null";
  }
  const type = typeof value;
  if (type === "function" || type === "undefined" || type === "symbol") {
    return "";
  }
  if (type === "string") {
    return JSON.stringify(value);
  }
  if (type === "number" || type === "boolean") {
    return String(value);
  }
  if (type === "bigint") {
    return `${value as bigint}n`;
  }
  const obj = value as object;
  if (seen.has(obj)) {
    return '"[circular]"';
  }
  seen.add(obj);
  let out: string;
  if (Array.isArray(value)) {
    out = `[${value.map((item) => stableStructuralString(item, seen)).join(",")}]`;
  } else {
    const parts: string[] = [];
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      const child = (obj as Record<string, unknown>)[key];
      // Skip function/undefined/symbol values: their key must not perturb the
      // hash either, so drop the whole entry rather than emit an empty value.
      const childType = typeof child;
      if (childType === "function" || childType === "undefined" || childType === "symbol") {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${stableStructuralString(child, seen)}`);
    }
    out = `{${parts.join(",")}}`;
  }
  seen.delete(obj);
  return out;
}

/**
 * djb2 → unsigned 32-bit → 8-char hex. No dependencies. A change detector, not
 * a cryptographic digest.
 *
 * @internal
 */
export function djb2Hex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Builds a {@link UserMessage} from a string or multimodal content parts. */
export function userMessage(content: string | Array<TextPart | ImagePart | FilePart>): UserMessage {
  return { role: "user", content };
}

/** Builds an {@link AssistantMessage} from a string or content parts (text, files, tool calls/results). */
export function assistantMessage(
  content: string | Array<TextPart | FilePart | ToolCallPart | ToolResultPart>,
): AssistantMessage {
  return { role: "assistant", content };
}

/** Builds a {@link SystemMessage}. */
export function systemMessage(content: string): SystemMessage {
  return { role: "system", content };
}

/** Builds a {@link ToolMessage} from one or more tool-result parts. */
export function toolMessage(content: Array<ToolResultPart>): ToolMessage {
  return { role: "tool", content };
}

// A snapshot's meta value type, recovered from its `getMeta()` return type
// (`Record<StateId, TMeta | undefined>`). For a schema-typed machine (e.g.
// `setupAgent({ meta })`), this resolves to the meta schema's output type; for
// an untyped snapshot it falls back to `MetaObject`.
export type MetaOfSnapshot<TSnapshot extends { getMeta(): Record<string, unknown> }> = NonNullable<
  ReturnType<TSnapshot["getMeta"]>[keyof ReturnType<TSnapshot["getMeta"]>]
>;

/**
 * Returns the merged `meta` of a snapshot's active state(s) — the typed
 * replacement for the `Object.values(snapshot.getMeta())[0]` dance.
 *
 * `snapshot.getMeta()` is keyed by state id; a leaf machine has one active
 * state, but parallel/nested machines can have several. This shallow-merges
 * every active state's meta into one object and returns `{}` when no active
 * state declares meta.
 *
 * Merge order is fixed and does not depend on XState's internal node order:
 * entries are sorted by structural depth (the state node's distance from the
 * root, regardless of custom `id` strings), then by state id lexicographically,
 * and merged in that order. So a deeper state's key wins over an ancestor's,
 * and between equal-depth parallel siblings the later state id alphabetically
 * wins.
 *
 * The return type is recovered from the snapshot's own `getMeta()` type, so a
 * schema-typed machine (`setupAgent({ meta })`) yields the meta schema's
 * output type. Pass an explicit `TMeta` to override when the snapshot is
 * untyped (e.g. `AnyMachineSnapshot`).
 *
 * @example HITL: read the current state's interaction protocol off an idle
 * snapshot to render for a human.
 * ```ts
 * const { interaction } = getStateMeta(result.snapshot);
 * ```
 */
export function getStateMeta<
  TSnapshot extends { getMeta(): Record<string, unknown> } = AnyMachineSnapshot,
  TMeta = MetaOfSnapshot<TSnapshot>,
>(snapshot: TSnapshot): Partial<TMeta> {
  // Structural depth per active node id. A custom `id: 'review'` on a nested
  // state has no dots, so the id string is not a usable depth proxy.
  // TODO(xstate): use snapshot.nodes when public.
  const nodes = (snapshot as { _nodes?: Array<{ id: string; path: string[] }> })._nodes;
  const depthById = new Map(nodes?.map((node) => [node.id, node.path.length]));
  const depth = (id: string) => depthById.get(id) ?? id.split(".").length;
  const entries = Object.entries(snapshot.getMeta())
    .filter((entry): entry is [string, Record<string, unknown>] => entry[1] != null)
    .sort(([a], [b]) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));

  return Object.assign({}, ...entries.map(([, meta]) => meta));
}

/**
 * Reads the run-owned message log off a snapshot settled by a `runAgent` call
 * that used `getRequests` (or `options.messages`) — the typed replacement for
 * the `(snapshot as { messages?: AgentMessage[] }).messages` cast. runAgent
 * stamps the log as a plain enumerable `messages` property (like `agentMeta`),
 * so it survives a JSON persist/resume round-trip; this accessor works on the
 * live settled snapshot and on a JSON-parsed persisted one alike. Returns `[]`
 * when no log was stamped (e.g. a default invoke-driven run).
 *
 * The write path is `runAgent(..., { messages })`: an explicit seed that
 * overrides the resume snapshot's stamped log (fold in a user reply on
 * resume, or start a run with prior history).
 */
export function getAgentMessages(snapshot: unknown): AgentMessage[] {
  const stamped = (snapshot as { messages?: unknown } | null | undefined)?.messages;
  return Array.isArray(stamped) ? (stamped as AgentMessage[]) : [];
}

/**
 * Structural guard for a {@link StandardSchemaV1}: `true` when `value` carries
 * the `~standard` marker. Used to tell an already-schema'd tool `inputSchema`
 * (a Zod/Valibot/… schema) apart from an SDK-specific schema wrapper that core
 * can't read directly — see the `ai-sdk` tool pass-through.
 */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return typeof value === "object" && value !== null && "~standard" in value;
}

/**
 * Pulls the JSON Schema off a {@link StandardSchemaV1} via its optional
 * `~standard.jsonSchema.input()` extension (implemented by e.g. Zod v4's
 * `z.toJSONSchema`), awaiting it when the producer is async. Returns
 * `undefined` when the schema doesn't expose the extension. Use this to build
 * a provider request's `response_format`/tool `parameters` from a schema.
 */
export async function getJsonSchema(
  schema?: StandardSchemaV1,
): Promise<Record<string, unknown> | undefined> {
  const jsonSchemaFn = schema?.["~standard"].jsonSchema?.input;
  if (!jsonSchemaFn) {
    return undefined;
  }
  const result = jsonSchemaFn();
  const resolved = result instanceof Promise ? await result : result;
  return resolved as Record<string, unknown> | undefined;
}

/**
 * Synchronous variant of {@link getJsonSchema}, for call sites that can't
 * await (building tool/event descriptors inline). An async JSON Schema
 * producer is treated as absent (returns `undefined`) — in practice Zod's
 * `z.toJSONSchema` resolves synchronously.
 */
export function getJsonSchemaSync(schema?: StandardSchemaV1): Record<string, unknown> | undefined {
  const jsonSchemaFn = schema?.["~standard"].jsonSchema?.input;
  if (!jsonSchemaFn) {
    return undefined;
  }
  const result = jsonSchemaFn();
  return result instanceof Promise ? undefined : (result as Record<string, unknown> | undefined);
}

/**
 * Validates `value` against a {@link StandardSchemaV1}, synchronously.
 * Throws if the schema's `validate` returns a `Promise` (async validation is
 * not supported anywhere in this library) or if validation reports issues —
 * in which case the thrown `Error.message` joins every issue message with
 * `', '`.
 */
export function validateSchemaSync<T>(schema: StandardSchemaV1<T>, value: unknown): T {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new Error("Async schema validation is not supported.");
  }

  if (result.issues) {
    throw new Error(result.issues.map((issue: { message: string }) => issue.message).join(", "));
  }

  return result.value as T;
}
