/**
 * The runner defaults to real OpenAI executors. These tests script the draft
 * at the provider with the repo's AI SDK mock, answering by request name
 * (`propose`). The test itself plays the host's durable timer scheduler.
 */
import { expect, test } from "vitest";
import { getInteraction } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import { deadlineEscalationMachine, runDeadlineEscalationExample } from "./index.js";

// One shared mock: the `propose` answer repeats for every run.
const executors = createMockModelExecutors({
  text: { propose: "Proposed maintenance: Saturday, 09:00 UTC." },
});

/** The test's durable scheduler: it records what to fire and fires nothing itself. */
function hostTimers() {
  const scheduled = new Map<string, number>();
  return {
    scheduled,
    timers: {
      schedule: ({ id, delay }: { id: string; delay: number }) => scheduled.set(id, delay),
      cancel: (id: string) => scheduled.delete(id),
    },
  };
}

test("with host-owned timers, the run settles at the wait and hands the deadline to the host", async () => {
  const host = hostTimers();
  const pending = await runDeadlineEscalationExample({ executors, timers: host.timers });
  expect(pending.status).toBe("idle");
  expect([...host.scheduled.values()]).toEqual([60_000]);

  // The scheduler fires into a fresh-process restore.
  const [id] = [...host.scheduled.keys()];
  const expired = await runDeadlineEscalationExample({
    executors,
    timers: host.timers,
    snapshot: JSON.parse(JSON.stringify(pending.persist())),
    event: { type: "xstate.timer", id: id! },
  });
  expect(expired.status).toBe("done");
  if (expired.status === "done") expect(expired.output.outcome).toBe("escalated");
});

test.each([
  ["proposal-1", "done", "approved"],
  ["stale-proposal", "idle", undefined],
] as const)("approval for %s before the deadline", async (requestId, status, outcome) => {
  const host = hostTimers();
  const pending = await runDeadlineEscalationExample({ executors, timers: host.timers });
  const result = await runDeadlineEscalationExample({
    executors,
    timers: host.timers,
    snapshot: JSON.parse(JSON.stringify(pending.persist())),
    event: { type: "APPROVE", requestId },
  });
  expect(result.status).toBe(status);
  if (result.status === "done") expect(result.output.outcome).toBe(outcome);
  else expect(result.ignored).toEqual({ type: "APPROVE", requestId });
});

test("in-process timers: a script host just waits, and the deadline fires on its own", async () => {
  const result = await runDeadlineEscalationExample({
    executors,
    input: { requestId: "proposal-1", task: "Schedule maintenance", windowMs: 20 },
  });
  expect(result.status).toBe("done");
  if (result.status === "done") expect(result.output.outcome).toBe("escalated");
});

test("the approval wait is host-discoverable through interaction metadata", async () => {
  const pending = await runDeadlineEscalationExample({ executors, timers: hostTimers().timers });
  expect(pending.status).toBe("idle");
  const interaction = getInteraction(pending.snapshot);
  expect(interaction?.label).toContain("approval window");
  expect(interaction?.events.map((event) => event.type)).toEqual(["APPROVE"]);
});

test("expiry wins once applied; a late approval cannot reopen a completed run", async () => {
  const host = hostTimers();
  const pending = await runDeadlineEscalationExample({ executors, timers: host.timers });
  const [id] = [...host.scheduled.keys()];
  const expired = await runDeadlineEscalationExample({
    executors,
    timers: host.timers,
    snapshot: pending.persist(),
    event: { type: "xstate.timer", id: id! },
  });
  const late = await runDeadlineEscalationExample({
    executors,
    timers: host.timers,
    snapshot: expired.persist(),
    event: { type: "APPROVE", requestId: "proposal-1" },
  });
  expect(late.status).toBe("done");
  if (late.status === "done") expect(late.output.outcome).toBe("escalated");
});

test("draft failure is explicit; machine structure validates", async () => {
  const result = await runDeadlineEscalationExample({
    executors: createMockModelExecutors({
      text: {
        propose: () => {
          throw new Error("Unavailable");
        },
      },
    }),
  });
  expect(result.status).toBe("done");
  if (result.status === "done") expect(result.output.outcome).toBe("failed");
  expect(lintAgentMachine(deadlineEscalationMachine).filter((d) => d.severity === "error")).toEqual(
    [],
  );
});

test("without injected executors or a key, the runner rejects naming the env var", async () => {
  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await expect(runDeadlineEscalationExample()).rejects.toThrow("OPENAI_API_KEY");
  } finally {
    if (key !== undefined) process.env.OPENAI_API_KEY = key;
  }
});
