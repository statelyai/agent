/**
 * The demo host owns its runs' `after` timers: a run waiting on a deadline
 * settles idle at once with the timers it armed, and the browser fires each
 * one back as `{ type: "xstate.timer", id }` unless the person acts first.
 * Driven through the demo's real server path on `examples/deadline-escalation`
 * with the provider layer replaced by the test doubles.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Snapshot } from "xstate";
import { getExampleMachine, listExampleSummaries } from "./example-library.server";
import { resumeMachineChat, startMachineChat, type MachineChatResult } from "./machine-chat.server";
import { resetGenericModels } from "./test-generic-models";

vi.mock("@ai-sdk/openai", async () => {
  const { genericLanguageModel } = await import("./test-generic-models");
  const openai = Object.assign((modelId: string) => genericLanguageModel(modelId), {
    chat: (modelId: string) => genericLanguageModel(modelId),
    responses: (modelId: string) => genericLanguageModel(modelId),
  });
  return { openai, createOpenAI: () => openai };
});

const control = vi.hoisted(() => ({ judgeFails: false }));

vi.mock("@ai-sdk/typesafe-ai", async () => {
  const { genericDecisionModel } = await import("./test-generic-models");
  const provider = {
    decisionModel: () => {
      const model = genericDecisionModel();
      return {
        ...model,
        doDecide: async (options: Parameters<typeof model.doDecide>[0]) => {
          if (control.judgeFails) throw new Error("judge unavailable");
          return model.doDecide(options);
        },
      };
    },
  };
  return { typeSafeAi: provider, createTypeSafeAi: () => provider };
});

beforeAll(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
  vi.stubEnv("TYPESAFE_AI_API_KEY", "test-typesafe-key");
  vi.stubEnv("OPENAI_MODEL", "");
});
afterAll(() => {
  vi.unstubAllEnvs();
});
beforeEach(() => {
  resetGenericModels();
  control.judgeFails = false;
});

const machine = () => getExampleMachine("deadline-escalation", "deadlineEscalationMachine");
const input = { requestId: "proposal-1", task: "Schedule maintenance", windowMs: 30_000 };

async function waiting(): Promise<MachineChatResult> {
  const started = await startMachineChat(await machine(), input);
  expect(started.status).toBe("idle");
  return started;
}

const resume = async (from: MachineChatResult, event: { type: string; [key: string]: unknown }) =>
  resumeMachineChat(
    await machine(),
    JSON.parse(JSON.stringify(from.idle!.snapshot)) as Snapshot<unknown>,
    event,
  );

describe("host-owned timers", () => {
  test("the deadline example is demo-playable", () => {
    expect(listExampleSummaries().map((entry) => entry.id)).toContain("deadline-escalation");
  });

  test("a deadline wait settles at once and reports the pending timer", async () => {
    const started = await waiting();
    expect(started.idle?.timers).toEqual([{ id: expect.any(String), delay: 30_000 }]);
    // The approval id is fixed by the interaction, so APPROVE is a plain button.
    expect(started.idle?.events).toEqual([
      expect.objectContaining({ type: "APPROVE", label: "Approve proposal", needsPayload: false }),
    ]);
  });

  test("a bare APPROVE before the deadline approves (the fixed id rides along)", async () => {
    const approved = await resume(await waiting(), { type: "APPROVE" });
    expect(approved.status).toBe("done");
    expect(approved.output).toMatchObject({ outcome: "approved" });
  });

  test("the timer firing escalates", async () => {
    const started = await waiting();
    const [timer] = started.idle!.timers!;
    const expired = await resume(started, { type: "xstate.timer", id: timer!.id });
    expect(expired.status).toBe("done");
    expect(expired.output).toMatchObject({ outcome: "escalated" });
  });

  test("an unknown timer id is ignored and the deadline is still reported", async () => {
    const result = await resume(await waiting(), { type: "xstate.timer", id: "no-such-timer" });
    expect(result.status).toBe("idle");
    expect(result.response).toContain("isn't an accepted event");
    // Re-armed for what is left of the window, not the whole window again.
    expect(result.idle?.timers).toEqual([{ id: expect.any(String), delay: expect.any(Number) }]);
    expect(result.idle!.timers![0]!.delay).toBeLessThanOrEqual(30_000);
    expect(result.idle!.timers![0]!.delay).toBeGreaterThan(29_000);
  });

  test("text that delivers nothing keeps the deadline pending", async () => {
    const started = await waiting();
    control.judgeFails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const echoed = await resumeMachineChat(
        await machine(),
        started.idle!.snapshot as unknown as Snapshot<unknown>,
        { kind: "interpret", text: "what?" },
      );
      expect(echoed.status).toBe("idle");
      expect(echoed.trace).toEqual([]);
      expect(echoed.idle?.timers).toEqual(started.idle?.timers);
    } finally {
      warn.mockRestore();
    }
  });
});
