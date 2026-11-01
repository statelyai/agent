import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decisionObjectSchema } from "./decision-object.js";

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
});
