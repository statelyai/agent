import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, createMachine, type AnyMachineSnapshot } from "xstate";
import {
  getAgentMessages,
  runAgent,
  userMessage,
  type AgentDecisionRequest,
  type AgentMessage,
  type AgentMessageInfo,
  type AgentStateRequest,
  type AgentTextRequest,
  type AgentTools,
} from "./index.js";
import { getMachineStructuralHash } from "./index.js";
// TODO: re-export from ./index.js (see the export list in the handoff report).
import { getSnapshotNodes, getSnapshotRequests } from "./run-agent.js";

// ─── State interpretation (runAgent's `getRequests` option) ───
//
// These machines are PLAIN xstate machines: no setupAgent, no invokes, no
// actor sources. The agent work lives in prose on the state nodes, and each
// test brings its own RECIPE — a `getRequests` hook mapping the snapshot to
// model requests. Nothing about where prompts live is blessed by the library.

// The prompts-in-descriptions recipe (copy-paste and adapt): every active
// described node becomes a request; `waiting` tags settle idle for a human;
// `decision` tags skip the text call; and single-outcome states advance
// deterministically via an explicit `onDone` — the recipe's heuristic, not
// the library's.
const fromDescriptions =
  (model: string) =>
  (snapshot: {
    nodes: Array<{
      description?: string;
      tags: string[];
      meta?: unknown;
      ownEvents: string[];
    }>;
  }) =>
    snapshot.nodes
      .filter((node) => node.description && !node.tags.includes("waiting"))
      .map(
        (node): AgentStateRequest => ({
          model,
          prompt: node.description!,
          kind: node.tags.includes("decision") ? "decision" : "text",
          system: (node.meta as { role?: string } | undefined)?.role,
          onDone: node.ownEvents.length === 1 ? { type: node.ownEvents[0]! } : undefined,
        }),
      );

const taglineMachine = createMachine({
  id: "taglineWriter",
  schemas: {
    meta: z.object({ role: z.string().optional() }),
  },
  initial: "brainstorming",
  states: {
    brainstorming: {
      description: "Brainstorm three tagline ideas for the product.",
      on: { IDEAS_READY: { target: "drafting" } },
    },
    drafting: {
      description: "Pick the strongest idea and write the final tagline.",
      meta: { role: "Senior copywriter" },
      on: { DRAFT_READY: { target: "judging" } },
    },
    judging: {
      description: "Judge the tagline: approve it or request one revision.",
      tags: ["decision"],
      on: {
        APPROVE: { target: "complete" },
        REVISE: { target: "drafting" },
      },
    },
    complete: { type: "final" },
  },
});

