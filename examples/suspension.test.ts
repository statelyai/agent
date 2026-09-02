/**
 * Registry-level guard for example idle semantics.
 *
 * Human waits are ordinary resting XState states with accepted events and
 * interaction metadata. They should use `isAgentIdle` by default. Exactly one
 * example carries an explicit predicate to demonstrate additive composition.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AnyStateMachine, StateNode } from "xstate";
import { getMachineIdlePredicate } from "../src/internal/registry.js";

const examplesDir = fileURLToPath(new URL(".", import.meta.url));

function isMachine(value: unknown): value is AnyStateMachine {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { transition?: unknown; root?: unknown; config?: unknown };
  if (typeof candidate.transition !== "function" || !candidate.root) return false;
  const config = candidate.config;
  return !!config && typeof config === "object" && ("states" in config || "initial" in config);
}

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
  it("uses structural idle by default and keeps one composition example", async () => {
    const humanWaits: string[] = [];
    const customPredicates: string[] = [];

    for (const id of runnableExampleIds()) {
      const module = (await import(path.join(examplesDir, id, "index.ts"))) as Record<
        string,
        unknown
      >;
      for (const [exportName, value] of Object.entries(module)) {
        if (!isMachine(value) || !humanWaitStates(value).length) continue;
        const key = `${id}#${exportName}`;
        humanWaits.push(key);
        if (getMachineIdlePredicate(value)) customPredicates.push(key);
      }
    }

    expect(humanWaits.length).toBeGreaterThan(15);
    expect(customPredicates).toEqual(["human-in-the-loop#humanInTheLoopMachine"]);
  }, 60_000);
});
