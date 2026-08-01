import { describe, expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";
import { codeReviewMachine, scriptedReviewer } from "./index.js";

const DIFF = "+ const user = db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);";

describe("preset-machine (parallel)", () => {
  test("both branches run and join into one result keyed by branch name", async () => {
    const names: (string | undefined)[] = [];
    const executor: AgentRequestExecutor = async (request, info) => {
      names.push(request.name);
      return scriptedReviewer(request, info);
    };

    const result = await runAgent(codeReviewMachine, {
      input: { prompt: DIFF },
      executors: { generateText: executor },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");

    // One model call per branch, each carrying the branch name.
    expect(names.sort()).toEqual(["performance", "security"]);
    // The join keys every branch result by branch name.
    expect(
      Object.keys((result.output as { results: Record<string, unknown> }).results).sort(),
    ).toEqual(["performance", "security"]);
  });

  test("each branch gets its own instructions and the shared prompt", async () => {
    const seen: { name?: string; system?: string; prompt?: string }[] = [];
    const executor: AgentRequestExecutor = async (request) => {
      seen.push({ name: request.name, system: request.system, prompt: request.prompt });
      return { output: "ok" };
    };

    await runAgent(codeReviewMachine, {
      input: { prompt: DIFF },
      executors: { generateText: executor },
    });

    const security = seen.find((call) => call.name === "security");
    expect(security?.system).toContain("security");
    expect(security?.prompt).toBe(DIFF);
    expect(seen.find((call) => call.name === "performance")?.system).toContain("performance");
  });
});
