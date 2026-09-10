import { expect, test } from "vitest";
import { getInteraction, lintAgentMachine } from "@statelyai/agent";
import { deadlineEscalationMachine, runDeadlineEscalationExample } from "./index.js";

test.each([
  ["APPROVE", "proposal-1", 999, "done", "approved"],
  ["APPROVE", "proposal-1", 1000, "idle", undefined],
  ["EXPIRE", "proposal-1", 999, "idle", undefined],
  ["EXPIRE", "proposal-1", 1000, "done", "escalated"],
  ["EXPIRE", "stale-proposal", 1001, "idle", undefined],
  ["APPROVE", "stale-proposal", 999, "idle", undefined],
] as const)("%s correlation=%s at %i", async (type, requestId, observedAt, status, outcome) => {
  const pending = await runDeadlineEscalationExample();
  expect(pending.status).toBe("idle");
  const result = await runDeadlineEscalationExample({
    snapshot: JSON.parse(JSON.stringify(pending.persist())),
    event: { type, requestId, observedAt },
  });
  expect(result.status).toBe(status);
  if (result.status === "done") expect(result.output.outcome).toBe(outcome);
  else expect(result.ignored).toEqual({ type, requestId, observedAt });
});

test("the approval wait is host-discoverable through interaction metadata", async () => {
  const pending = await runDeadlineEscalationExample();
  expect(pending.status).toBe("idle");
  const interaction = getInteraction(pending.snapshot);
  expect(interaction?.label).toContain("deadline");
  expect(interaction?.events.map((event) => event.type)).toEqual(["APPROVE", "EXPIRE"]);
});

test("expiry wins once applied; delayed approval cannot reopen a completed run", async () => {
  const pending = await runDeadlineEscalationExample();
  const expired = await runDeadlineEscalationExample({
    snapshot: pending.persist(),
    event: { type: "EXPIRE", requestId: "proposal-1", observedAt: 1000 },
  });
  const late = await runDeadlineEscalationExample({
    snapshot: expired.persist(),
    event: { type: "APPROVE", requestId: "proposal-1", observedAt: 999 },
  });
  expect(late.status).toBe("done");
  if (late.status === "done") expect(late.output.outcome).toBe("escalated");
});

test("draft failure is explicit; machine structure validates", async () => {
  const result = await runDeadlineEscalationExample({
    executors: {
      generateText: async () => {
        throw new Error("Unavailable");
      },
    },
  });
  expect(result.status).toBe("done");
  if (result.status === "done") expect(result.output.outcome).toBe("failed");
  expect(lintAgentMachine(deadlineEscalationMachine).filter((d) => d.severity === "error")).toEqual(
    [],
  );
});
