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
import type { JsonObject } from "./machine-ui";

/** JSON-safe value — server fns must return serializable data. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type ExampleSummary = {
  id: string;
  title: string;
  kind: string;
  purpose: string | null;
  /**
   * Pre-baked inputs from metadata.json `starters`: strings for single-prompt
   * machines, input-shaped objects for structured machines. Rendered as
   * one-click "Try" chips in the chat.
   */
  starters: Array<string | JsonObject>;
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
};

type ExampleMetadata = {
  name?: string;
  title?: string;
  kind?: string;
  comparison?: { purpose?: string };
  starters?: unknown;
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

function startersOf(metadata: ExampleMetadata): Array<string | JsonObject> {
  if (!Array.isArray(metadata.starters)) return [];
  return metadata.starters.filter(
    (entry): entry is string | JsonObject =>
      (typeof entry === "string" && entry.trim().length > 0) ||
      (!!entry && typeof entry === "object" && !Array.isArray(entry)),
  );
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
  const ids = new Set([...moduleById.keys(), ...metadataById.keys()]);
  return [...ids]
    .filter((id) => sourceById.has(id))
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

  return { ...summaryFor(id), source, machines, importError, runnable: hasLiveExecutors() };
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
