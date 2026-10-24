import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { answer, createBugfixServer, type RunStatus } from "./index.js";

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createBugfixServer().connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    const text = result.content[0]!.text;
    return result.isError
      ? { error: text }
      : (JSON.parse(text) as RunStatus & { workflow?: string });
  };
  return { client, call };
}

test("lists the three tools", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(["start", "status", "send"]);
});

test("the agent works the run; a person approves it", async () => {
  const { call } = await connect();

  const started = await call("start", { issue: "Totals are off by one" });
  if ("error" in started) throw new Error(started.error);
  expect(started.workflow).toContain("on approve (human) → approved");
  expect(started.state).toBe("reproducing");
  expect(started.instructions).toBe("Write a test that fails because of the bug.");
  expect(started.events.map((event) => event.type)).toEqual(["reproduced", "cannotReproduce"]);
  expect(started.events[0]!.payload).toMatchObject({ required: ["test"] });

  const { runId } = started;
  await call("send", { runId, event: { type: "reproduced", test: "totals.test.ts" } });
  await call("send", { runId, event: { type: "fixed", summary: "Use < instead of <=" } });
  const inReview = await call("send", { runId, event: { type: "testsPassed" } });
  expect(inReview).toMatchObject({
    state: "inReview",
    waitingFor: "Review the fix: Use < instead of <=",
    events: [],
  });

  // Review is a person's call.
  expect(await call("send", { runId, event: { type: "approve" } })).toEqual({
    error: "A person sends 'approve'. Call status later to see their answer.",
  });

  await answer(runId, { type: "approve" });
  expect(await call("status", { runId })).toMatchObject({
    state: "approved",
    output: { summary: "Use < instead of <=" },
  });
});

test("a bad payload and an event the state does not handle come back as tool errors", async () => {
  const { call } = await connect();
  const started = await call("start", { issue: "Crash on empty input" });
  if ("error" in started) throw new Error(started.error);
  const { runId } = started;

  const badPayload = await call("send", { runId, event: { type: "reproduced" } });
  expect(badPayload).toHaveProperty("error", expect.stringContaining("reproduced"));

  expect(await call("send", { runId, event: { type: "testsPassed" } })).toEqual({
    error: "'testsPassed' does not apply in state 'reproducing'.",
  });
  expect(await call("status", { runId })).toMatchObject({ state: "reproducing" });
});

test("requested changes send the agent back to fixing", async () => {
  const { call } = await connect();
  const started = await call("start", { issue: "Slow search" });
  if ("error" in started) throw new Error(started.error);
  const { runId } = started;
  await call("send", { runId, event: { type: "reproduced", test: "search.test.ts" } });
  await call("send", { runId, event: { type: "fixed", summary: "Add an index" } });
  await call("send", { runId, event: { type: "testsPassed" } });

  await answer(runId, { type: "requestChanges", notes: "Cover the empty query too" });
  expect(await call("status", { runId })).toMatchObject({
    state: "fixing",
    events: [{ type: "fixed" }],
  });
});

test("concurrent sends to one run apply one at a time", async () => {
  const { call } = await connect();
  const started = await call("start", { issue: "Flaky retry" });
  if ("error" in started) throw new Error(started.error);
  const { runId } = started;

  const [first, second] = await Promise.all([
    call("send", { runId, event: { type: "reproduced", test: "retry.test.ts" } }),
    call("send", { runId, event: { type: "cannotReproduce", notes: "Passes locally" } }),
  ]);
  expect(first).toMatchObject({ state: "fixing" });
  expect(second).toEqual({ error: "'cannotReproduce' does not apply in state 'fixing'." });
});
