import { expect, test } from "vitest";
import { runPortableXstateLoop } from "./index.js";

test("runs one artifact through XState's transition/effect loop", async () => {
  const prompts: string[] = [];
  const output = await runPortableXstateLoop("snapshots", {
    generateText: async (request) => {
      prompts.push(request.prompt ?? "");
      return { output: "Snapshots make continuation explicit." };
    },
  });

  expect(prompts).toEqual(["Draft a release note about snapshots."]);
  expect(output).toEqual({ draft: "Snapshots make continuation explicit." });
});
