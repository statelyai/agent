import { expect, test } from "vitest";
import { scenarioVizConfig, scenarioSource, toVizConfig } from "./scenarios";
import { refundMachine } from "@/agents/refund";
import { getTargetOrigin, isTrustedVizMessage } from "./viz-transport";
import { machineForInspection } from "./inspection.server";

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

test("inspection sends the primary machine as raw source", () => {
  expect(machineForInspection({ logic: refundMachine }, refundMachine, scenarioSource.refund)).toBe(
    scenarioSource.refund,
  );
});

test("viz message trust check matches source frame and origin", () => {
  const frame = {} as Window;
  const origin = getTargetOrigin("https://editor.stately.ai/embed?auth=message");
  expect(isTrustedVizMessage({ origin, source: frame }, frame, origin)).toBe(true);
  expect(isTrustedVizMessage({ origin: "https://evil.test", source: frame }, frame, origin)).toBe(
    false,
  );
});
