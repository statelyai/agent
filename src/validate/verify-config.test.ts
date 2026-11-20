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
    schemas: {
      events: {
        APPROVE: { type: "object", properties: {} },
        DENY: { type: "object", properties: {} },
      },
    },
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

  test('lint: a decision that lists an `actor: "human"` event fails', async () => {
    const config = refundConfig();
    config.states.triage.on.APPROVE.meta = { actor: "human" };
    const result = await verifyAgentConfig(config, options());
    expect(result.gates.at(-1)).toMatchObject({ name: "lint", ok: false });
    expect(result.gates.at(-1)!.detail).toContain("decide-allows-human-event at 'triage'");
  });

  test("lint: warnings are recorded by default and fail with `warnings: true`", async () => {
    const config = refundConfig();
    delete config.states.triage.invoke.onError;
    delete config.states.failed;
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
    // Without the allowance, the lint gate stops it first (state-cannot-finish).
    const lint = { terminalStates: ["approved"] };
    expect((await verifyAgentConfig(config, options())).gates.at(-1)!.detail).toContain(
      "state-cannot-finish at 'approved'",
    );
    const result = await verifyAgentConfig(config, options({ lint }));
    expect(result.gates.at(-1)).toMatchObject({ name: "explore", ok: false });
    expect(result.gates.at(-1)!.detail).toContain(
      "input 0: path [APPROVE] ends 'idle' in state \"approved\"; every path must end 'done'",
    );

    const idleAllowed = await verifyAgentConfig(
      config,
      options({ lint, explore: { inputs: [{ amount: 5 }], terminals: ["done", "idle"] } }),
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
      "a cap (maxPaths 10000 or maxNodes 1) cut exploration short",
    );
  });

  test("explore: an exhausted budget fails and surfaces its note", async () => {
    const result = await verifyAgentConfig(
      refundConfig(),
      options({ explore: { inputs: [{ amount: 5 }], budget: { nodes: 1 } } }),
    );
    expect(result.gates.at(-1)).toMatchObject({ name: "explore", ok: false });
    expect(result.gates.at(-1)!.detail).toMatch(
      /the explore budget ran out \(budget-exhausted: nodes \(1 nodes expanded in \d+ ms, child searches included\)\); exploration is incomplete/,
    );
    expect(result.gates.at(-1)!.detail).not.toContain("a cap (maxPaths");
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
    config.schemas.events.RETRY = { type: "object", properties: {} };
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

describe("verifyAgentConfig decide strategies", () => {
  const strategyConfig = (input: Record<string, unknown>) => {
    const config = refundConfig();
    config.schemas = {
      events: {
        APPROVE: {
          type: "object",
          properties: { note: { type: "string" } },
          required: ["note"],
        },
        DENY: {
          type: "object",
          properties: { final: { type: "boolean" } },
          required: ["final"],
        },
      },
    };
    Object.assign(config.states.triage.invoke.input, input);
    return config;
  };
  const lowerGate = async (input: Record<string, unknown>) =>
    (await verifyAgentConfig(strategyConfig(input), options({ explore: undefined }))).gates.find(
      (gate) => gate.name === "lower",
    );

  test("pick-then-fill over an open payload without fillModel fails the lower gate", async () => {
    expect(await lowerGate({ strategy: "pick-then-fill" })).toEqual({
      name: "lower",
      ok: false,
      detail:
        "state 'triage': agent.decide uses strategy 'pick-then-fill' but APPROVE has open payload fields and no fillModel is set",
    });
  });

  test("omitted allowedEvents checks the lowered state's accepted events", async () => {
    const config = strategyConfig({ strategy: "pick-then-fill" });
    delete config.states.triage.invoke.input.allowedEvents;
    const result = await verifyAgentConfig(
      config,
      options({ allow: undefined, explore: undefined }),
    );
    expect(result.gates.find((gate) => gate.name === "lower")).toEqual({
      name: "lower",
      ok: false,
      detail:
        "state 'triage': agent.decide uses strategy 'pick-then-fill' but APPROVE has open payload fields and no fillModel is set",
    });
  });

  test("omitted allowedEvents skips human events", async () => {
    const config = strategyConfig({ strategy: "pick-then-fill" });
    delete config.states.triage.invoke.input.allowedEvents;
    config.states.triage.on.APPROVE = { target: "approved", meta: { actor: "human" } };
    const result = await verifyAgentConfig(
      config,
      options({ allow: undefined, explore: undefined }),
    );
    expect(result.gates.find((gate) => gate.name === "lower")).toEqual({ name: "lower", ok: true });
  });

  test("pick-then-fill with a fillModel, or over finite payloads, passes", async () => {
    expect(await lowerGate({ strategy: "pick-then-fill", fillModel: MODEL })).toEqual({
      name: "lower",
      ok: true,
    });
    const config = strategyConfig({ strategy: "pick-then-fill", allowedEvents: ["DENY"] });
    const result = await verifyAgentConfig(config, options({ explore: undefined }));
    expect(result.gates.find((gate) => gate.name === "lower")).toEqual({ name: "lower", ok: true });
  });
});

describe("verifyAgentConfig config graph checks", () => {
  const empty = { type: "object", properties: {} };
  const fin = { type: "final" };
  const lintGate = (result: { gates: Array<{ name: string; ok: boolean; detail?: string }> }) =>
    result.gates.find((gate) => gate.name === "lint");

  /** A password reset (trial S1): wait for a code, or expire. */
  function resetConfig() {
    return {
      initial: "awaitingCode",
      schemas: { events: { CODE_ENTERED: empty } },
      states: {
        awaitingCode: {
          on: { CODE_ENTERED: { target: "verified" } },
          after: { "600000": { target: "expired" } },
        },
        verified: fin,
        expired: fin,
      },
    } as Record<string, any>;
  }

  test("unreachable-state: a state nothing targets fails lint (S1)", async () => {
    expect(
      (await verifyAgentConfig(resetConfig(), { compileSchema, explore: { inputs: [{}] } })).ok,
    ).toBe(true);

    const config = resetConfig();
    config.states.locked = { on: { UNLOCK: { target: "awaitingCode" } } };
    config.schemas.events.UNLOCK = empty;
    const result = await verifyAgentConfig(config, { compileSchema, explore: { inputs: [{}] } });
    expect(result.gates.at(-1)).toMatchObject({ name: "lint", ok: false });
    expect(result.gates.at(-1)!.detail).toBe(
      "error unreachable-state at 'locked': State 'locked' is unreachable: it is not an initial " +
        "state, and no transition from a reachable state targets it. Add a transition that " +
        "targets 'locked', or delete the state.",
    );
  });

  test("unreachable-state: a state targeted only from an unreachable state is reported too", async () => {
    const config = resetConfig();
    config.states.locked = { on: { UNLOCK: { target: "unlocked" } } };
    config.states.unlocked = fin;
    config.schemas.events.UNLOCK = empty;
    const detail = lintGate(await verifyAgentConfig(config, { compileSchema }))!.detail!;
    expect(detail).toContain("unreachable-state at 'locked'");
    expect(detail).toContain("unreachable-state at 'unlocked'");
  });

  test("unreachable-state: nested initials, child targets, and onDone targets count as reached", async () => {
    const config = {
      initial: "work",
      states: {
        work: {
          initial: "a",
          states: {
            a: { always: { target: "b" }, after: { "1000": { target: "b.inner" } } },
            b: {
              initial: "x",
              states: { x: { always: { target: "inner" } }, inner: fin },
              onDone: { target: "c" },
            },
            c: fin,
          },
          onDone: { target: "finishing" },
        },
        finishing: { always: { target: "done" } },
        done: fin,
      },
    };
    const result = await verifyAgentConfig(config, { compileSchema });
    expect(lintGate(result)).toEqual({ name: "lint", ok: true });
  });

  /** A support chat (trial S6): answer, or hand off to a person who resolves it. */
  function chatConfig() {
    return {
      initial: "answering",
      schemas: {
        events: { ANSWER: empty, HAND_OFF: empty, HUMAN_REPLY: empty, HUMAN_RESOLVED: empty },
      },
      states: {
        answering: {
          invoke: {
            src: "agent.decide",
            input: {
              model: MODEL,
              prompt: "Answer or hand off.",
              allowedEvents: ["ANSWER", "HAND_OFF"],
            },
            onError: { target: "withHuman" },
          },
          on: { ANSWER: { target: "closed" }, HAND_OFF: { target: "withHuman" } },
        },
        withHuman: {
          on: {
            HUMAN_REPLY: { target: "withHuman", meta: { actor: "human" } },
            HUMAN_RESOLVED: { target: "closed", meta: { actor: "human" } },
          },
        },
        closed: fin,
      },
    } as Record<string, any>;
  }
  // The legitimate HUMAN_REPLY loop needs dedupeBy to pass explore.
  const dedupedExplore = {
    inputs: [{}],
    dedupeBy: (snapshot: { value: unknown }) => JSON.stringify(snapshot.value),
  };

  test("state-cannot-finish: a loop with no path to a final state fails lint (S6)", async () => {
    expect(
      (await verifyAgentConfig(chatConfig(), { compileSchema, explore: dedupedExplore })).ok,
    ).toBe(true);

    const config = chatConfig();
    delete config.states.withHuman.on.HUMAN_RESOLVED;
    const result = await verifyAgentConfig(config, { compileSchema, explore: dedupedExplore });
    expect(result.gates.at(-1)).toMatchObject({ name: "lint", ok: false });
    expect(result.gates.at(-1)!.detail).toBe(
      "error state-cannot-finish at 'withHuman': State 'withHuman' can never reach a final " +
        "state: no path of transitions from it (events, 'after', 'always', choice branches, " +
        "invoke 'onDone'/'onError') leads to one, so a run that enters it never finishes. Add a " +
        "transition from it toward a final state, or list it in lint.terminalStates if it waits " +
        "forever on purpose.",
    );
  });

  test("state-cannot-finish: lint.terminalStates allows a state that waits on purpose", async () => {
    const config = chatConfig();
    delete config.states.withHuman.on.HUMAN_RESOLVED;
    const result = await verifyAgentConfig(config, {
      compileSchema,
      lint: { terminalStates: ["withHuman"] },
      explore: { ...dedupedExplore, terminals: ["done", "idle"] },
    });
    expect(result.ok).toBe(true);
  });

  test("state-cannot-finish: a config with no final state is a service and is not checked", async () => {
    const config = chatConfig();
    delete config.states.withHuman.on.HUMAN_RESOLVED;
    config.states.closed = { on: { HUMAN_REPLY: { target: "withHuman" } } };
    const result = await verifyAgentConfig(config, { compileSchema });
    expect(lintGate(result)).toEqual({ name: "lint", ok: true });
  });

  test("state-cannot-finish: a parallel region that never completes is named; a sound one passes", async () => {
    const region = (work: string, finished: Record<string, unknown>) => ({
      initial: "working",
      states: {
        working: {
          invoke: { src: work, onDone: { target: "finished" }, onError: { target: "finished" } },
        },
        finished,
      },
    });
    const orderConfig = (fraudFinished: Record<string, unknown>) => ({
      initial: "fulfilling",
      actors: { pack: {}, checkFraud: {} },
      states: {
        fulfilling: {
          type: "parallel",
          states: { packing: region("pack", fin), fraud: region("checkFraud", fraudFinished) },
          onDone: { target: "shipped" },
        },
        shipped: fin,
      },
    });
    expect(lintGate(await verifyAgentConfig(orderConfig(fin), { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
    const detail = lintGate(await verifyAgentConfig(orderConfig({}), { compileSchema }))!.detail!;
    expect(detail).toContain("state-cannot-finish at 'fulfilling.fraud.finished'");
    expect(detail).not.toContain("fulfilling.packing");
  });

  test("state-cannot-finish: an ancestor's transition counts as a way out", async () => {
    const config = {
      initial: "session",
      schemas: { events: { NEXT: empty, QUIT: empty } },
      states: {
        session: {
          initial: "looping",
          states: { looping: { on: { NEXT: { target: "looping", reenter: true } } } },
          on: { QUIT: { target: "done" } },
        },
        done: fin,
      },
    };
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });

  /** A lead qualification (trial S4): the decided payload is assigned to context. */
  function leadConfig() {
    const scored = {
      type: "object",
      properties: { score: { type: "number" } },
      required: ["score"],
    };
    return {
      initial: "scoring",
      schemas: { events: { HOT: scored, COLD: scored } },
      states: {
        scoring: {
          invoke: {
            src: "agent.decide",
            input: { model: MODEL, prompt: "Score the lead.", allowedEvents: ["HOT", "COLD"] },
            onError: { target: "done" },
          },
          on: {
            HOT: { target: "done", assign: { score: "{{ event.score }}" } },
            COLD: { target: "done", assign: { score: "{{ event.score }}" } },
          },
        },
        done: fin,
      },
    } as Record<string, any>;
  }
  const leadExplore = {
    inputs: [{}],
    payloads: () => ({ HOT: [{ score: 9 }], COLD: [{ score: 1 }] }),
  };

  test("decide-event-without-schema: a decision event with no payload schema fails lint (S4)", async () => {
    expect(
      (await verifyAgentConfig(leadConfig(), { compileSchema, explore: leadExplore })).ok,
    ).toBe(true);

    const config = leadConfig();
    delete config.schemas.events.HOT;
    const result = await verifyAgentConfig(config, { compileSchema, explore: leadExplore });
    expect(result.gates.at(-1)).toMatchObject({ name: "lint", ok: false });
    expect(result.gates.at(-1)!.detail).toBe(
      "error decide-event-without-schema at 'scoring': State 'scoring' lets agent.decide send " +
        "'HOT', but schemas.events has no 'HOT' entry, so the payload the model sends reaches the " +
        "machine unvalidated. Add schemas.events.HOT (use " +
        '{ "type": "object", "properties": {} } for an event with no payload).',
    );
  });

  test("decide-event-without-schema: omitted allowedEvents checks every handled non-human event", async () => {
    const config = leadConfig();
    delete config.states.scoring.invoke.input.allowedEvents;
    delete config.schemas.events.HOT;
    config.states.scoring.on.SKIP = { target: "done", meta: { actor: "human" } };
    const detail = lintGate(await verifyAgentConfig(config, { compileSchema }))!.detail!;
    expect(detail).toContain("decide-event-without-schema at 'scoring'");
    expect(detail).toContain("send 'HOT'");
    expect(detail).not.toContain("'SKIP'");
  });

  test("decide-event-without-schema: an event the decide input lists payloads for passes", async () => {
    const config = leadConfig();
    delete config.schemas.events.HOT;
    config.states.scoring.invoke.input.payloads = { HOT: [{ score: 9 }] };
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });

  /** A content moderation (trial S8): the model labels a post. */
  function moderationConfig() {
    return {
      initial: "labeling",
      schemas: { events: { ALLOW: empty, REMOVE: empty, RESTORE: empty } },
      states: {
        labeling: {
          invoke: {
            src: "agent.decide",
            input: { model: MODEL, prompt: "Label the post.", allowedEvents: ["ALLOW", "REMOVE"] },
            onError: { target: "removed" },
          },
          on: { ALLOW: { target: "allowed" }, REMOVE: { target: "removed" } },
        },
        allowed: fin,
        removed: fin,
      },
    } as Record<string, any>;
  }

  test("decide-event-unhandled: an allowedEvents entry no state handles fails lint (S8)", async () => {
    expect(
      (await verifyAgentConfig(moderationConfig(), { compileSchema, explore: { inputs: [{}] } }))
        .ok,
    ).toBe(true);

    const config = moderationConfig();
    config.states.labeling.invoke.input.allowedEvents.push("RESTORE");
    const result = await verifyAgentConfig(config, { compileSchema, explore: { inputs: [{}] } });
    expect(result.gates.at(-1)).toMatchObject({ name: "lint", ok: false });
    expect(result.gates.at(-1)!.detail).toBe(
      "error decide-event-unhandled at 'labeling': State 'labeling' lists 'RESTORE' in " +
        "agent.decide allowedEvents, but neither 'labeling' nor an ancestor handles it, so the " +
        "model is never offered it. Add an 'on.RESTORE' transition, or remove 'RESTORE' from " +
        "allowedEvents.",
    );
  });

  test("decide-event-unhandled: a handler on an ancestor or a wildcard counts", async () => {
    const config = {
      id: "mod",
      initial: "review",
      schemas: { events: { ALLOW: empty, "mod.flag": empty } },
      states: {
        review: {
          initial: "labeling",
          on: { ALLOW: { target: "allowed" }, "mod.*": { target: "allowed" } },
          states: {
            labeling: {
              invoke: {
                src: "agent.decide",
                input: { model: MODEL, prompt: "Label.", allowedEvents: ["ALLOW", "mod.flag"] },
                onError: { target: "#mod.allowed" },
              },
            },
          },
        },
        allowed: fin,
      },
    };
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });
});

test("verifyAgentConfig returns one explore report per input", async () => {
  const result = await verifyAgentConfig(refundConfig(), options());
  expect(result.ok).toBe(true);
  expect(result.explore).toHaveLength(2);
  expect(result.explore![0]!.terminals.map((t) => t.state)).toContain("approved");
  expect(result.explore![1]!.terminals.map((t) => t.state)).toEqual(["denied"]);
});
