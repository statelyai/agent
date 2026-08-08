/**
 * Auto-discovered examples library (server only).
 *
 * Vite globs over `examples/*` pick up every example folder automatically:
 * `metadata.json` for the listing, `index.ts` (lazily imported on the server)
 * for exported machines, and the raw source for the code panel. Adding a new
 * example folder makes it appear in the demo with no registration step.
 *
 * Only imported dynamically from server-fn handlers — the example modules and
 * their node-only dependencies must never reach the client bundle.
 */
import type { AnyStateMachine } from "xstate";
import { toVizConfig } from "./scenarios";
import { describeMachineInput, hasLiveExecutors } from "./machine-chat.server";
import { humanizeFieldName, type JsonObject } from "./machine-ui";

/** JSON-safe value — server fns must return serializable data. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * A one-click "Try" chip, normalized from metadata.json `starters`.
 *
 * Metadata entries may be:
 * - `"some prompt"` — plain text for single-prompt machines (`kind: "text"`)
 * - `{ maxRounds: 3 }` — the machine input verbatim (`kind: "input"`)
 * - `{ label: "Short game", input: { maxRounds: 3 } }` — labelled input
 */
export type ExampleStarter =
  | { kind: "text"; label: string; text: string }
  | { kind: "input"; label: string; input: JsonObject };

export type ExampleSummary = {
  id: string;
  title: string;
  kind: string;
  purpose: string | null;
  /** Pre-baked starters rendered as one-click chips in the chat. */
  starters: ExampleStarter[];
};

export type ExampleMachine = {
  exportName: string;
  vizConfig: Record<string, Json>;
  initial: string | null;
  /** JSON Schema of the machine's `input`, when declared via setupAgent. */
  inputJsonSchema: JsonObject | null;
  /** Single-string input field name — chat text starts the run when set. */
  promptField: string | null;
};

export type ExampleDetail = ExampleSummary & {
  source: string;
  machines: ExampleMachine[];
  /** Set when the example module could not be imported on the server. */
  importError: string | null;
  /** False when the demo server has no API key, so runs are disabled. */
  runnable: boolean;
  /**
   * True for examples the demo cannot drive: `"manual": true` in metadata
   * (CLI-only scripts, host adapters) or a module that exports no machine.
   */
  manual: boolean;
};

type ExampleMetadata = {
  name?: string;
  title?: string;
  kind?: string;
  comparison?: { purpose?: string };
  starters?: unknown;
  /** Opt out of the demo library: CLI-only scripts and host adapters. */
  manual?: boolean;
  /** Export name of the machine to list first / preselect. */
  machine?: string;
  /** Wall-clock run budget override (ms) for legitimately long examples. */
  budgetMs?: number;
};

const metadataModules = import.meta.glob("../../../examples/*/metadata.json", {
  eager: true,
  import: "default",
}) as Record<string, ExampleMetadata>;

const exampleModules = import.meta.glob("../../../examples/*/index.ts") as Record<
  string,
  () => Promise<Record<string, unknown>>
>;

