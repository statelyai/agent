import { describe, expect, test } from "vitest";
import { lintAgentMachine, runAgent } from "../index.js";
import type { AgentRequestExecutors, AgentTextRequest } from "../text-logic.js";
import type { AgentDecisionExecutor, AgentDecisionRequest } from "../decision.js";
import {
  createHandoffMachine,
  createLoopMachine,
  createParallelMachine,
  createRouterMachine,
  createSequentialMachine,
  createSupervisorMachine,
  createToolLoopMachine,
} from "./index.js";
import { objectSchema } from "./internal.js";

describe("preset object schemas", () => {
  test("required properties reject explicit undefined", async () => {
    const schema = objectSchema<{ name: string }>({ name: { type: "string" } }, ["name"]);
    const result = await schema["~standard"].validate({ name: undefined });
    expect(result.issues).toEqual([
      expect.objectContaining({ message: "Required property 'name' is missing", path: ["name"] }),
    ]);
  });

  test("supports nullable type arrays, null, and integers", async () => {
    const schema = objectSchema<{
      label: string | null;
      empty: null;
      count: number;
    }>(
      {
        label: { type: ["string", "null"] },
        empty: { type: "null" },
        count: { type: "integer" },
      },
      ["label", "empty", "count"],
    );

    expect(
      await schema["~standard"].validate({ label: "ready", empty: null, count: 2 }),
    ).toHaveProperty("value");
    expect(
      await schema["~standard"].validate({ label: null, empty: null, count: 2.5 }),
    ).toHaveProperty("issues");
  });
});

/** Records every text request and answers with `reply(request)`. */
function mockGenerateText(reply: (request: AgentTextRequest) => unknown = () => "ok") {
  const requests: AgentTextRequest[] = [];
  const generateText: AgentRequestExecutors["generateText"] = async (request) => {
    requests.push(request);
    return { output: reply(request) };
  };
  return { generateText, requests };
}

/** Answers each decision with the next scripted event type. */
function mockDecide(script: readonly string[]) {
  const requests: AgentDecisionRequest[] = [];
  let index = 0;
  const decide: AgentDecisionExecutor = async (request) => {
    requests.push(request);
    return { event: { type: script[index++] ?? script[script.length - 1]! } };
  };
  return { decide, requests };
}

/** Structural errors only — warnings (e.g. a handoff machine with no final state) are expected. */
function lintErrors(machine: Parameters<typeof lintAgentMachine>[0]) {
  return lintAgentMachine(machine).filter((diagnostic) => diagnostic.severity === "error");
}

