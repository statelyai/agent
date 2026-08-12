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
import ts from "typescript";
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
  /** Raw XState source so Viz can preserve v6 function transitions. */
  vizConfig: string;
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
  /**
   * State tag that marks human-wait states, for plain XState machines that
   * can't carry a setupAgent isIdle predicate. The demo passes
   * `runAgent(machine, { isIdle: (s) => s.hasTag(tag) })` so idle
   * settles deterministically instead of via the timing heuristic.
   */
  suspendedTag?: string;
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

const exampleSiblingSources = import.meta.glob(
  [
    "../../../examples/*/*.ts",
    "!../../../examples/*/*.test.ts",
    "!../../../examples/*/type-probes.ts",
  ],
  { query: "?raw", import: "default" },
) as Record<string, () => Promise<string>>;

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

const siblingSourcesById = new Map<string, Array<() => Promise<string>>>();
for (const [path, loadSource] of Object.entries(exampleSiblingSources)) {
  const id = idFromPath(path);
  if (!id) continue;
  const sources = siblingSourcesById.get(id) ?? [];
  sources.push(loadSource);
  siblingSourcesById.set(id, sources);
}

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

function machineInitializer(source: string, exportName: string): string | null {
  const file = ts.createSourceFile("example.ts", source, ts.ScriptTarget.Latest, true);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === exportName &&
      node.initializer
    ) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return initializer?.getText(file) ?? null;
}

function sourceForMachine(source: string, exportName: string, machineCount: number): string {
  if (machineCount === 1) return source;
  const initializer = machineInitializer(source, exportName);

  return initializer ? `const __statelyVizMachine = ${initializer};\n${source}` : source;
}

async function findMachineSource(id: string, exportName: string, indexSource: string) {
  if (machineInitializer(indexSource, exportName)) return indexSource;

  for (const loadSource of siblingSourcesById.get(id) ?? []) {
    const source = await loadSource();
    if (source !== indexSource && machineInitializer(source, exportName)) return source;
  }
  return indexSource;
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
  const source = await getExampleSource(id);

  const machines: ExampleMachine[] = [];
  let importError: string | null = null;
  const loadModule = moduleById.get(id);
  if (loadModule) {
    try {
      const mod = await loadModule();
      const exportedMachines = Object.entries(mod).filter((entry) => isMachine(entry[1]));
      for (const [exportName, value] of exportedMachines) {
        const machineSource = await findMachineSource(id, exportName, source);
        const config = (value as { config: { initial?: unknown } }).config;
        const inputInfo = describeMachineInput(value as AnyStateMachine);
        machines.push({
          exportName,
          vizConfig: sourceForMachine(machineSource, exportName, exportedMachines.length),
          initial: typeof config.initial === "string" ? config.initial : null,
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

/** Raw module source used by both the static embed and live inspection. */
export async function getExampleSource(id: string): Promise<string> {
  const loadSource = sourceById.get(id);
  if (!loadSource) throw new Error(`Unknown example: ${id}`);
  return loadSource();
}

/** Source containing the selected machine, prioritized for Viz conversion. */
export async function getExampleMachineSource(id: string, exportName: string): Promise<string> {
  const indexSource = await getExampleSource(id);
  const loadModule = moduleById.get(id);
  if (!loadModule) throw new Error(`Unknown example: ${id}`);
  const mod = await loadModule();
  const machineCount = Object.values(mod).filter(isMachine).length;
  return sourceForMachine(
    await findMachineSource(id, exportName, indexSource),
    exportName,
    machineCount,
  );
}

/** Per-example wall-clock budget override from metadata.json `budgetMs`. */
export function exampleBudgetMs(id: string): number | undefined {
  const raw = metadataById.get(id)?.budgetMs;
  return typeof raw === "number" && raw > 0 ? raw : undefined;
}

/** Suspension tag override from metadata.json `suspendedTag`. */
export function exampleSuspendedTag(id: string): string | undefined {
  const raw = metadataById.get(id)?.suspendedTag;
  return typeof raw === "string" && raw ? raw : undefined;
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
