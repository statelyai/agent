import { describe, expect, test } from "vitest";
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
