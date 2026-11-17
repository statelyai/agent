import { test } from "vitest";
import assert from "node:assert/strict";
import { getInteraction, type AgentTextRequest, runAgent } from "@statelyai/agent";
import { createMockModelExecutors } from "../mock-model.js";
import { runSwarmHandoffExample, swarmHandoffMachine, MAX_TURNS } from "./index.js";

/** The user's new message, without the conversation the prompt carries before it. */
const messageOf = (request: AgentTextRequest) => (request.input as { message: string }).message;

// Name-keyed script: `travelReply`/`foodReply` are request names, `route` is
// the name the `agent.decide` invoke declares.
function scripted(routeTo: "travel" | "food") {
  return createMockModelExecutors({
    text: {
      travelReply: [(request: AgentTextRequest) => `[travel] ${messageOf(request)}`],
      foodReply: [(request: AgentTextRequest) => `[food] ${messageOf(request)}`],
    },
    decisions: { route: [{ type: "HANDOFF", to: routeTo }] },
  });
}

test("the model's HANDOFF moves the mic, and it survives the JSON round-trip", async () => {
  const { travel, food } = await runSwarmHandoffExample({ executors: scripted("food") });

  // Turn 1: travel agent answered.
  assert.equal(travel.activeAgent, "travel");
  assert.equal(travel.reply, "[travel] I want a 3-day trip to Lisbon.");

  // Turn 2: the router chose HANDOFF to food, and the snapshot resumed from
  // JSON routed there.
  assert.equal(food.activeAgent, "food");
  assert.equal(food.reply, "[food] What are the must-try dishes there?");
});

test("the concierge taking the mic after a handoff reads the conversation so far", async () => {
  const prompts: string[] = [];
  const executors = createMockModelExecutors({
    text: {
      travelReply: [(request: AgentTextRequest) => `[travel] ${messageOf(request)}`],
      foodReply: [
        (request: AgentTextRequest) => {
          prompts.push(request.prompt ?? "");
          return `[food] ${messageOf(request)}`;
        },
      ],
    },
    decisions: { route: [{ type: "HANDOFF", to: "food" }] },
  });
  await runSwarmHandoffExample({ executors });

  // "there" only means Lisbon because the earlier turns travel with the handoff.
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /\[user\] I want a 3-day trip to Lisbon\./);
  assert.match(prompts[0]!, /\[travel\] \[travel\] I want a 3-day trip to Lisbon\./);
  assert.match(prompts[0]!, /New message from the user: What are the must-try dishes there\?$/);
});

test("a HANDOFF to the agent already holding the mic is rejected and retried", async () => {
  const chosen: string[] = [];
  const executors = createMockModelExecutors({
    text: {
      travelReply: [(request: AgentTextRequest) => `[travel] ${messageOf(request)}`],
      foodReply: [(request: AgentTextRequest) => `[food] ${messageOf(request)}`],
    },
    decisions: {
      // First attempt hands off to the active agent (illegal), second is legal.
      route: [
        (request) => {
          chosen.push(request.attempts.length === 0 ? "self" : "other");
          return request.attempts.length === 0
            ? { type: "HANDOFF", to: "travel" }
            : { type: "HANDOFF", to: "food" };
        },
      ],
    },
  });
  const { food } = await runSwarmHandoffExample({ executors });
  assert.deepEqual(chosen, ["self", "other"]);
  assert.equal(food.activeAgent, "food");
});

test("the spent turn budget is a state where only END is offered", async () => {
  const context = {
    message: "one more",
    activeAgent: "travel" as const,
    reply: "answered",
    turns: MAX_TURNS,
    history: [],
  };
  const snapshot = swarmHandoffMachine.resolveState({ value: "budgetSpent", context });
  assert.equal(snapshot.can({ type: "SAY", message: "again" }), false);
  assert.equal(snapshot.can({ type: "END" }), true);
  const interaction = getInteraction(snapshot);
  assert.equal(interaction?.textEvent, undefined);
  assert.deepEqual(
    interaction?.events.map((event) => event.type),
    ["END"],
  );
});

test("END's output does not repeat the last reply, which the idle turn already showed", async () => {
  const executors = scripted("food");
  const idle = await runAgent(swarmHandoffMachine, {
    executors,
    input: { message: "I want a 3-day trip to Lisbon." },
  });
  assert.equal(idle.status, "idle");
  if (idle.status !== "idle") return;
  const lastReply = idle.snapshot.context.reply;
  assert.equal(lastReply, "[travel] I want a 3-day trip to Lisbon.");

  const done = await runAgent(swarmHandoffMachine, {
    executors,
    snapshot: JSON.parse(JSON.stringify(idle.persist())),
    event: { type: "END" },
  });
  assert.equal(done.status, "done");
  if (done.status !== "done") return;
  assert.deepEqual(done.output, { activeAgent: "travel", turns: 1 });
  assert.ok(!JSON.stringify(done.output).includes(lastReply));
});