const exampleSources = import.meta.glob("../../../examples/*/index.ts", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

function idFromPath(path: string): string | null {
  return path.match(/examples\/([^/]+)\//)?.[1] ?? null;
}

function byId<T>(modules: Record<string, T>): Map<string, T> {
  const map = new Map<string, T>();
  for (const [path, value] of Object.entries(modules)) {
    const id = idFromPath(path);
    if (id) map.set(id, value);
  }
  return map;
}

const metadataById = byId(metadataModules);
const moduleById = byId(exampleModules);
const sourceById = byId(exampleSources);

/** An XState machine, duck-typed — instanceof is unreliable across module graphs. */
function isMachine(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { transition?: unknown; root?: unknown; config?: unknown };
  if (typeof candidate.transition !== "function" || !candidate.root) return false;
  const config = candidate.config;
  return !!config && typeof config === "object" && ("states" in config || "initial" in config);
}

const isPlainObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** `{ maxRounds: 3, seed: "x" }` → "Max rounds 3, Seed x" (chip label fallback). */
function describeInput(input: JsonObject): string {
  const parts = Object.entries(input)
    .filter(([, value]) => value != null && typeof value !== "object")
    .map(([key, value]) => `${humanizeFieldName(key)} ${String(value)}`);
  return parts.length ? parts.join(", ") : "Run";
}

function startersOf(metadata: ExampleMetadata): ExampleStarter[] {
  if (!Array.isArray(metadata.starters)) return [];
  const out: ExampleStarter[] = [];
  for (const entry of metadata.starters) {
    if (typeof entry === "string") {
      if (entry.trim()) out.push({ kind: "text", label: entry, text: entry });
      continue;
    }
    if (!isPlainObject(entry)) continue;
    // Labelled form: { label, input }.
    if (typeof entry.label === "string" && isPlainObject(entry.input)) {
      out.push({ kind: "input", label: entry.label, input: entry.input });
      continue;
    }
    out.push({ kind: "input", label: describeInput(entry), input: entry });
  }
  return out;
}

function summaryFor(id: string): ExampleSummary {
  const metadata = metadataById.get(id) ?? {};
  return {
    id,
    title: metadata.title || id,
    kind: metadata.kind || "example",
    purpose: metadata.comparison?.purpose ?? null,
    starters: startersOf(metadata),
  };
}

export function listExampleSummaries(): ExampleSummary[] {
  // Every example folder with an index.ts is included; metadata.json refines it.
  // `"manual": true` opts an example out — CLI-only scripts and host adapters
  // have nothing the demo can run, so listing them only looks broken.
  const ids = new Set([...moduleById.keys(), ...metadataById.keys()]);
  return [...ids]
    .filter((id) => sourceById.has(id) && metadataById.get(id)?.manual !== true)
    .map(summaryFor)
    .sort((a, b) => a.title.localeCompare(b.title));
}

const detailCache = new Map<string, Promise<ExampleDetail>>();

export function getExampleDetail(id: string): Promise<ExampleDetail> {
  const cached = detailCache.get(id);
  if (cached) return cached;
  const promise = loadDetail(id);
  detailCache.set(id, promise);
  promise.catch(() => detailCache.delete(id));
  return promise;
}

async function loadDetail(id: string): Promise<ExampleDetail> {
  const loadSource = sourceById.get(id);
  if (!loadSource) throw new Error(`Unknown example: ${id}`);
  const source = await loadSource();

  const machines: ExampleMachine[] = [];
  let importError: string | null = null;
  const loadModule = moduleById.get(id);
  if (loadModule) {
    try {
      const mod = await loadModule();
      for (const [exportName, value] of Object.entries(mod)) {
        if (!isMachine(value)) continue;
        // toVizConfig strips functions, so the result is plain JSON.
        const vizConfig = toVizConfig(value as never) as Record<string, Json>;
        const inputInfo = describeMachineInput(value as AnyStateMachine);
        machines.push({
          exportName,
          vizConfig,
          initial: typeof vizConfig.initial === "string" ? vizConfig.initial : null,
          inputJsonSchema: inputInfo.jsonSchema,
          promptField: inputInfo.promptField,
        });
      }
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
    }
  }

  // metadata.json `"machine"` nominates the default: the client preselects
  // machines[0], so the nominated export sorts first.
  const preferred = metadataById.get(id)?.machine;
  if (preferred) {
    const index = machines.findIndex((machine) => machine.exportName === preferred);
    if (index > 0) machines.unshift(...machines.splice(index, 1));
  }

  return {
    ...summaryFor(id),
    source,
    machines,
    importError,
    runnable: hasLiveExecutors(),
    // No machine export means nothing to drive from chat, same as `manual`.
    manual: metadataById.get(id)?.manual === true || machines.length === 0,
  };
}

/** Per-example wall-clock budget override from metadata.json `budgetMs`. */
export function exampleBudgetMs(id: string): number | undefined {
  const raw = metadataById.get(id)?.budgetMs;
  return typeof raw === "number" && raw > 0 ? raw : undefined;
}

/** The live machine object for a run — never serialized to the client. */
export async function getExampleMachine(id: string, exportName: string): Promise<AnyStateMachine> {
  const loadModule = moduleById.get(id);
  if (!loadModule) throw new Error(`Unknown example: ${id}`);
  const mod = await loadModule();
  const value = mod[exportName];
  if (!isMachine(value)) {
    throw new Error(`Example '${id}' has no machine export named '${exportName}'.`);
  }
  return value as AnyStateMachine;
}
