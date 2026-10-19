/** run.ts flags: `--reviewer-model` puts the reviewer on its own model; the author keeps the default. */
import { describe, expect, test } from "vitest";
import { createClaudeCodeExecutors, type Spawn } from "./claude-code.js";
import { modelOptions } from "./run.js";

describe("run.ts model flags", () => {
  test("no flags: every call uses the CLI's default model", () => {
    expect(modelOptions({})).toEqual({});
  });

  test("--reviewer-model maps the reviewer ref only", async () => {
    const options = modelOptions({ model: "sonnet", "reviewer-model": "haiku" });
    expect(options).toEqual({ defaultModel: "sonnet", models: { reviewer: "haiku" } });

    const models: Array<string | undefined> = [];
    const spawn: Spawn = async (_command, args) => {
      const index = args.indexOf("--model");
      models.push(index === -1 ? undefined : args[index + 1]);
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
        }),
        stderr: "",
        exitCode: 0,
      };
    };
    const cli = createClaudeCodeExecutors({ ...options, spawn });
    await cli.generateText({
      kind: "text",
      id: "r",
      name: "reviewPatch",
      model: "reviewer",
      prompt: "x",
    } as never);
    await cli.generateText({
      kind: "text",
      id: "w",
      name: "writePatch",
      model: "author",
      prompt: "x",
    } as never);
    // The reviewer call, then the author call.
    expect(models).toEqual(["haiku", "sonnet"]);
  });
});
