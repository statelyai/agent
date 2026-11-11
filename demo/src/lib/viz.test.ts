import { expect, test } from "vitest";
import {
  getScenarioMachine,
  scenarioDiagramHints,
  scenarioVizConfig,
  scenarioSource,
  toOutlineConfig,
  toVizConfig,
  type ScenarioId,
} from "./scenarios";
import { refundMachine } from "@/agents/refund";
import { machineForInspection } from "./inspection.server";
import { plainWriterMachine } from "../../../examples/plain-xstate";

test("viz config is plain JSON with static transition targets, no functions", () => {
  const config = toVizConfig(refundMachine);
  const json = JSON.stringify(config);
  expect(json).not.toContain("[fn]");
  // Object-form event transition keeps its static target (draws the edge).
  const deciding = (config.states as Record<string, { on?: Record<string, { target: string }> }>)
    .deciding;
  expect(deciding.on?.AUTO_REFUND.target).toBe("checkingLimit");
  // Idle state carries its human-wait meta through to the embed.
  const awaiting = (config.states as Record<string, { meta?: unknown }>).awaitingApproval;
  expect(awaiting.meta).toBeTruthy();
  // Round-trips through structuredClone (what postMessage requires).
  expect(() => structuredClone(config)).not.toThrow();
});

test("every scenario has a serializable viz config and raw source", () => {
  for (const [id, config] of Object.entries(scenarioVizConfig)) {
    expect(() => JSON.stringify(config)).not.toThrow();
    expect(config.states).toBeTruthy();
    expect(scenarioSource[id as keyof typeof scenarioSource]).toContain("setupAgent");
  }
});

test("example outline exposes runtime decisions and immediate transitions", () => {
  const states = toOutlineConfig(plainWriterMachine).states as Record<
    string,
    Record<string, unknown>
  >;
  expect((states.drafting.invoke as { onDone: unknown }).onDone).toEqual({ dynamic: true });
  expect((states.judging.on as Record<string, unknown>).REVISE).toEqual({ dynamic: true });
  expect(states.retrying.always).toEqual({ target: "drafting" });
});

test("the fallback outline includes every dynamic transition and valid targets", () => {
  for (const id of Object.keys(scenarioVizConfig) as ScenarioId[]) {
    const config = getScenarioMachine(id).config as {
      states: Record<string, Record<string, unknown>>;
    };
    const hints = scenarioDiagramHints[id];
    const walk = (states: Record<string, Record<string, unknown>>, parent = "") => {
      for (const [name, state] of Object.entries(states)) {
        const path = parent ? `${parent}.${name}` : name;
        const rows = hints[path] ?? [];
        const requireHint = (event: string, value: unknown) => {
          if (typeof value === "function") {
            expect(
              rows.some((row) => row.event.startsWith(event) && row.targets.length > 0),
              `${id}.${path}: ${event}`,
            ).toBe(true);
          }
        };
        if (typeof state.choice === "function") {
          expect(rows.length, `${id}.${path}: choice`).toBeGreaterThan(0);
        }
        const on = state.on as Record<string, unknown> | undefined;
        for (const [event, transition] of Object.entries(on ?? {})) requireHint(event, transition);
        const invokes = Array.isArray(state.invoke)
          ? state.invoke
          : state.invoke
            ? [state.invoke]
            : [];
        for (const invoke of invokes as Array<{
          src?: string;
          onDone?: unknown;
          onError?: unknown;
        }>) {
          requireHint(`${invoke.src ?? "actor"} ✓`, invoke.onDone);
          requireHint(`${invoke.src ?? "actor"} ✗`, invoke.onError);
        }
        for (const row of rows) {
          for (const target of row.targets) {
            expect(target in states, `${id}.${path}: ${row.event} → ${target}`).toBe(true);
          }
        }
        if (state.states) walk(state.states as Record<string, Record<string, unknown>>, path);
      }
    };
    walk(config.states);
  }
});

test("inspection sends the primary machine as raw source", () => {
  expect(machineForInspection({ logic: refundMachine }, refundMachine, scenarioSource.refund)).toBe(
    scenarioSource.refund,
  );
});
