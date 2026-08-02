import { describe, expect, test } from "vitest";
import { createActor, createMachine, type AnyStateMachine } from "xstate";
import { z } from "zod";
import { startScenarioRun } from "./agent-runner";
import { getExampleMachine } from "./example-library.server";
import { describeIdle, describeMachineInput, jsonSchemaOf } from "./machine-chat.server";
import { schemaFields, schemaNeedsPayload, singleStringField } from "./machine-ui";
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
    expect(approve).toMatchObject({ label: "Approve refund", style: "primary", needsPayload: false });
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
    expect(idleOf(machineWith({ component: "cards", label: "Pick a rank" })).component).toBe("cards");
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
