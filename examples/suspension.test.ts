/**
 * Registry-level guard: every demo-runnable example machine that waits on a
 * human must declare *how* it suspends.
 *
 * A state with `meta.interaction` is this repo's marker for "a person answers
 * here" — the demo renders it as a prompt. When such a state rests, `runAgent`
 * has to decide the run is idle; without a declared predicate it falls back to
 * a timing heuristic and logs a warning. The fix is one line on `setupAgent`:
 *
 *     isSuspended: (snapshot) => snapshot.hasTag("awaiting-approval")
 *
 * plus the matching `tags: [...]` on the waiting state. This test fails when a
 * new example forgets it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AnyStateMachine, StateNode } from "xstate";
import { getMachineSuspensionPredicate } from "../src/internal/registry.js";

const examplesDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Machines that legitimately cannot carry a predicate today. Keep each entry
 * justified — this is an escape hatch, not a backlog.
 */
const EXCLUDED: Record<string, string> = {
  // Its waiting states are already tagged `waiting`, but declaring the
  // predicate makes the settle path drop the invoked player actor's
  // accumulated context (library bug, see the NOTE in the example). Re-enable
  // `(s) => s.hasTag("waiting")` there once that is fixed.
  "game-loop-agent#gameMachine": "library bug: isSuspended settle path loses child state",
};

/** An XState machine, duck-typed — instanceof is unreliable across module graphs. */
function isMachine(value: unknown): value is AnyStateMachine {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { transition?: unknown; root?: unknown; config?: unknown };
  if (typeof candidate.transition !== "function" || !candidate.root) return false;
  const config = candidate.config;
  return !!config && typeof config === "object" && ("states" in config || "initial" in config);
}

/**
 * States that rest waiting for a person: `meta.interaction` (the human prompt)
 * plus event handlers and nothing of its own left to do — no invoke, no
 * `after`, no `always`.
 */
function humanWaitStates(machine: AnyStateMachine): string[] {
  const found: string[] = [];
  const walk = (node: StateNode<any, any>) => {
    const config = node.config as { after?: object; always?: unknown };
    const waits =
      node.type !== "final" &&
      Object.keys(node.on ?? {}).length > 0 &&
      (node.invoke ?? []).length === 0 &&
      !config?.always &&
      !(config?.after && Object.keys(config.after).length > 0);
    if (waits && (node.meta as { interaction?: unknown } | undefined)?.interaction) {
      found.push(node.id);
    }
    for (const child of Object.values(node.states ?? {})) walk(child as StateNode<any, any>);
  };
  walk(machine.root);
  return found;
}

/** The demo lists every `examples/*` folder with an `index.ts`, minus `"manual": true`. */
function runnableExampleIds(): string[] {
  return readdirSync(examplesDir)
    .filter((id) => existsSync(path.join(examplesDir, id, "index.ts")))
    .filter((id) => {
      const metadataPath = path.join(examplesDir, id, "metadata.json");
      if (!existsSync(metadataPath)) return true;
      return JSON.parse(readFileSync(metadataPath, "utf-8")).manual !== true;
    })
    .sort();
}

describe("example suspension predicates", () => {
  it("declares deterministic suspension for every human-waiting machine", async () => {
    const undeclared: string[] = [];
    const declared: string[] = [];

    for (const id of runnableExampleIds()) {
      const module = (await import(path.join(examplesDir, id, "index.ts"))) as Record<
        string,
        unknown
      >;
      for (const [exportName, value] of Object.entries(module)) {
        if (!isMachine(value)) continue;
        const key = `${id}#${exportName}`;
        if (!humanWaitStates(value).length || key in EXCLUDED) continue;
        (getMachineSuspensionPredicate(value) ? declared : undeclared).push(key);
      }
    }

    // A miss here means `runAgent` guesses with a timing heuristic (and warns).
    // Fix the example, don't extend EXCLUDED, unless a library gap blocks it.
    expect(undeclared).toEqual([]);
    expect(declared.length).toBeGreaterThan(15);
  }, 60_000);

  it("keeps the excluded machines honest", async () => {
    for (const key of Object.keys(EXCLUDED)) {
      const [id, exportName] = key.split("#") as [string, string];
      const module = (await import(path.join(examplesDir, id, "index.ts"))) as Record<
        string,
        unknown
      >;
      const machine = module[exportName];
      expect(isMachine(machine), `${key} no longer exists`).toBe(true);
      // Still a human-waiting machine, still undeclared — drop the exclusion
      // once either stops being true.
      expect(humanWaitStates(machine as AnyStateMachine).length).toBeGreaterThan(0);
      expect(getMachineSuspensionPredicate(machine as AnyStateMachine)).toBeUndefined();
    }
  }, 60_000);
});