describe("createToolLoopMachine", () => {
  const machine = createToolLoopMachine({
    model: "quick",
    instructions: "Answer using the tools.",
    tools: { calculate: { description: "math", execute: async () => 714 } },
    maxSteps: 5,
  });

  test("runs one request and finishes with its output", async () => {
    const { generateText, requests } = mockGenerateText(() => "42 * 17 = 714");
    const result = await runAgent(machine, {
      input: { prompt: "What is 42 times 17?" },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output).toEqual({ result: "42 * 17 = 714" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe("quick");
    expect(requests[0]?.system).toBe("Answer using the tools.");
    expect(requests[0]?.prompt).toBe("What is 42 times 17?");
    expect(Object.keys(requests[0]?.tools ?? {})).toEqual(["calculate"]);
  });

  test("maxSteps lowers to the typed request field", async () => {
    const gated = createToolLoopMachine({
      model: "quick",
      maxSteps: 3,
    });
    const { generateText, requests } = mockGenerateText();
    await runAgent(gated, { input: { prompt: "hi" }, executors: { generateText } });

    expect(requests[0]?.maxSteps).toBe(3);
    expect(requests[0]?.metadata).toBeUndefined();
  });

  test("carries version '1' and lints clean", () => {
    expect((machine as { version?: string }).version).toBe("1");
    // The version lives in machine config, so it survives executor rebinding.
    expect((machine.provide({}) as { version?: string }).version).toBe("1");
    expect(lintErrors(machine)).toEqual([]);
  });

  test("the run is stamped with the preset version automatically (no machineVersion option)", async () => {
    const { generateText } = mockGenerateText();
    const events: string[] = [];
    const result = await runAgent(machine, {
      input: { prompt: "hi" },
      executors: { generateText },
      onTrace: (event) => events.push(event.machineVersion),
    });

    expect(new Set(events)).toEqual(new Set(["1"]));
    expect(result.persist()).toEqual(expect.objectContaining({ version: "1" }));
  });

  test("the machine's own version is the single source (no machineVersion option)", async () => {
    const { generateText } = mockGenerateText();
    const events: string[] = [];
    await runAgent(machine, {
      input: { prompt: "hi" },
      executors: { generateText },
      onTrace: (event) => events.push(event.machineVersion),
    });
    expect(new Set(events)).toEqual(new Set(["1"]));
  });
});

describe("createSequentialMachine", () => {
  const machine = createSequentialMachine({
    model: "quick",
    steps: [
      { name: "outline", instructions: "Outline it." },
      { name: "draft", instructions: "Draft it." },
      {
        name: "polish",
        instructions: "Polish it.",
        prompt: ({ previous }) => `Polish: ${previous}`,
      },
    ],
  });

  test("chains each step's output into the next", async () => {
    const { generateText, requests } = mockGenerateText((request) => `${request.name}-output`);
    const result = await runAgent(machine, {
      input: { prompt: "a post about statecharts" },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output).toEqual({
      results: {
        outline: "outline-output",
        draft: "draft-output",
        polish: "polish-output",
      },
      output: "polish-output",
    });
    // Step 1 sees the machine prompt; each later step sees the previous output.
    expect(requests.map((request) => request.prompt)).toEqual([
      "a post about statecharts",
      "outline-output",
      "Polish: draft-output",
    ]);
    expect(requests.map((request) => request.system)).toEqual([
      "Outline it.",
      "Draft it.",
      "Polish it.",
    ]);
  });

  test("is stamped and lints clean", () => {
    expect((machine as { version?: string }).version).toBe("1");
    expect(lintErrors(machine)).toEqual([]);
  });

  test("rejects a step named after a preset state", () => {
    expect(() => createSequentialMachine({ model: "quick", steps: [{ name: "done" }] })).toThrow(
      /collides with a state/,
    );
  });
});

describe("createRouterMachine", () => {
  const machine = createRouterMachine({
    model: "quick",
    routes: {
      billing: { description: "Payments and invoices", instructions: "Answer the billing ask." },
      technical: { description: "Bugs and outages", instructions: "Answer the technical ask." },
    },
    fallback: "technical",
  });

  test("one decision picks a declared route and runs it", async () => {
    const { generateText, requests } = mockGenerateText(() => "refund issued");
    const { decide, requests: decisions } = mockDecide(["ROUTE_billing"]);
    const result = await runAgent(machine, {
      input: { prompt: "Where is my invoice?" },
      executors: { generateText, decide },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output).toEqual({
      route: "billing",
      result: "refund issued",
    });
    // Only the declared routes are candidates.
    expect(decisions[0]?.events.map((event) => event.type).sort()).toEqual([
      "ROUTE_billing",
      "ROUTE_technical",
    ]);
    expect(decisions[0]?.prompt).toContain("billing: Payments and invoices");
    expect(requests[0]?.system).toBe("Answer the billing ask.");
  });

  test("an undeclared route is never taken — the run falls back", async () => {
    const { generateText, requests } = mockGenerateText(() => "handled");
    const { decide } = mockDecide(["ROUTE_refunds"]);
    const result = await runAgent(machine, {
      input: { prompt: "Where is my invoice?" },
      executors: { generateText, decide },
    });

    // 'refunds' has no event, no state, and no transition: the decision is
    // rejected (and retried) until it is exhausted, then `fallback` runs.
    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output.route).toBe("technical");
    expect(requests[0]?.system).toBe("Answer the technical ask.");
  });

  test("without a fallback, an undeclared route errors the run instead", async () => {
    const strict = createRouterMachine({
      model: "quick",
      routes: { billing: { description: "Payments" }, technical: { description: "Bugs" } },
    });
    const { generateText } = mockGenerateText();
    const { decide } = mockDecide(["ROUTE_refunds"]);
    const result = await runAgent(strict, {
      input: { prompt: "Where is my invoice?" },
      executors: { generateText, decide },
    });

    expect(result.status).toBe("error");
    expect(result.status === "error" && String(result.error)).toMatch(/decision exhausted/i);
  });

  test("a child machine can back a route", async () => {
    const child = createToolLoopMachine({ model: "quick", instructions: "child" });
    const withChild = createRouterMachine({
      model: "quick",
      routes: {
        simple: { description: "one shot", instructions: "answer" },
        deep: { description: "delegate", machine: child },
      },
    });
    const { generateText } = mockGenerateText(() => "from child");
    const { decide } = mockDecide(["ROUTE_deep"]);
    const result = await runAgent(withChild, {
      input: { prompt: "hard one" },
      executors: { generateText, decide },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output).toEqual({
      route: "deep",
      result: { result: "from child" },
    });
  });

  test("is stamped and lints clean", () => {
    expect((machine as { version?: string }).version).toBe("1");
    expect(lintErrors(machine)).toEqual([]);
  });

  test("rejects a fallback that is not a route", () => {
    expect(() =>
      createRouterMachine({
        model: "quick",
        routes: { a: {} },
        // @ts-expect-error 'b' is not a declared route — the runtime check backs the type
        fallback: "b",
      }),
    ).toThrow(/fallback 'b' is not a declared route/);
  });
});

describe("createParallelMachine", () => {
  const machine = createParallelMachine({
    model: "quick",
    branches: {
      security: { instructions: "Security review." },
      performance: { instructions: "Performance review." },
    },
  });

  test("runs every branch and joins the results", async () => {
    const { generateText, requests } = mockGenerateText((request) => `${request.name}-review`);
    const result = await runAgent(machine, {
      input: { prompt: "review this diff" },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output).toEqual({
      results: { security: "security-review", performance: "performance-review" },
    });
    expect(requests).toHaveLength(2);
  });

  test("is stamped and lints clean", () => {
    expect((machine as { version?: string }).version).toBe("1");
    expect(lintErrors(machine)).toEqual([]);
  });
});

describe("createLoopMachine", () => {
  test("stops on the until predicate", async () => {
    const machine = createLoopMachine({
      model: "quick",
      body: { instructions: "Improve it." },
      until: ({ iterations }) => iterations >= 2,
      maxTurns: 10,
    });
    const { generateText } = mockGenerateText(() => "draft");
    const result = await runAgent(machine, {
      input: { prompt: "an essay" },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output).toEqual({
      iterations: 2,
      results: ["draft", "draft"],
      last: "draft",
    });
  });

  test("maxTurns bounds a predicate that never fires", async () => {
    const machine = createLoopMachine({
      model: "quick",
      body: { instructions: "Improve it.", prompt: ({ iterations }) => `round ${iterations}` },
      until: () => false,
      maxTurns: 3,
    });
    const { generateText, requests } = mockGenerateText(() => "draft");
    const result = await runAgent(machine, {
      input: { prompt: "an essay" },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output.iterations).toBe(3);
    expect(requests.map((request) => request.prompt)).toEqual(["round 0", "round 1", "round 2"]);
    expect((machine as { version?: string }).version).toBe("1");
    expect(lintErrors(machine)).toEqual([]);
  });

  test("rejects a non-positive maxTurns", () => {
    expect(() =>
      createLoopMachine({ model: "quick", body: {}, until: () => true, maxTurns: 0 }),
    ).toThrow(/maxTurns/);
  });
});

describe("createSupervisorMachine", () => {
  const machine = createSupervisorMachine({
    model: "quick",
    workers: {
      researcher: { description: "Facts", instructions: "Research it." },
      writer: { description: "Prose", instructions: "Write it." },
    },
    maxTurns: 4,
  });

  test("delegates, accumulates results, and finishes on FINISH", async () => {
    const { generateText } = mockGenerateText((request) => `${request.name}-result`);
    const { decide, requests: decisions } = mockDecide([
      "DELEGATE_researcher",
      "DELEGATE_writer",
      "FINISH",
    ]);
    const result = await runAgent(machine, {
      input: { task: "Announce the release." },
      executors: { generateText, decide },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output).toEqual({
      results: { researcher: "researcher-result", writer: "writer-result" },
      turns: 2,
    });
    // The supervisor sees the accumulated results on the next turn.
    expect(decisions[1]?.prompt).toContain("researcher: researcher-result");
    expect(decisions[0]?.events.map((event) => event.type)).toContain("FINISH");
  });

  test("maxTurns leaves FINISH as the only candidate", async () => {
    const bounded = createSupervisorMachine({
      model: "quick",
      workers: { researcher: { description: "Facts" } },
      maxTurns: 1,
    });
    const { generateText } = mockGenerateText(() => "notes");
    // A model that always tries to delegate. The bound must end the run anyway.
    const candidateSets: string[][] = [];
    const decide: AgentDecisionExecutor = async (request) => {
      const types = request.events.map((event) => event.type);
      candidateSets.push(types);
      return {
        event: { type: types.includes("DELEGATE_researcher") ? "DELEGATE_researcher" : types[0]! },
      };
    };

    const result = await runAgent(bounded, {
      input: { task: "one thing" },
      executors: { generateText, decide },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output.turns).toBe(1);
    // Turn 2: the budget is spent, so no DELEGATE_* is even offered.
    expect(candidateSets).toEqual([["DELEGATE_researcher", "FINISH"], ["FINISH"]]);
  });

  test("is stamped and lints clean", () => {
    expect((machine as { version?: string }).version).toBe("1");
    expect(lintErrors(machine)).toEqual([]);
  });
});

describe("createHandoffMachine", () => {
  const machine = createHandoffMachine({
    model: "quick",
    defaultActiveAgent: "travel",
    agents: {
      travel: { description: "Trips", instructions: "You are a travel concierge." },
      food: { description: "Food", instructions: "You are a food concierge." },
    },
  });

  test("transfers the mic and does not return", async () => {
    const { generateText, requests } = mockGenerateText((request) => `${request.name} says hi`);

    const first = await runAgent(machine, {
      input: { message: "3 days in Lisbon" },
      executors: { generateText },
    });
    expect(first.status).toBe("idle");
    if (first.status !== "idle") {
      throw new Error("unreachable");
    }
    expect(first.snapshot.context.activeAgent).toBe("travel");
    expect(first.snapshot.context.reply).toBe("travel says hi");

    const second = await runAgent(machine, {
      snapshot: first.persist(),
      event: { type: "transfer_to_food", message: "What should I eat?" },
      executors: { generateText },
    });
    expect(second.status).toBe("idle");
    if (second.status !== "idle") {
      throw new Error("unreachable");
    }
    // Control moved to the peer and stayed there — no return to `travel`.
    expect(second.snapshot.context.activeAgent).toBe("food");
    expect(second.snapshot.context.reply).toBe("food says hi");
    expect(second.snapshot.context.message).toBe("What should I eat?");
    expect(requests.map((request) => request.name)).toEqual(["travel", "food"]);
  });

  test("is stamped and lints clean", () => {
    expect((machine as { version?: string }).version).toBe("1");
    expect(lintErrors(machine)).toEqual([]);
  });

  test("rejects a default that is not a declared agent", () => {
    expect(() =>
      createHandoffMachine({
        agents: { a: { model: "quick" } },
        // @ts-expect-error 'b' is not a declared agent — the runtime check backs the type
        defaultActiveAgent: "b",
      }),
    ).toThrow(/defaultActiveAgent 'b' is not a declared agent/);
  });
});

describe("preset machine types", () => {
  const { generateText } = mockGenerateText();

  test("machine input is typed, not `any`", async () => {
    const machine = createToolLoopMachine({ model: "quick" });
    await expect(
      runAgent(machine, {
        // @ts-expect-error `prompt` is a string on this machine's input
        input: { prompt: 123 },
        executors: { generateText },
      }),
    ).rejects.toThrow();
  });

  test("machine output is typed", async () => {
    const machine = createLoopMachine({
      model: "quick",
      body: {},
      until: ({ iterations }) => iterations >= 1,
      maxTurns: 1,
    });
    const result = await runAgent(machine, {
      input: { prompt: "go" },
      executors: { generateText },
    });
    if (result.status === "done") {
      const iterations: number = result.output.iterations;
      expect(iterations).toBe(1);
      // @ts-expect-error `missing` is not part of the loop output
      expect(result.output.missing).toBeUndefined();
    }
  });

  test("route and transfer events are typed from the declared keys", async () => {
    const handoff = createHandoffMachine({
      model: "quick",
      defaultActiveAgent: "travel",
      agents: { travel: {}, food: {} },
    });
    const first = await runAgent(handoff, {
      input: { message: "hi" },
      executors: { generateText },
    });
    await expect(
      runAgent(handoff, {
        snapshot: first.persist(),
        // @ts-expect-error 'transfer_to_nope' is not a declared agent transfer
        event: { type: "transfer_to_nope" },
        executors: { generateText },
      }),
    ).rejects.toThrow(/cannot resume with event 'transfer_to_nope'/);
  });
});
