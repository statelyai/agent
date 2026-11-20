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

  test("decide-event-unhandled: a handler on an ancestor counts; a wildcard handler does not admit an exact entry", async () => {
    const config = {
      id: "mod",
      initial: "review",
      schemas: { events: { ALLOW: empty, "mod.flag": empty } },
      states: {
        review: {
          initial: "labeling",
          on: {
            ALLOW: { target: "allowed" },
            "mod.*": { target: "allowed" },
          } as Record<string, unknown>,
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
    // The runtime offers the 'mod.*' descriptor only to an entry it matches,
    // and 'mod.*' does not match the exact entry 'mod.flag'.
    const detail = lintGate(await verifyAgentConfig(config, { compileSchema }))!.detail!;
    expect(detail).toContain("decide-event-unhandled at 'review.labeling'");
    expect(detail).toContain("lists 'mod.flag'");
    expect(detail).not.toContain("lists 'ALLOW'");

    config.states.review.on["mod.flag"] = { target: "allowed" };
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });
  test("decide-event-unhandled: a templated allowedEvents is not read as an event name", async () => {
    const config = (allowedEvents: unknown) => ({
      initial: "triage",
      schemas: { events: { APPROVE: empty } },
      states: {
        triage: {
          invoke: {
            src: "agent.decide",
            input: { model: MODEL, prompt: "Decide.", allowedEvents },
            onError: { target: "done" },
          },
          on: { APPROVE: { target: "done" } },
        },
        done: fin,
      },
    });
    for (const allowedEvents of ["{{ input.events }}", ["APPROVE", "{{ input.extra }}"]]) {
      expect(lintGate(await verifyAgentConfig(config(allowedEvents), { compileSchema }))).toEqual({
        name: "lint",
        ok: true,
      });
    }
    // A templated payloads list may close the choice; it is unknown here.
    const templatedPayloads = config(["APPROVE"]);
    delete (templatedPayloads.schemas.events as Record<string, unknown>).APPROVE;
    Object.assign(templatedPayloads.states.triage.invoke.input, {
      payloads: "{{ input.payloads }}",
    });
    expect(lintGate(await verifyAgentConfig(templatedPayloads, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });

  test("decide-event-without-schema: a wildcard allowedEvents entry checks the events it admits", async () => {
    const config = {
      initial: "routing",
      schemas: { events: { "desk.assign": empty } as Record<string, unknown> },
      states: {
        routing: {
          invoke: {
            src: "agent.decide",
            input: { model: MODEL, prompt: "Route.", allowedEvents: ["desk.*"] },
            onError: { target: "done" },
          },
          on: { "desk.assign": { target: "done" }, "desk.close": { target: "done" } },
        },
        done: fin,
      },
    };
    const detail = lintGate(await verifyAgentConfig(config, { compileSchema }))!.detail!;
    expect(detail).toContain("decide-event-without-schema at 'routing'");
    expect(detail).toContain("send 'desk.close'");
    expect(detail).not.toContain("send 'desk.assign'");

    config.schemas.events["desk.close"] = empty;
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });

  test("unreachable-state: entering one parallel region enters its sibling regions", async () => {
    const config = {
      id: "m",
      initial: "idle",
      schemas: { events: { GO: empty, FINISH: empty, STOP: empty } },
      states: {
        idle: { on: { GO: { target: "job.worker" } } },
        job: {
          type: "parallel",
          states: {
            worker: {
              initial: "running",
              states: { running: { on: { FINISH: { target: "#m.done" } } } },
            },
            monitor: {
              initial: "watching",
              states: { watching: { on: { STOP: { target: "#m.done" } } } },
            },
          },
        },
        done: fin,
      },
    };
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });

  test("state-cannot-finish: a sibling region's exit from the parallel state counts as a way out", async () => {
    const config = {
      id: "job",
      initial: "running",
      schemas: { events: { FINISH: empty } },
      states: {
        running: {
          type: "parallel",
          states: {
            worker: {
              initial: "working",
              states: { working: { on: { FINISH: { target: "#job.done" } } } },
            },
            monitor: {},
          },
        },
        done: fin,
      },
    };
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });

  test("state-cannot-finish: completion propagates through nested parallel states", async () => {
    const region = { initial: "finished", states: { finished: fin } };
    const config = {
      initial: "outer",
      states: {
        outer: {
          type: "parallel",
          onDone: { target: "done" },
          states: {
            inner: {
              type: "parallel",
              states: {
                left: {
                  initial: "working",
                  states: { working: { after: { "10": { target: "finished" } } }, finished: fin },
                },
                right: region,
              },
            },
            other: region,
          },
        },
        done: fin,
      },
    };
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });

  test("state-cannot-finish: a transition that resets to the root counts as a way out", async () => {
    const config = {
      id: "retry",
      initial: "trying",
      schemas: { events: { OK: empty, FAIL: empty } },
      states: {
        trying: { on: { OK: { target: "done" }, FAIL: { target: "failed" } } },
        failed: { after: { "1000": { target: "#retry" } } },
        done: fin,
      },
    };
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });

  test("decide-event-without-schema: an event with any human-tagged branch is not a candidate", async () => {
    const config = leadConfig();
    delete config.states.scoring.invoke.input.allowedEvents;
    config.states.scoring.on.SKIP = [
      { guard: "{{ context.manual }}", target: "done", meta: { actor: "human" } },
      { target: "done" },
    ];
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });

  test("decide-event-unhandled: a handler in a sibling parallel region counts", async () => {
    const config = {
      id: "desk",
      initial: "open",
      schemas: { events: { ESCALATE: empty, DONE: empty } },
      states: {
        open: {
          type: "parallel",
          states: {
            agent: {
              invoke: {
                src: "agent.decide",
                input: { model: MODEL, prompt: "Escalate?", allowedEvents: ["ESCALATE"] },
                onError: { target: "#desk.closed" },
              },
              on: { DONE: { target: "#desk.closed" } },
            },
            supervisor: { on: { ESCALATE: { target: "#desk.closed" } } },
          },
        },
        closed: fin,
      },
    };
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });

  test("unreachable-state: a transition into one region's child does not default-enter that region", async () => {
    const config = {
      id: "m",
      initial: "idle",
      schemas: { events: { GO: empty, NEXT: empty, FINISH: empty, STOP: empty } },
      states: {
        idle: { on: { GO: { target: "job.worker.ready" } } },
        job: {
          type: "parallel",
          states: {
            worker: {
              initial: "starting",
              states: {
                starting: { on: { NEXT: { target: "ready" } } },
                ready: { on: { FINISH: { target: "#m.done" } } },
              },
            },
            monitor: {
              initial: "watching",
              states: { watching: { on: { STOP: { target: "#m.done" } } } },
            },
          },
        },
        done: fin,
      },
    };
    const detail = lintGate(await verifyAgentConfig(config, { compileSchema }))!.detail!;
    expect(detail).toContain("unreachable-state at 'job.worker.starting'");
    expect(detail).not.toContain("'job.monitor");

    // Targeting the region itself still enters its initial child.
    config.states.idle.on.GO.target = "job.worker";
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });
  });

  test("state-cannot-finish: a sibling region's move into a third region is no way out", async () => {
    const config = {
      id: "m",
      initial: "p",
      schemas: { events: { A_DONE: empty, JUMP: empty } },
      states: {
        p: {
          type: "parallel",
          onDone: { target: "done" },
          states: {
            a: {
              initial: "working",
              states: { working: { on: { A_DONE: { target: "finished" } } }, finished: fin },
            },
            b: {
              initial: "idle",
              states: { idle: { on: { JUMP: { target: "#m.p.a.finished" } } } },
            },
            c: {
              initial: "stuck",
              states: { stuck: {} } as Record<string, unknown>,
            },
          },
        },
        done: fin,
      },
    };
    const detail = lintGate(await verifyAgentConfig(config, { compileSchema }))!.detail!;
    expect(detail).toContain("state-cannot-finish at 'p.c.stuck'");

    // A sibling's transition that moves this region, or leaves the parallel state, counts.
    config.states.p.states.c.states.freed = { after: { "10": { target: "#m.done" } } };
    for (const target of ["#m.p.c.freed", "#m.done"]) {
      config.states.p.states.b.states.idle.on.JUMP.target = target;
      const gate = lintGate(await verifyAgentConfig(config, { compileSchema }))!;
      expect(gate.detail ?? "").not.toContain("p.c.stuck");
    }
  });

  /** A desk with two parallel regions: the agent decides; a supervisor escalates. */
  function deskConfig() {
    return {
      id: "desk",
      initial: "open",
      schemas: { events: { ESCALATE: empty, DONE: empty } } as Record<string, any>,
      states: {
        open: {
          type: "parallel",
          states: {
            agent: {
              invoke: {
                src: "agent.decide",
                input: { model: MODEL, prompt: "Decide." } as Record<string, unknown>,
                onError: { target: "#desk.closed" },
              },
              on: { DONE: { target: "#desk.closed" } } as Record<string, unknown>,
            },
            supervisor: {
              on: { ESCALATE: { target: "#desk.closed" } } as Record<string, unknown>,
            },
          },
        },
        closed: fin,
      },
    };
  }

  test("decide-event-without-schema: omitted and wildcard allowedEvents check sibling region events", async () => {
    const omitted = deskConfig();
    delete omitted.schemas.events.ESCALATE;
    let detail = lintGate(await verifyAgentConfig(omitted, { compileSchema }))!.detail!;
    expect(detail).toContain("decide-event-without-schema at 'open.agent'");
    expect(detail).toContain("send 'ESCALATE'");

    const wildcard = deskConfig();
    wildcard.schemas.events = { "desk.done": empty };
    wildcard.states.open.states.agent.invoke.input.allowedEvents = ["desk.*"];
    wildcard.states.open.states.agent.on = { "desk.done": { target: "#desk.closed" } };
    wildcard.states.open.states.supervisor.on = { "desk.escalate": { target: "#desk.closed" } };
    detail = lintGate(await verifyAgentConfig(wildcard, { compileSchema }))!.detail!;
    expect(detail).toContain("send 'desk.escalate'");
    expect(detail).not.toContain("send 'desk.done'");
  });

  test("decide-event-unhandled: a handler on a child of the deciding state counts", async () => {
    const config = {
      id: "m",
      initial: "review",
      schemas: { events: { APPROVE: empty, CANCEL: empty } as Record<string, unknown> },
      states: {
        review: {
          initial: "labeling",
          invoke: {
            src: "agent.decide",
            input: { model: MODEL, prompt: "Approve?", allowedEvents: ["APPROVE"] },
            onError: { target: "done" },
          },
          on: { CANCEL: { target: "done" } },
          states: { labeling: { on: { APPROVE: { target: "#m.done" } } } },
        },
        done: fin,
      },
    };
    expect(lintGate(await verifyAgentConfig(config, { compileSchema }))).toEqual({
      name: "lint",
      ok: true,
    });

    delete config.schemas.events.APPROVE;
    const detail = lintGate(await verifyAgentConfig(config, { compileSchema }))!.detail!;
    expect(detail).toContain("decide-event-without-schema at 'review'");
    expect(detail).toContain("send 'APPROVE'");
  });

  test("decide-event-without-schema: a human-tagged wildcard handler does not exempt an exact event", async () => {
    const config = (on: Record<string, unknown>) => ({
      initial: "routing",
      schemas: { events: {} },
      states: {
        routing: {
          invoke: {
            src: "agent.decide",
            input: { model: MODEL, prompt: "Route.", allowedEvents: ["desk.close"] },
            onError: { target: "done" },
          },
          on,
        },
        done: fin,
      },
    });
    const detail = lintGate(
      await verifyAgentConfig(
        config({
          "desk.close": { target: "done" },
          "desk.*": { target: "done", meta: { actor: "human" } },
        }),
        { compileSchema },
      ),
    )!.detail!;
    expect(detail).toContain("decide-event-without-schema at 'routing'");
    expect(detail).toContain("send 'desk.close'");

    // A human-tagged exact handler withholds the event, so it needs no schema.
    const human = lintGate(
      await verifyAgentConfig(
        config({ "desk.close": { target: "done", meta: { actor: "human" } } }),
        { compileSchema },
      ),
    )!;
    expect(human.detail ?? "").not.toContain("decide-event-without-schema");
  });

  test("decide-event-without-schema: payloads null is not a template", async () => {
    const config = leadConfig();
    delete config.schemas.events.HOT;
    config.states.scoring.invoke.input.payloads = null;
    const detail = lintGate(await verifyAgentConfig(config, { compileSchema }))!.detail!;
    expect(detail).toContain("decide-event-without-schema at 'scoring'");
    expect(detail).toContain("send 'HOT'");
  });

  test("decide-event-without-schema: agent.act payloads do not close the choice", async () => {
    const config = {
      initial: "editing",
      schemas: { events: {} },
      states: {
        editing: {
          invoke: {
            src: "agent.act",
            input: {
              model: MODEL,
              prompt: "Edit the draft.",
              allowedEvents: ["SAVE"],
              payloads: { SAVE: [{ text: "draft" }] },
            },
            onDone: { target: "done" },
            onError: { target: "done" },
          },
          on: { SAVE: { target: "done" } },
        },
        done: fin,
      },
    };
    const detail = lintGate(await verifyAgentConfig(config, { compileSchema }))!.detail!;
    expect(detail).toContain("decide-event-without-schema at 'editing'");
    expect(detail).toContain("agent.act send 'SAVE'");
  });
});

test("verifyAgentConfig returns one explore report per input", async () => {
  const result = await verifyAgentConfig(refundConfig(), options());
  expect(result.ok).toBe(true);
  expect(result.explore).toHaveLength(2);
  expect(result.explore![0]!.terminals.map((t) => t.state)).toContain("approved");
  expect(result.explore![1]!.terminals.map((t) => t.state)).toEqual(["denied"]);
});

test("verifyAgentConfig omits explore reports when an input throws, and still checks later inputs", async () => {
  const result = await verifyAgentConfig(
    refundConfig(),
    options({
      guards: {
        isLarge: ({ context }) => {
          if (context.amount === 0) throw new Error("no amount");
          return context.amount > 100;
        },
      },
      explore: { inputs: [{ amount: 0 }, { amount: 5 }], terminals: ["idle"] },
    }),
  );
  expect(result.explore).toBeUndefined();
  const detail = result.gates.at(-1)!.detail!;
  expect(detail).toContain("input 0: exploration threw");
  expect(detail).toContain("input 1: ");
});
