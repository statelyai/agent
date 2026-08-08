import { describe, expect, test } from "vitest";
import { createActor, createMachine, type AnyStateMachine } from "xstate";
import { z } from "zod";
import { startScenarioRun } from "./agent-runner";
import { getExampleMachine } from "./example-library.server";
import {
  createTraceRecorder,
  describeIdle,
  describeMachineInput,
  jsonSchemaOf,
  renderIdleWork,
  renderOutput,
  runSignal,
} from "./machine-chat.server";
import {
  humanizeEventType,
  humanizeFieldName,
  schemaFields,
  schemaNeedsPayload,
  singleStringField,
} from "./machine-ui";
import { scriptedExecutorsFor } from "./scripted-executors";

describe("accepted-event descriptors (unified chat)", () => {
  test("refund idle carries interaction hints and no-payload buttons", async () => {
    const result = await startScenarioRun(
      "refund",
      "I need a $500 refund for a cancelled order.",
      "script",
      undefined,
      scriptedExecutorsFor("refund"),
    );
    expect(result.status).toBe("idle");
    const approve = result.idle!.events.find((event) => event.type === "APPROVE");
    const deny = result.idle!.events.find((event) => event.type === "DENY");
    // Hints from `meta.interaction.events`.
    expect(approve).toMatchObject({
      label: "Approve refund",
      style: "primary",
      needsPayload: false,
    });
    expect(deny).toMatchObject({ label: "Deny", style: "danger" });
    // Neither event takes a string payload, so free text has no mapping here.
    expect(result.idle!.textEvent).toBeNull();
    expect(result.idle!.prompt).toContain("auto-refund limit");
  });

  test("approval idle: REJECT needs a payload dialog and is the inferred text event", async () => {
    const result = await startScenarioRun(
      "approval",
      "Announce the migration.",
      "script",
      undefined,
      scriptedExecutorsFor("approval"),
    );
    expect(result.status).toBe("idle");
    const reject = result.idle!.events.find((event) => event.type === "REJECT");
    expect(reject?.needsPayload).toBe(true);
    // JSON Schema generated from the zod event schema drives the dialog form.
    const fields = schemaFields(reject!.jsonSchema!);
    expect(fields?.map((field) => field.name)).toEqual(["reason"]);
    // Exactly one accepted event takes a single string → free text maps to it.
    expect(result.idle!.textEvent).toEqual({ type: "REJECT", field: "reason" });
    // No custom renderer declared on that state.
    expect(result.idle!.component).toBeNull();
  });
});

describe("meta.interaction.component (custom composer renderer)", () => {
  const machineWith = (interaction: Record<string, unknown>): AnyStateMachine =>
    createMachine({
      initial: "waiting",
      states: {
        waiting: { meta: { interaction }, on: { RATE: "done" } },
        done: { type: "final" },
      },
    } as never) as AnyStateMachine;

  const idleOf = (machine: AnyStateMachine) =>
    describeIdle(machine, createActor(machine).start().getSnapshot() as never);

  test("a declared component name flows into the ChatIdle descriptor", () => {
    expect(idleOf(machineWith({ component: "rating" })).component).toBe("rating");
    expect(idleOf(machineWith({ component: "cards", label: "Pick a rank" })).component).toBe(
      "cards",
    );
  });

  test("states without one (or with a non-string one) report null", () => {
    expect(idleOf(machineWith({ label: "Choose" })).component).toBeNull();
    expect(idleOf(machineWith({ component: 42 })).component).toBeNull();
    expect(idleOf(machineWith({ component: "" })).component).toBeNull();
  });
});

describe("machine input detection", () => {
  test("single-string input machines are chat-startable", async () => {
    const machine = await getExampleMachine("joke", "jokeMachine");
    const info = describeMachineInput(machine);
    expect(info.promptField).toBe("topic");
  });
});

describe("json schema helpers", () => {
  test("zod schemas convert and flatten into form fields", () => {
    const schema = jsonSchemaOf(
      z.object({
        title: z.string().describe("Short title"),
        count: z.number().int(),
        kind: z.enum(["a", "b"]),
        deep: z.object({ x: z.string() }),
      }),
    );
    expect(schema).toBeTruthy();
    const fields = schemaFields(schema!)!;
    expect(fields.map((field) => field.kind.type)).toEqual(["string", "number", "enum", "json"]);
    expect(fields[0].description).toBe("Short title");
    expect(schemaNeedsPayload(schema)).toBe(true);
    expect(singleStringField(schema)).toBeNull();
    expect(singleStringField(jsonSchemaOf(z.object({ reason: z.string() })))).toBe("reason");
    expect(schemaNeedsPayload(jsonSchemaOf(z.object({})))).toBe(false);
  });
});

describe("field label humanizer", () => {
  test("splits camelCase and separators, keeping acronyms", () => {
    expect(humanizeFieldName("maxRounds")).toBe("Max rounds");
    expect(humanizeFieldName("player_hp")).toBe("Player hp");
    expect(humanizeFieldName("playerHP")).toBe("Player HP");
    expect(humanizeFieldName("topic")).toBe("Topic");
    // Event-type humanizing is unchanged.
    expect(humanizeEventType("AUTO_REFUND")).toBe("Auto refund");
  });

  test("schema form fields use the humanized name", () => {
    const fields = schemaFields(jsonSchemaOf(z.object({ maxRounds: z.number() }))!)!;
    expect(fields[0].label).toBe("Max rounds");
  });
});

