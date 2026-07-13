import { test } from "vitest";
import assert from "node:assert/strict";
import type { AnyMachineSnapshot } from "xstate";
import type { AgentTextRequest } from "../../src/index.js";
import { runFanOutExample } from "./index.js";

test("fan-out plans subtopics, spawns one branch per subtopic, and reduces all summaries", async () => {
  const subtopics = ["durability", "concurrency", "observability", "resumption"];
  const branchInputs: string[] = [];

  // Snapshots captured while the machine is in `collecting` — used to assert
  // the dynamic branches are live children mid-fan-out (per-branch state is
  // visible to the machine, not hidden inside one Promise.all).
  const midFlight: { children: string[]; active: number }[] = [];

  const output = await runFanOutExample({
    executors: {
      generateText: async (request: AgentTextRequest) => {
      if (request.model === "planner") {
        return { output: { subtopics } };
      }
      if (request.model === "worker") {
        // The branch prompt embeds the subtopic; record it so we can assert
        // every subtopic was fanned out.
        const subtopic = request.prompt?.split("Subtopic: ")[1] ?? "";
        branchInputs.push(subtopic);
        // Small async gap so branches overlap and a mid-flight snapshot with
        // multiple active children is observable.
        await new Promise((r) => setTimeout(r, 5));
        return { output: `summary of ${subtopic}` };
      }
      // reducer — its prompt embeds every summary.
      assert.ok(request.prompt?.includes("summary of durability"));
      assert.ok(request.prompt?.includes("summary of resumption"));
      return { output: "composed digest" };
      },
    },
    onTransition: (snapshot: AnyMachineSnapshot) => {
      if (JSON.stringify(snapshot.value) !== '"collecting"') {
        return;
      }
      const children = Object.keys(snapshot.children ?? {});
      const active = Object.values(snapshot.children ?? {}).filter(
        (ref) =>
          (ref as { getSnapshot?: () => { status?: string } } | undefined)?.getSnapshot?.()
            ?.status === "active",
      ).length;
      midFlight.push({ children, active });
    },
  });

  // Every subtopic was fanned out into its own branch.
  assert.deepEqual([...branchInputs].sort(), [...subtopics].sort());

  // All N summaries were reduced into the map, keyed by branch id.
  assert.deepEqual(output.summaries, {
    "branch-0": "summary of durability",
    "branch-1": "summary of concurrency",
    "branch-2": "summary of observability",
    "branch-3": "summary of resumption",
  });
  assert.deepEqual(output.subtopics, subtopics);
  assert.equal(output.digest, "composed digest");

  // Per-branch state was visible mid-fan-out: at some transition into
  // `collecting`, all 4 branches were live children and > 1 was still active
  // (they ran in parallel, observable in the snapshot — the LangGraph `Send`
  // property, not a single opaque Promise.all).
  const allFourLive = midFlight.some((m) => m.children.length === 4);
  const overlap = midFlight.some((m) => m.active >= 2);
  assert.ok(allFourLive, "expected all 4 branches as live children mid-flight");
  assert.ok(overlap, "expected >=2 branches active simultaneously mid-flight");
});
