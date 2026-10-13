import { expect, expectTypeOf, test } from "vitest";
import { runAgent, type AgentTextRequest } from "@statelyai/agent";
import { canReach } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import type { runSupportAgent as runLoop } from "./before.js";
import { MAX_STEPS, runSupportAgent, supportLoopMachine } from "./index.js";

const request = "Refund my duplicate charge";
const draft = { type: "SEND_EMAIL", to: "a@b.co", subject: "Refund", body: "Done." };
const never = async () => {
  throw new Error("approve should not be called");
};

test("the port runs on a mock model with no API key", async () => {
  // The loop builds its model inside the function, so it only runs against a live provider.
  const executors = createMockModelExecutors({
    text: { assist: "Your duplicate charge is refunded." },
    decisions: { chooseAction: { type: "REPLY" } },
  });

  const output = await runSupportAgent(request, never, executors);

  expectTypeOf(output).toEqualTypeOf<Awaited<ReturnType<typeof runLoop>>>();
  expect(output).toEqual({ sent: false, reply: "Your duplicate charge is refunded." });
});

test("later rounds receive the retained support transcript", async () => {
  const executors = createMockModelExecutors({
    text: { assist: ["First search result.", "Answer using both searches."] },
    decisions: { chooseAction: [{ type: "CONTINUE" }, { type: "REPLY" }] },
  });

  await runSupportAgent(request, never, executors);

  const assistCalls = executors.calls.filter((call) => call.name === "assist");
  expect(assistCalls).toHaveLength(2);
  expect(JSON.stringify(assistCalls[1]!.request.messages)).toContain("First search result.");
  expect(JSON.stringify(assistCalls[1]!.request.messages)).toContain("Continue researching");
  expect((assistCalls[1]!.request as AgentTextRequest).maxSteps).toBe(5);
});

test("the step limit settles done in failed, not a thrown error", async () => {
  // The loop's cap is a local counter, reachable only by spending eight real model calls.
  const executors = createMockModelExecutors({
    text: { assist: "Still looking." },
    decisions: { chooseAction: { type: "CONTINUE" } },
  });

  const result = await runAgent(supportLoopMachine, { input: { request }, executors });

  expect(result.status).toBe("done");
  if (result.status !== "done") return;
  expect(result.snapshot.value).toBe("failed");
  expect(result.output).toEqual({ sent: false, stopped: "step-limit" });
  expect(executors.calls.filter((call) => call.name === "assist")).toHaveLength(MAX_STEPS);
});

test("the approval pauses idle and resumes from a JSON snapshot", async () => {
  // The loop returned { pending: true } and dropped its state, so there was nothing to resume.
  const executors = createMockModelExecutors({
    text: { assist: "Refund issued; emailing the customer." },
    decisions: { chooseAction: [draft, { type: "REPLY" }] },
  });

  const paused = await runAgent(supportLoopMachine, { input: { request }, executors });
  expect(paused.status).toBe("idle");
  expect(paused.snapshot.value).toBe("awaitingApproval");

  const restored = JSON.parse(JSON.stringify(paused.persist()));
  const resumed = await runAgent(supportLoopMachine, {
    executors,
    snapshot: restored,
    event: { type: "APPROVE" },
  });

  expect(resumed.status).toBe("done");
  if (resumed.status !== "done") return;
  expect(resumed.output).toEqual({ sent: true, reply: "Refund issued; emailing the customer." });
  const assistCalls = executors.calls.filter((call) => call.name === "assist");
  expect(JSON.stringify(assistCalls[1]!.request.messages)).toContain(
    "approved email was sent successfully",
  );
});

test("no path sends an email without approval", async () => {
  // The loop's approval is an if inside the tool switch; no test can enumerate the paths around it.
  const everyPath = {
    input: { request },
    text: { assist: "Draft." },
    invokes: { sendEmail: { id: "msg_a@b.co" } },
    // MAX_STEPS rounds, each a decision plus an approval: deep and wide enough for every path.
    maxDepth: 2 * MAX_STEPS,
    maxPaths: 1000,
  };

  const sendsUnapproved = await canReach(
    supportLoopMachine,
    (snapshot) => snapshot.matches("sending") && !snapshot.context.approved,
    everyPath,
  );

  expect(sendsUnapproved.reachable).toBe(false);
});