describe("idle prompt fallbacks", () => {
  test("falls back to the active state node's description", async () => {
    const machine = createMachine({
      initial: "waiting",
      context: { who: "Ada" },
      states: {
        // No meta.interaction — the description carries the prompt, and
        // `{key}` placeholders still resolve against context.
        waiting: { description: "Your move, {who}.", on: { GO: "done" } },
        done: { type: "final" },
      },
    } as never) as AnyStateMachine;
    const actor = createActor(machine).start();
    expect(describeIdle(machine, actor.getSnapshot() as never).prompt).toBe("Your move, Ada.");
  });
});

describe("run output rendering", () => {
  test("object output reads as prose plus a compact field list", () => {
    const text = renderOutput({
      queue: "billing",
      reason: "The request names a duplicate charge and an invoice the customer cannot open.",
      confident: true,
    });
    expect(text.startsWith("The request names")).toBe(true);
    expect(text).toContain("Queue: billing");
    expect(text).toContain("Confident: true");
    expect(text).not.toContain("```");
  });

  test("plain strings and non-string objects are unchanged", () => {
    expect(renderOutput("done")).toBe("done");
    expect(renderOutput({ score: 9 })).toContain("```json");
  });
});

describe("idle work rendering (changed context surfaces before approval)", () => {
  const fakeSnapshot = (context: Record<string, unknown>) =>
    ({ value: "s", context }) as never;

  test("recorder tracks keys changed after init, most recent first", () => {
    const recorder = createTraceRecorder();
    recorder.onTransition(fakeSnapshot({ topic: "cats", draft: "" }), { type: "xstate.init" });
    recorder.onTransition(fakeSnapshot({ topic: "cats", draft: "A draft." }), { type: "model.done" });
    recorder.onTransition(fakeSnapshot({ topic: "cats", draft: "A draft.", score: 7 }), {
      type: "eval.done",
    });
    // `topic` was present at init → not "work"; latest change ranks first.
    expect(recorder.changedKeys()).toEqual(["score", "draft"]);
  });

  test("a baseline context (resumed snapshot) suppresses prior turns' work", () => {
    const recorder = createTraceRecorder({ draft: "Old draft", approved: false });
    recorder.onTransition(fakeSnapshot({ draft: "Old draft", approved: true }), {
      type: "APPROVE",
    });
    expect(recorder.changedKeys()).toEqual(["approved"]);
  });

  test("a single changed string renders bare; several get humanized headers", () => {
    expect(renderIdleWork({ draft: "The draft body." }, ["draft"])).toBe("The draft body.");
    const multi = renderIdleWork(
      { sqlQuery: "SELECT 1", explanation: "It counts rows." },
      ["explanation", "sqlQuery"],
    )!;
    expect(multi).toContain("**Explanation**");
    expect(multi).toContain("**Sql query**");
    expect(multi.indexOf("It counts rows.")).toBeLessThan(multi.indexOf("SELECT 1"));
  });

  test("strings lead, small objects follow as JSON, noise is skipped", () => {
    const text = renderIdleWork(
      { answer: "Jupiter", board: { turn: 2 }, count: 3, empty: "" },
      ["board", "answer", "count", "empty"],
    )!;
    // The prose answer outranks the more recently changed object.
    expect(text.indexOf("Jupiter")).toBeLessThan(text.indexOf("```json"));
    expect(text).toContain('"turn": 2');
    expect(text).not.toContain("Count");
    expect(renderIdleWork({ n: 1 }, ["n"])).toBeNull();
    expect(renderIdleWork({ big: "x".repeat(9000) }, ["big"])).toContain("…");
  });

  test("input echoes and message-history arrays are plumbing, not work", () => {
    // The user's own text stored into context isn't "produced" output.
    expect(renderIdleWork({ prompt: "write it", draft: "Dear team…" }, ["prompt", "draft"], [
      "write it",
    ])).toBe("Dear team…");
    // ai-sdk style message logs are skipped even though they changed.
    expect(
      renderIdleWork(
        { messages: [{ role: "user", content: "hi" }], draft: "Dear team…" },
        ["messages", "draft"],
      ),
    ).toBe("Dear team…");
  });
});

describe("fromConfig machine schemas", () => {
  test("a JSON-authored machine exposes its input schema", async () => {
    const machine = await getExampleMachine("json-agent", "jsonAgentMachine");
    const info = describeMachineInput(machine);
    expect(info.jsonSchema).not.toBeNull();
    expect(info.jsonSchema?.required).toContain("ticket");
    expect(info.promptField).toBe("ticket");
  });
});

describe("run limits (cancel + time budget)", () => {
  test("runSignal reflects an already-aborted request signal", () => {
    const controller = new AbortController();
    controller.abort();
    expect(runSignal({ signal: controller.signal }).aborted).toBe(true);
    expect(runSignal({}).aborted).toBe(false);
  });

  test("a cancelled scenario run settles as an error instead of hanging", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    const result = await startScenarioRun(
      "refund",
      "I need a $500 refund.",
      "script",
      undefined,
      scriptedExecutorsFor("refund"),
      controller.signal,
    );
    expect(result.status).toBe("error");
  });
});
