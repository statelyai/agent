import Ajv from "ajv";
import { describe, expect, test } from "vitest";
import { createAsyncLogic } from "xstate";
import type { SchemaCompiler, StandardSchemaV1 } from "../index.js";
import { verifyAgentConfig, type VerifyAgentConfigOptions } from "./index.js";

// The Ajv-to-StandardSchema recipe from examples/json-agent.
const ajv = new Ajv({ strict: false });
const compileSchema: SchemaCompiler = (jsonSchema, name): StandardSchemaV1 => {
  const validateFn = ajv.compile(jsonSchema);
  return {
    "~standard": {
      version: 1,
      vendor: "ajv",
      validate: (value: unknown) =>
        validateFn(value)
          ? { value }
          : {
              issues: (validateFn.errors ?? []).map((error) => ({
                message: `${name}${error.instancePath} ${error.message}`,
              })),
            },
      jsonSchema: { input: () => jsonSchema },
    },
  };
};

const MODEL = "openai/gpt-6-luna";

/** A refund triage: a named guard, then a decision over APPROVE/DENY. */
function refundConfig() {
  return {
    initial: "check",
    context: { amount: "{{ input.amount }}" },
    states: {
      check: {
        choice: [{ guard: "isLarge", target: "denied" }, { target: "triage" }],
        type: "choice",
      },
      triage: {
        invoke: {
          src: "agent.decide",
          input: {
            model: MODEL,
            prompt: "Refund {{ context.amount }}?",
            allowedEvents: ["APPROVE", "DENY"],
          },
          onError: { target: "failed" },
        },
        on: { APPROVE: { target: "approved" }, DENY: { target: "denied" } },
      },
      approved: { type: "final" },
      denied: { type: "final" },
      failed: { type: "final" },
    },
  } as Record<string, any>;
}

const options = (overrides: Partial<VerifyAgentConfigOptions> = {}): VerifyAgentConfigOptions => ({
  compileSchema,
  guards: { isLarge: ({ context }) => context.amount > 100 },
  allow: {
    guards: ["isLarge"],
    actions: [],
    actors: [],
    requests: [],
    events: ["APPROVE", "DENY"],
    models: [MODEL],
  },
  explore: { inputs: [{ amount: 5 }, { amount: 500 }] },
  ...overrides,
});

const gateNames = (result: { gates: Array<{ name: string }> }) => result.gates.map((g) => g.name);

