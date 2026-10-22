import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, test } from "vitest";
import type { SchemaCompiler, StandardSchemaV1 } from "../index.js";
import { verifyAgentConfig } from "./index.js";

// The generate-machine skill's reference config must pass the skill's own
// verifyAgentConfig call, so the skill cannot drift from the gates.
const skill = readFileSync(
  new URL("../../skills/generate-machine/SKILL.md", import.meta.url),
  "utf8",
);

/** The first fenced block of `lang` after the line starting with `heading`. */
function blockAfter(heading: string, lang: string): string {
  const start = skill.indexOf(`\n${heading}`);
  expect(start, `heading '${heading}' in the skill`).toBeGreaterThan(-1);
  const open = skill.indexOf(`\n\`\`\`${lang}\n`, start);
  const body = open + `\n\`\`\`${lang}\n`.length;
  return skill.slice(body, skill.indexOf("\n```", body));
}

// The skill's compileSchema recipe.
const ajv = new Ajv({ strict: false });
const compileSchema: SchemaCompiler = (jsonSchema, name): StandardSchemaV1 => {
  const validate = ajv.compile(jsonSchema);
  return {
    "~standard": {
      version: 1,
      vendor: "ajv",
      validate: (value: unknown) =>
        validate(value)
          ? { value }
          : {
              issues: (validate.errors ?? []).map((e) => ({
                message: `${name}${e.instancePath} ${e.message}`,
              })),
            },
      jsonSchema: { input: () => jsonSchema },
    },
  };
};

describe("skills/generate-machine reference config", () => {
  test("passes the skill's documented verifyAgentConfig options", async () => {
    const config = JSON.parse(blockAfter("Reference config", "json"));
    const call = blockAfter("Run the gates.", "ts");

    // The options below mirror the skill's call; these lines keep them in step.
    const escalate = 'payloads: () => ({ ESCALATE: [{ reason: "needs a human" }] })';
    expect(call).toContain(escalate);
    expect(call).toContain('outputs: { draftReply: [{ reply: "" }] }');
    expect(call).toContain('inputs: [{ ticket: "Export downloads a 0-byte CSV on Safari." }]');

    const result = await verifyAgentConfig(config, {
      compileSchema,
      allow: {
        actors: [],
        requests: ["draftReply"],
        guards: [],
        actions: [],
        events: ["ESCALATE", "REPLY", "APPROVE", "REJECT"],
        models: ["openai/gpt-6-luna"],
      },
      explore: {
        inputs: [{ ticket: "Export downloads a 0-byte CSV on Safari." }],
        outputs: { draftReply: [{ reply: "" }] },
        payloads: () => ({ ESCALATE: [{ reason: "needs a human" }] }),
      },
    });
    expect(
      result.gates.filter((gate) => !gate.ok),
      JSON.stringify(result.gates),
    ).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("the manual fallback explores with the same payloads", () => {
    const fallback = blockAfter("## 5. Manual fallback", "ts");
    expect(fallback).toContain('payloads: () => ({ ESCALATE: [{ reason: "needs a human" }] })');
  });
});
