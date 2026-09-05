import { expect, test } from "vitest";
import { runLongLivedActor } from "./index.js";

test("the application owns one live actor across model work and human input", async () => {
  const result = await runLongLivedActor("actors", {
    generateText: async () => ({ output: "Keep the actor alive." }),
  });

  expect(result.draft).toBe("Keep the actor alive.");
  expect(result.states).toEqual(["drafting", "reviewing", "done"]);
});
