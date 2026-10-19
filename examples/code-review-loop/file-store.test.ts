import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, test } from "vitest";
import { assertEventLogStoreConformance } from "@statelyai/agent/log";
import { runEpisode } from "./bench.js";
import { createFileEventLogStore } from "./file-store.js";
import { createPolicyDecide, judgeClassifier, loadPolicy, withPolicy } from "./policy.js";
import { getTask } from "./tasks.js";
import { fakeRunner, issueJudge, mockAuthorAndReviewer } from "./test-doubles.js";

const root = mkdtempSync(path.join(tmpdir(), "code-review-loop-store-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const fresh = () => createFileEventLogStore(path.join(root, `store-${++n}`));

assertEventLogStoreConformance(fresh, { describe, it });

describe("the file store under a real run", () => {
  test("a run journals to one JSONL file per thread, and a new store instance reads it back", async () => {
    const dir = path.join(root, "run");
    const decide = createPolicyDecide(loadPolicy("v1"), {
      classify: judgeClassifier(issueJudge().model),
    });
    const episode = await runEpisode(getTask("slugify"), {
      executors: withPolicy(mockAuthorAndReviewer(), decide),
      runner: fakeRunner,
      store: createFileEventLogStore(dir),
      policyVersion: "v1",
    });
    expect(episode).toMatchObject({ outcome: "shipped", rounds: 2, threadId: "train/v1/slugify" });
    expect(readdirSync(dir)).toEqual(["train%2Fv1%2Fslugify.jsonl"]);

    const reopened = createFileEventLogStore(dir);
    expect(await reopened.listThreads!({ prefix: "train/" })).toEqual({
      threadIds: ["train/v1/slugify"],
    });
    const entries = await reopened.read("train/v1/slugify");
    expect(entries[0]?.event.type).toBe("@agent.init");
    expect(entries.map((entry) => entry.event.type)).toContain("RETRY");
  });
});
