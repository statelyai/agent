import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decisionObjectSchema, resolveDecisionMode } from "./decision-object.js";

describe("decisionObjectSchema", () => {
  it("marks optional payload fields at any depth", () => {
    const schema = decisionObjectSchema({
      events: [
        {
          type: "SHIP",
          toolName: "SHIP",
          inputSchema: z.object({
            method: z.string(),
            options: z.object({ signature: z.boolean().optional().describe("Sign on delivery.") }),
          }),
        },
      ],
    } as never) as any;
    const branch = schema.properties.event.anyOf[0];
    expect(branch.properties.method.description).toBeUndefined();
    expect(branch.properties.type.description).toBeUndefined();
    expect(branch.properties.options.properties.signature.description).toBe(
      "Optional: leave out unless the input gives it. Sign on delivery.",
    );
  });

  it("flattens object unions into strict event variants", () => {
    const request = {
      events: [
        {
          type: "SHIP",
          toolName: "SHIP",
          inputSchema: z.union([
            z.object({ method: z.literal("ground"), days: z.literal(5) }),
            z.object({ method: z.literal("air"), flight: z.string() }),
          ]),
        },
      ],
    } as never;
    const schema = decisionObjectSchema(request) as any;
    const variants = schema.properties.event.anyOf;
    expect(variants).toHaveLength(2);
    expect(variants.map((branch: any) => branch.properties.method.const)).toEqual([
      "ground",
      "air",
    ]);
    expect(variants.every((branch: any) => branch.allOf === undefined)).toBe(true);
    expect(resolveDecisionMode(undefined, request)).toBe("object");
  });

  it("does not annotate property maps as schemas", () => {
    const schema = decisionObjectSchema({
      events: [
        {
          type: "SHIP",
          toolName: "SHIP",
          inputSchema: z.object({
            properties: z.object({ note: z.string().optional() }),
          }),
        },
      ],
    } as never) as any;
    const nested = schema.properties.event.anyOf[0].properties.properties.properties;
    expect(nested.description).toBeUndefined();
    expect(nested.note.description).toBe(OPTIONAL_NOTE);
  });

  it("defaults non-object payload variants to tool mode", () => {
    const request = {
      events: [
        {
          type: "SHIP",
          toolName: "SHIP",
          inputSchema: z.union([z.object({ method: z.string() }), z.string()]),
        },
      ],
    } as never;
    expect(resolveDecisionMode(undefined, request)).toBe("tool");
  });

  it("routes a schema with no synchronous JSON Schema to tool mode", () => {
    const asyncSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
        jsonSchema: { input: async () => ({ type: "object" }) },
      },
    };
    const request = {
      events: [{ type: "SHIP", toolName: "SHIP", inputSchema: asyncSchema }],
    } as never;
    expect(resolveDecisionMode(undefined, request)).toBe("tool");
  });
});

const OPTIONAL_NOTE = "Optional: leave out unless the input gives it.";