describe("runAgent getRequests (state interpretation)", () => {
  test("drives a plain described machine to done, aggregating snapshot.messages", async () => {
    const textCalls: Array<AgentTextRequest & { tools: AgentTools }> = [];
    const decideCalls: AgentDecisionRequest[] = [];
    const live: AgentMessage[] = [];
    const liveInfos: AgentMessageInfo[] = [];

    const result = await runAgent(taglineMachine, {
      getRequests: fromDescriptions("test-model"),
      onMessage: (message, info) => {
        live.push(message);
        liveInfos.push(info);
      },
      executors: {
        generateText: async (request) => {
          textCalls.push(request);
          return {
            output: request.messages?.length === 1 ? "idea A, idea B, idea C" : "Ship it faster.",
          };
        },
        decide: async (request) => {
          decideCalls.push(request);
          return { event: { type: "APPROVE" } };
        },
      },
    });

    expect(result.status).toBe("done");

    // brainstorming + drafting are text steps; judging is a decision step.
    expect(textCalls).toHaveLength(2);
    expect(decideCalls).toHaveLength(1);

    // Prompts come from state descriptions; system from the recipe's meta read.
    expect(textCalls[0]?.messages?.at(-1)).toEqual(
      userMessage("Brainstorm three tagline ideas for the product."),
    );
    expect(textCalls[0]?.system).toBeUndefined();
    expect(textCalls[1]?.system).toBe("Senior copywriter");

    // Aggregation: the drafting call sees the brainstorming exchange.
    expect(textCalls[1]?.messages?.map((message) => message.content)).toEqual([
      "Brainstorm three tagline ideas for the product.",
      "idea A, idea B, idea C",
      "Pick the strongest idea and write the final tagline.",
    ]);

    // The decision call sees the whole log, including the draft.
    expect(decideCalls[0]?.messages?.map((message) => message.content)).toContain(
      "Ship it faster.",
    );
    expect(decideCalls[0]?.events.map((descriptor) => descriptor.type)).toEqual([
      "APPROVE",
      "REVISE",
    ]);

    // The full log is stamped onto the settled snapshot; read it with the
    // typed accessor — it works on the live and JSON-persisted snapshot alike.
    // `onMessage` observed the same log live, message by message.
    const messages = getAgentMessages(result.snapshot);
    expect(getAgentMessages(taglineMachine.getPersistedSnapshot(result.snapshot) as never)).toEqual(
      messages,
    );
    expect(live).toEqual(messages);

    // The live info arg carries the run's identity, one per message, all
    // sharing the same runId (machineVersion === the machine's structural hash).
    expect(liveInfos).toHaveLength(live.length);
    for (const info of liveInfos) {
      expect(info.machineId).toBe("taglineWriter");
      expect(info.machineVersion).toBe(getMachineStructuralHash(taglineMachine));
      expect(info.runId).toBe(liveInfos[0]!.runId);
      expect(typeof info.runId).toBe("string");
    }

    // Messages themselves stay clean — no agentMeta leaks onto them (model
    // input, persisted onto the snapshot), live or on the settled snapshot.
    for (const message of live) {
      expect("agentMeta" in message).toBe(false);
    }
    for (const message of messages) {
      expect("agentMeta" in message).toBe(false);
    }
    expect(messages.map((message) => message.content)).toEqual([
      "Brainstorm three tagline ideas for the product.",
      "idea A, idea B, idea C",
      "Pick the strongest idea and write the final tagline.",
      "Ship it faster.",
      "Judge the tagline: approve it or request one revision.",
      "[chose: APPROVE]",
    ]);
  });

  test("a chosen event can loop the machine back through an earlier state", async () => {
    let drafts = 0;
    let judgements = 0;

    const result = await runAgent(taglineMachine, {
      getRequests: fromDescriptions("test-model"),
      executors: {
        generateText: async (request) => {
          const prompt = request.messages?.at(-1)?.content;
          if (prompt === "Pick the strongest idea and write the final tagline.") {
            drafts += 1;
            return { output: `draft ${drafts}` };
          }
          return { output: "ideas" };
        },
        decide: async () => {
          judgements += 1;
          return { event: { type: judgements === 1 ? "REVISE" : "APPROVE" } };
        },
      },
    });

    expect(result.status).toBe("done");
    expect(drafts).toBe(2);
    expect(judgements).toBe(2);
  });

  test("parallel regions become concurrent requests, each scoped by allowedEvents", async () => {
    const machine = createMachine({
      id: "parallelReview",
      initial: "reviewing",
      states: {
        reviewing: {
          type: "parallel",
          states: {
            style: {
              initial: "checking",
              states: {
                checking: {
                  description: "Review the style.",
                  on: { STYLE_DONE: { target: "done" } },
                },
                done: { type: "final" },
              },
            },
            facts: {
              initial: "checking",
              states: {
                checking: {
                  description: "Review the facts.",
                  on: { FACTS_DONE: { target: "done" } },
                },
                done: { type: "final" },
              },
            },
          },
          onDone: { target: "complete" },
        },
        complete: { type: "final" },
      },
    });

    const result = await runAgent(machine, {
      // Recipe: one request per described leaf, each explicitly advancing
      // itself via its node's single own event.
      getRequests: (snapshot) =>
        snapshot.nodes
          .filter((node) => node.description)
          .map((node) => ({
            model: "test-model",
            prompt: node.description!,
            onDone: { type: node.ownEvents[0]! },
          })),
      executors: {
        // Ordering/isolation under adversarial latency is pinned at the unit
        // seam (state-request-pass.test.ts); here we cover the runAgent
        // wiring: both regions advance, stamped log in request order.
        generateText: async (request) => ({
          output: `${String(request.messages?.at(-1)?.content)} -> ok`,
        }),
      },
    });

    expect(result.status).toBe("done");
    expect(getAgentMessages(result.snapshot).map((message) => message.content)).toEqual([
      "Review the style.",
      "Review the style. -> ok",
      "Review the facts.",
      "Review the facts. -> ok",
    ]);
  });

  test("waiting states settle idle; `messages` appends to resumed history (function form replaces)", async () => {
    const machine = createMachine({
      id: "topicWriter",
      initial: "awaitingTopic",
      states: {
        awaitingTopic: {
          description: "Ask the user what to write about.",
          tags: ["waiting"],
          on: { TOPIC_GIVEN: { target: "writing" } },
        },
        writing: {
          description: "Write one sentence about the topic.",
          on: { WRITTEN: { target: "awaitingNotes" } },
        },
        awaitingNotes: {
          description: "Ask the user for revision notes.",
          tags: ["waiting"],
          on: { NOTES_GIVEN: { target: "revising" } },
        },
        revising: {
          description: "Revise per the notes.",
          on: { REVISED: { target: "complete" } },
        },
        complete: { type: "final" },
      },
    });

    const shared = {
      getRequests: fromDescriptions("test-model"),
      executors: {
        generateText: async (request: AgentTextRequest & { tools: AgentTools }) => ({
          output: `ok (${request.messages?.length ?? 0} in)`,
        }),
      },
    };

    const first = await runAgent(machine, shared);
    expect(first.status).toBe("idle");
    expect(getAgentMessages(first.snapshot)).toEqual([]);

    // Resume with the user's answer folded into the log.
    const second = await runAgent(machine, {
      ...shared,
      snapshot: first.snapshot,
      event: { type: "TOPIC_GIVEN" },
      messages: [userMessage("Topic: state machines")],
    });
    expect(second.status).toBe("idle");
    expect(getAgentMessages(second.snapshot).map((message) => message.content)).toEqual([
      "Topic: state machines",
      "Write one sentence about the topic.",
      "ok (2 in)",
    ]);

    // ARRAY form APPENDS to the resumed snapshot's history — the prior
    // conversation is never silently erased.
    const third = await runAgent(machine, {
      ...shared,
      snapshot: second.snapshot,
      event: { type: "NOTES_GIVEN" },
      messages: [userMessage("Make it funnier")],
    });
    expect(third.status).toBe("done");
    expect(getAgentMessages(third.snapshot).map((message) => message.content)).toEqual([
      "Topic: state machines",
      "Write one sentence about the topic.",
      "ok (2 in)",
      "Make it funnier",
      "Revise per the notes.",
      "ok (5 in)",
    ]);

    // A plain resume (no getRequests, no messages) must not drop the log the
    // snapshot carried in — parity with agentMeta stamping.
    const carried = await runAgent(machine, { snapshot: second.snapshot });
    expect(carried.status).toBe("idle");
    expect(getAgentMessages(carried.snapshot)).toEqual(getAgentMessages(second.snapshot));

    // FUNCTION form takes full control of the seed (here: replacement).
    const replaced = await runAgent(machine, {
      ...shared,
      snapshot: second.snapshot,
      event: { type: "NOTES_GIVEN" },
      messages: () => [userMessage("Start clean")],
    });
    expect(replaced.status).toBe("done");
    expect(getAgentMessages(replaced.snapshot).map((message) => message.content)).toEqual([
      "Start clean",
      "Revise per the notes.",
      "ok (2 in)",
    ]);
  });

  test("recipes can read anything — prompts in meta, onDone mapping output into the event payload", async () => {
    const machine = createMachine({
      id: "customMeta",
      schemas: { meta: z.object({ task: z.string().optional() }) },
      initial: "working",
      states: {
        working: {
          meta: { task: "custom task prompt" },
          on: { FINISHED: { target: "complete" } },
        },
        complete: { type: "final" },
      },
    });

    const prompts: string[] = [];
    const sentEvents: Array<{ type: string }> = [];
    const result = await runAgent(machine, {
      getRequests: (snapshot) => {
        const meta = Object.values(snapshot.getMeta())[0] as { task?: string } | undefined;
        return meta?.task
          ? {
              model: "test-model",
              prompt: meta.task,
              // Function form: compute the event from the text output.
              onDone: ({ output }) => ({ type: "FINISHED", result: output }),
            }
          : undefined;
      },
      onTransition: (_snapshot, event) => {
        sentEvents.push(event as { type: string });
      },
      executors: {
        generateText: async (request) => {
          prompts.push(String(request.messages?.at(-1)?.content));
          return { output: "the work product" };
        },
      },
    });

    expect(result.status).toBe("done");
    expect(prompts).toEqual(["custom task prompt"]);
    expect(sentEvents).toContainEqual({ type: "FINISHED", result: "the work product" });
  });

  test("no onDone means a decide call — even with a single candidate (nothing implicit)", async () => {
    const machine = createMachine({
      id: "oneWay",
      initial: "working",
      states: {
        working: {
          description: "Do the work.",
          on: { DONE: { target: "complete" } },
        },
        complete: { type: "final" },
      },
    });

    const decideEvents: string[][] = [];
    const result = await runAgent(machine, {
      getRequests: (snapshot) =>
        snapshot.nodes
          .filter((node) => node.description)
          .map((node) => ({ model: "test-model", prompt: node.description! })),
      executors: {
        generateText: async () => ({ output: "worked" }),
        decide: async (request) => {
          decideEvents.push(request.events.map((descriptor) => descriptor.type));
          return { event: { type: "DONE" } };
        },
      },
    });

    expect(result.status).toBe("done");
    expect(decideEvents).toEqual([["DONE"]]);
  });

  test("an onDone event the state does not accept settles the run as an error", async () => {
    const machine = createMachine({
      id: "typo",
      initial: "working",
      states: {
        working: {
          description: "Do the work.",
          on: { DONE: { target: "complete" } },
        },
        complete: { type: "final" },
      },
    });

    const result = await runAgent(machine, {
      getRequests: () => ({ model: "test-model", prompt: "work", onDone: { type: "DNOE" } }),
      executors: { generateText: async () => ({ output: "worked" }) },
    });

    expect(result.status).toBe("error");
    expect(String(result.status === "error" ? result.error : "")).toContain("DNOE");
  });

  test("without `getRequests`, a described machine settles idle (default unchanged)", async () => {
    const result = await runAgent(taglineMachine, {
      executors: {
        generateText: async () => ({ output: "never called" }),
      },
    });
    expect(result.status).toBe("idle");
    // No stamp at all on a default run (raw property check on purpose) — and
    // the accessor normalizes that to [].
    expect((result.snapshot as { messages?: AgentMessage[] }).messages).toBeUndefined();
    expect(getAgentMessages(result.snapshot)).toEqual([]);
  });

  test(
    "advances through isIdle-positive states instead of stalling",
    { timeout: 3000 },
    async () => {
      const machine = createMachine({
        id: "suspendedFlow",
        initial: "a",
        states: {
          a: { description: "Do a.", on: { A_DONE: { target: "b" } } },
          b: { description: "Do b.", on: { B_DONE: { target: "complete" } } },
          complete: { type: "final" },
        },
      });

      const result = await runAgent(machine, {
        // Every snapshot reads as an intentional wait — interpretation must
        // still retrigger after each pass (P1 regression).
        isIdle: () => true,
        getRequests: (snapshot) =>
          snapshot.nodes
            .filter((node) => node.description)
            .map((node) => ({
              model: "test-model",
              prompt: node.description!,
              onDone: { type: node.ownEvents[0]! },
            })),
        executors: { generateText: async () => ({ output: "ok" }) },
      });

      expect(result.status).toBe("done");
    },
  );

  test("model-call budget applies to getRequests passes", async () => {
    const machine = createMachine({
      id: "loopy",
      initial: "spinning",
      states: {
        spinning: {
          description: "Spin forever.",
          on: { AGAIN: { target: "spinning" } },
        },
      },
    });

    const result = await runAgent(machine, {
      maxModelCalls: 3,
      getRequests: fromDescriptions("test-model"),
      executors: {
        generateText: async () => ({ output: "spin" }),
      },
    });

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.cause : undefined).toBe("max-model-calls");
  });
});