describe("verifyAgentConfig", () => {
  test("a good config passes every gate", async () => {
    const result = await verifyAgentConfig(refundConfig(), options());
    expect(result.gates).toEqual([
      { name: "validate", ok: true },
      { name: "vocabulary", ok: true },
      { name: "lower", ok: true },
      { name: "lint", ok: true },
      { name: "explore", ok: true },
    ]);
    expect(result.ok).toBe(true);
    expect(result.machine).toBeDefined();
    expect(result.config?.initial).toBe("check");
  });

  test("skips the vocabulary and explore gates when not configured", async () => {
    const result = await verifyAgentConfig(refundConfig(), {
      compileSchema,
      guards: { isLarge: () => false },
    });
    expect(result.ok).toBe(true);
    expect(gateNames(result)).toEqual(["validate", "lower", "lint"]);
  });

  test("validate: a bad shape fails with its JSON Pointer and stops", async () => {
    const config = refundConfig();
    config.states.triage.invoke.bogus = true;
    const result = await verifyAgentConfig(config, options());
    expect(result.ok).toBe(false);
    expect(gateNames(result)).toEqual(["validate"]);
    expect(result.gates[0]!.detail).toContain("/states/triage/invoke");
    expect(result.config).toBeUndefined();
    expect(result.machine).toBeUndefined();
  });

  test("vocabulary: an unknown actor src is named with its state", async () => {
    const config = refundConfig();
    config.states.triage.invoke = {
      src: "lookupOrder",
      onDone: { target: "approved" },
      onError: { target: "failed" },
    };
    const result = await verifyAgentConfig(config, options());
    expect(gateNames(result)).toEqual(["validate", "vocabulary"]);
    expect(result.gates[1]!.ok).toBe(false);
    expect(result.gates[1]!.detail).toContain("state 'triage' invokes unknown src 'lookupOrder'");
    expect(result.config).toBeDefined();
    expect(result.machine).toBeUndefined();
  });

  test("vocabulary: a decide event outside `events` is named", async () => {
    const config = refundConfig();
    config.states.triage.invoke.input.allowedEvents = ["APPROVE", "ESCALATE"];
    config.states.triage.on.ESCALATE = { target: "denied" };
    const result = await verifyAgentConfig(config, options());
    expect(result.gates.at(-1)).toMatchObject({ name: "vocabulary", ok: false });
    expect(result.gates.at(-1)!.detail).toContain(
      "state 'triage': agent.decide allowedEvents entry 'ESCALATE' is not allowed",
    );
  });

  test("vocabulary: guards, actions, and models outside the lists are named", async () => {
    const config = refundConfig();
    config.states.check.choice[0].guard = "isHuge";
    config.states.approved.entry = { type: "notify" };
    config.states.triage.invoke.input.model = "{{ context.model }}";
    const result = await verifyAgentConfig(config, options());
    const detail = result.gates.at(-1)!.detail!;
    expect(detail).toContain("state 'check' uses unknown named guard 'isHuge'");
    expect(detail).toContain("state 'approved' entry uses unknown named action 'notify'");
    expect(detail).toContain("state 'triage': 'agent.decide' needs a literal string model ref");
  });

  test("vocabulary: a raw '@expr' input cannot smuggle a model or events past the lists", async () => {
    const config = refundConfig();
    // xstate evaluates any object with an `@expr` key as an expression, so the
    // literal siblings the lists check never reach the actor.
    config.states.triage.invoke.input = {
      "@expr": JSON.stringify({
        model: "other/model",
        prompt: "Refund?",
        allowedEvents: ["APPROVE", "DENY", "ESCALATE"],
      }),
      ...config.states.triage.invoke.input,
    };
    const result = await verifyAgentConfig(config, options());
    expect(result.gates.at(-1)).toMatchObject({ name: "vocabulary", ok: false });
    expect(result.gates.at(-1)!.detail).toContain(
      "states.triage.invoke.input uses a raw '@expr' slot",
    );
  });

  test("vocabulary: an undeclared src never lowers, with or without `actors` listed", async () => {
    const config = refundConfig();
    config.states.triage.invoke = {
      src: "sendEmail",
      onDone: { target: "approved" },
      onError: { target: "failed" },
    };
    const result = await verifyAgentConfig(
      config,
      options({
        allow: { requests: ["draftReply"] },
        actors: { sendEmail: createAsyncLogic({ run: async () => "sent" }) },
      }),
    );
    expect(result.gates.at(-1)).toMatchObject({ name: "lower", ok: false });
    expect(result.gates.at(-1)!.detail).toContain('Missing actor source "sendEmail"');
  });

  test("lower: an unresolved guard is reported, not thrown", async () => {
    const config = refundConfig();
    config.states.check.choice[0].guard = "isHuge";
    const result = await verifyAgentConfig(config, options({ allow: undefined }));
    expect(gateNames(result)).toEqual(["validate", "lower"]);
    expect(result.gates[1]!.ok).toBe(false);
    expect(result.gates[1]!.detail).toContain("isHuge");
    expect(result.machine).toBeUndefined();
  });

  test("lint: an error finding fails and names the state", async () => {
    const config = refundConfig();
    delete config.states.triage.on;
    const result = await verifyAgentConfig(config, options());
    expect(result.gates.at(-1)).toMatchObject({ name: "lint", ok: false });
    expect(result.gates.at(-1)!.detail).toContain("decide-without-events at 'triage'");
    expect(result.machine).toBeDefined();
  });

  test("lint: warnings are recorded by default and fail with `warnings: true`", async () => {
    const config = refundConfig();
    delete config.states.triage.invoke.onError;
    const recorded = await verifyAgentConfig(config, options());
    expect(recorded.ok).toBe(true);
    expect(recorded.gates[3]).toMatchObject({ name: "lint", ok: true });
    expect(recorded.gates[3]!.detail).toContain("invoke-without-on-error at 'triage'");

    const strict = await verifyAgentConfig(config, options({ lint: { warnings: true } }));
    expect(strict.gates.at(-1)).toMatchObject({ name: "lint", ok: false });
  });

  test("explore: a path ending idle fails when terminals is ['done']", async () => {
    const config = refundConfig();
    config.states.approved = { description: "waits forever" };
    const result = await verifyAgentConfig(config, options());
    expect(result.gates.at(-1)).toMatchObject({ name: "explore", ok: false });
    expect(result.gates.at(-1)!.detail).toContain(
      "input 0: path [APPROVE] ends 'idle' in state \"approved\"; every path must end 'done'",
    );

    const idleAllowed = await verifyAgentConfig(
      config,
      options({ explore: { inputs: [{ amount: 5 }], terminals: ["done", "idle"] } }),
    );
    expect(idleAllowed.ok).toBe(true);
  });

  test("explore: an empty inputs list fails instead of passing vacuously", async () => {
    const result = await verifyAgentConfig(refundConfig(), options({ explore: { inputs: [] } }));
    expect(result.gates.at(-1)).toMatchObject({ name: "explore", ok: false });
    expect(result.gates.at(-1)!.detail).toContain("explore.inputs is empty");
  });

  test("explore: a node cap that cuts exploration short names both caps", async () => {
    const result = await verifyAgentConfig(
      refundConfig(),
      options({ explore: { inputs: [{ amount: 5 }], maxNodes: 1 } }),
    );
    expect(result.gates.at(-1)).toMatchObject({ name: "explore", ok: false });
    expect(result.gates.at(-1)!.detail).toContain(
      "a cap (maxPaths 200 or maxNodes 1) cut exploration short",
    );
  });

  test("explore: an event whose payloads were not all tried fails and names it", async () => {
    const config = refundConfig();
    config.schemas = {
      input: { type: "object", properties: { amount: { type: "number" } } },
      events: {
        APPROVE: {
          type: "object",
          properties: { note: { type: "string" } },
          required: ["note"],
        },
        DENY: { type: "object", properties: {} },
      },
    };
    const result = await verifyAgentConfig(config, options());
    expect(result.gates.at(-1)).toMatchObject({ name: "explore", ok: false });
    expect(result.gates.at(-1)!.detail).toContain(
      "explore did not try every payload of: APPROVE; add explore.payloads entries for them",
    );

    const covered = await verifyAgentConfig(
      config,
      options({
        explore: { inputs: [{ amount: 5 }], payloads: () => ({ APPROVE: [{ note: "ok" }] }) },
      }),
    );
    expect(covered.ok).toBe(true);
  });

  test("explore: a loop that hits maxDepth fails and says so", async () => {
    const config = refundConfig();
    config.states.triage.invoke.input.allowedEvents = ["APPROVE", "DENY", "RETRY"];
    config.states.triage.on.RETRY = { target: "triage", reenter: true };
    const result = await verifyAgentConfig(
      config,
      options({
        allow: { events: ["APPROVE", "DENY", "RETRY"] },
        explore: { inputs: [{ amount: 5 }], maxDepth: 3 },
      }),
    );
    expect(result.gates.at(-1)).toMatchObject({ name: "explore", ok: false });
    expect(result.gates.at(-1)!.detail).toMatch(/path \[RETRY, RETRY, RETRY\] hit maxDepth 3/);
  });
});
