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

test("labels the stub-provisioned accounts as simulated", async () => {
  const first = await runAgent(longRunningOnboardingMachine, {
    input: {
      employee: {
        id: "E-100",
        name: "Ann Lee",
        role: "Product Engineer",
        startDate: "2026-08-03",
        equipment: "MacBook Pro",
      },
    },
    executors: { generateText },
  });
  expect(first.status).toBe("idle");
  if (first.status !== "idle") return;

  const second = await runAgent(longRunningOnboardingMachine, {
    snapshot: first.persistedSnapshot,
    event: { type: "DOCS_SIGNED", signedAt: "2026-07-20" },
    executors: { generateText },
  });
  expect(second.status).toBe("idle");
  if (second.status !== "idle") return;

  // A host rendering context sees the provenance next to the identifiers.
  expect(second.snapshot.context.provisioningNote).toContain("Simulated IT provisioning");
  expect(second.snapshot.context.provisioningNote).toContain("ann.lee@example.com");
});

test("a delivered laptop is never written up as still scheduled", async () => {
  const requests: AgentTextRequest[] = [];
  // Naive scheduler: it phrases hardware straight from the status it is given.
  const scheduler = async (request: AgentTextRequest) => {
    requests.push(request);
    const status = /Hardware: (.*)/.exec(request.prompt ?? "")?.[1] ?? "";
    return {
      output: status.startsWith("delivered")
        ? "9:00 Setup. The laptop was delivered and is waiting at the desk."
        : "9:00 Setup. The laptop delivery is scheduled.",
    };
  };

  const result = await runLongRunningOnboardingExample({ generateText: scheduler });

  expect(result.output.schedule).toContain("was delivered");
  expect(result.output.schedule).not.toContain("is scheduled");
  // The delivery status — not just its timestamp — reaches the model, with an
  // instruction against contradicting recorded events.
  const scheduleRequest = requests.at(-1);
  expect(scheduleRequest?.prompt).toContain("Hardware: delivered on 2026-07-28 (already received)");
  expect(scheduleRequest?.system).toContain("never");
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