// ─── getSnapshotRequests / getSnapshotNodes (the recipe, without `_nodes`) ───

describe("getSnapshotRequests", () => {
  test("drives the same described machine with no `_nodes` access in host code", async () => {
    const textCalls: AgentTextRequest[] = [];
    const decideCalls: AgentDecisionRequest[] = [];

    const result = await runAgent(taglineMachine, {
      getRequests: (snapshot) => getSnapshotRequests(snapshot, { model: "test-model" }),
      executors: {
        generateText: async (request) => {
          textCalls.push(request);
          return { output: "a line" };
        },
        decide: async (request) => {
          decideCalls.push(request);
          return { event: { type: "APPROVE" } };
        },
      },
    });

    expect(result.status).toBe("done");
    // brainstorming + drafting are text steps; judging (tagged `decision`) is not.
    expect(textCalls).toHaveLength(2);
    expect(textCalls[1]?.system).toBe("Senior copywriter");
    expect(decideCalls).toHaveLength(1);
    // Candidate events are scoped to the node's own events.
    expect(decideCalls[0]?.events.map((event) => event.type).sort()).toEqual(["APPROVE", "REVISE"]);
  });

  test("single-outcome states advance deterministically; `filter`/`map` override the defaults", () => {
    const machine = createMachine({
      id: "two",
      initial: "writing",
      states: {
        writing: {
          description: "Write it.",
          on: { NEXT: { target: "waiting" } },
        },
        waiting: {
          description: "Wait for a human.",
          tags: ["waiting"],
          on: { APPROVE: { target: "done" }, REJECT: { target: "writing" } },
        },
        done: { type: "final" },
      },
    });

    const snapshot = runAgentSnapshot(machine);
    const requests = getSnapshotRequests(snapshot, { model: "m" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "m",
      prompt: "Write it.",
      kind: "text",
      onDone: { type: "NEXT" },
      allowedEvents: ["NEXT"],
    });

    // `map` reshapes; returning undefined drops.
    expect(
      getSnapshotRequests(snapshot, {
        model: "m",
        map: (request) => ({ ...request, system: "Be brief." }),
      })[0]?.system,
    ).toBe("Be brief.");
    expect(getSnapshotRequests(snapshot, { model: "m", map: () => undefined })).toEqual([]);
    // `filter` overrides the default described-and-not-waiting rule.
    expect(getSnapshotRequests(snapshot, { model: "m", filter: () => false })).toEqual([]);
  });

  test("getSnapshotNodes exposes the active nodes as plain descriptors", () => {
    const snapshot = runAgentSnapshot(taglineMachine);
    const nodes = getSnapshotNodes(snapshot);

    expect(nodes.some((node) => node.id.endsWith("brainstorming"))).toBe(true);
    const leaf = nodes.find((node) => node.key === "brainstorming");
    expect(leaf?.description).toBe("Brainstorm three tagline ideas for the product.");
    expect(leaf?.ownEvents).toEqual(["IDEAS_READY"]);
    expect(leaf?.leaf).toBe(true);
  });
});

// The initial snapshot of a machine, as a live actor would see it.
function runAgentSnapshot(machine: Parameters<typeof createActor>[0]) {
  const actor = createActor(machine);
  actor.start();
  const snapshot = actor.getSnapshot() as AnyMachineSnapshot;
  actor.stop();
  return snapshot;
}
