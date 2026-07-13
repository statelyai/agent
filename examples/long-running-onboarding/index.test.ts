import { expect, test } from "vitest";
import { runAgent, type AgentTextRequest } from "../../src/index.js";
import { longRunningOnboardingMachine, runLongRunningOnboardingExample } from "./index.js";

const generateText = async (request: AgentTextRequest) => ({
  output: `Day one for ${request.prompt}`,
});

test("pauses twice and resumes from JSON snapshots", async () => {
  const result = await runLongRunningOnboardingExample({ generateText });

  expect(result.idleStates).toEqual(["waitingForSignedDocs", "waitingForHardware"]);
  expect(result.idlePrompts).toEqual([
    "Wait until the employee signs onboarding documents.",
    "Wait until the laptop is delivered.",
  ]);
  expect(result.idleEventTypes).toEqual([["DOCS_SIGNED"], ["HARDWARE_DELIVERED"]]);
  expect(result.output).toMatchObject({
    employeeId: "E-100",
    welcomePacketId: "WELCOME-E-100",
    accounts: {
      email: "ann.lee@example.com",
      slack: "@ann.lee",
      ticketId: "IT-E-100",
    },
  });
  expect(result.output.schedule).toContain("Ann Lee");
});

test("does not provision IT before documents are signed", async () => {
  const first = await runAgent(longRunningOnboardingMachine, {
    input: {
      employee: {
        id: "E-200",
        name: "Sam Chen",
        role: "Designer",
        startDate: "2026-09-01",
        equipment: "MacBook Air",
      },
    },
    executors: { generateText },
  });

  expect(first.status).toBe("idle");
  if (first.status !== "idle") return;
  expect(first.snapshot.value).toBe("waitingForSignedDocs");
  expect(first.snapshot.context.accounts).toBeNull();
});
