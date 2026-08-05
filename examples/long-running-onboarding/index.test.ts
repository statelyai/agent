import { expect, test } from "vitest";
import { runAgent, type AgentTextRequest } from "@statelyai/agent";
import { longRunningOnboardingMachine, runLongRunningOnboardingExample } from "./index.js";

const generateText = async (request: AgentTextRequest) => ({
  output: `Day one for ${request.prompt}`,
});

test("pauses twice and resumes from JSON snapshots", async () => {
  const result = await runLongRunningOnboardingExample({ generateText });

  expect(result.idleStates).toEqual(["waitingForSignedDocs", "waitingForHardware"]);
  expect(result.idlePrompts).toEqual([
    "Waiting for the signed onboarding documents. Mark them signed to continue.",
    "Waiting on hardware delivery. Mark the laptop delivered to continue.",
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
