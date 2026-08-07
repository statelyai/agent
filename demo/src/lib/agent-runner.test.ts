import { describe, expect, test } from "vitest";
import type { Snapshot } from "xstate";
import { startScenarioRun, resumeScenarioRun } from "./agent-runner";
import { scriptedExecutorsFor } from "./scripted-executors";
import type { ScenarioId } from "./scenarios";

// Every test runs the REAL machines with keyless scripted executors — the same
// path the UI uses without an API key. No network, no key.
function start(id: ScenarioId, prompt: string) {
  return startScenarioRun(id, prompt, "script", undefined, scriptedExecutorsFor(id));
}
// The persisted snapshot crosses the wire as opaque JSON; cast it back at the boundary
// (mirrors the zod-validated server fn) before handing it to runAgent.
function resume(id: ScenarioId, snapshot: unknown, event: { type: string; [k: string]: unknown }) {
  return resumeScenarioRun(
    id,
    snapshot as Snapshot<unknown>,
    event,
    "script",
    undefined,
    scriptedExecutorsFor(id),
  );
}

describe("scenario outcomes (keyless)", () => {
  test("refund under $100 auto-refunds", async () => {
    const result = await start("refund", "Please refund $75 for a damaged item.");
    expect(result.status).toBe("done");
    expect((result.output as { outcome: string }).outcome).toBe("refunded");
    expect(result.trace.length).toBeGreaterThan(0);
  });

  test("refund over $100 settles idle awaiting approval; APPROVE resumes to done", async () => {
    const first = await start("refund", "I need a $500 refund for a cancelled order.");
    expect(first.status).toBe("idle");
    expect(first.idle?.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["APPROVE", "DENY"]),
    );
    const second = await resume("refund", first.idle!.snapshot, { type: "APPROVE" });
    expect(second.status).toBe("done");
    expect((second.output as { outcome: string }).outcome).toBe("approved");
  });

  test("refund with no amount asks for details", async () => {
    const result = await start("refund", "I want my money back.");
    expect(result.status).toBe("done");
    expect((result.output as { outcome: string }).outcome).toBe("needs-details");
  });

  test("resumeScenario rejects an event the snapshot does not accept", async () => {
    const first = await start("refund", "Refund $500 please.");
    expect(first.status).toBe("idle");
    await expect(
      resume("refund", first.idle!.snapshot, { type: "NOT_A_REAL_EVENT" }),
    ).rejects.toThrow();
  });

  test("approval drafts, settles idle, then publishes on APPROVE", async () => {
    const first = await start("approval", "Announce the delayed database migration.");
    expect(first.status).toBe("idle");
    expect(first.idle?.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["APPROVE", "REJECT"]),
    );
    const second = await resume("approval", first.idle!.snapshot, { type: "APPROVE" });
    expect(second.status).toBe("done");
    expect((second.output as { published: boolean }).published).toBe(true);
  });

  test("approval REJECT loops back to drafting (idle again)", async () => {
    const first = await start("approval", "Announce the outage.");
    const second = await resume("approval", first.idle!.snapshot, {
      type: "REJECT",
      reason: "too vague",
    });
    expect(second.status).toBe("idle");
  });

  test("routing picks a typed queue", async () => {
    const result = await start("routing", "I was charged twice and cannot download my invoice.");
    expect(result.status).toBe("done");
    const output = result.output as { queue: string; reason: string };
    expect(output.queue).toBe("billing");
    // The model must justify the route, and the justification reaches the chat.
    expect(output.reason).not.toBe("");
    expect(result.response).toContain(output.reason);
  });

  test("research runs both regions then synthesizes", async () => {
    const result = await start("research", "Adopting passkeys.");
    expect(result.status).toBe("done");
    const output = result.output as { risks: string; opportunities: string; synthesis: string };
    expect(output.risks).not.toBe("");
    expect(output.opportunities).not.toBe("");
    expect(output.synthesis).not.toBe("");
  });

  test("pipeline plans, executes, and verifies", async () => {
    const result = await start(
      "pipeline",
      "Write a launch update: faster sync, safer retries, gradual rollout.",
    );
    expect(result.status).toBe("done");
    const output = result.output as { verification: string; failedAt: string | null };
    expect(output.failedAt).toBeNull();
    expect(output.verification).not.toBe("");
  });

  test("retry reaches fallback success after primary failures", async () => {
    const result = await start("retry", "I was charged twice and cannot open my invoice.");
    expect(result.status).toBe("done");
    const output = result.output as { category: string; attempts: number; usedFallback: boolean };
    expect(output.usedFallback).toBe(true);
    expect(output.attempts).toBe(2);
    expect(output.category).not.toBe("");
  });

  test("tools calls a tool then finishes within the cap", async () => {
    const result = await start("tools", "What is 42 times 17?");
    expect(result.status).toBe("done");
    const output = result.output as { answer: string; steps: number };
    expect(output.steps).toBeGreaterThanOrEqual(1);
    expect(output.answer).not.toBe("");
  });

  test("reflection revises once then accepts", async () => {
    const result = await start("reflection", "A tidal shoreline at dusk.");
    expect(result.status).toBe("done");
    const output = result.output as { revisions: number; accepted: boolean; score: number };
    expect(output.revisions).toBe(1);
    expect(output.accepted).toBe(true);
    expect(output.score).toBeGreaterThanOrEqual(8);
  });
});
