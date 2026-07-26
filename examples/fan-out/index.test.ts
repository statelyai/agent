import { test } from "vitest";
import assert from "node:assert/strict";
import type { AnyMachineSnapshot, Snapshot } from "xstate";
import { persistSnapshot, runAgent, type AgentTextRequest } from "@statelyai/agent";
import { fanOutMachine, runFanOutExample } from "./index.js";

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

// FINDING (2026-07): resuming a snapshot persisted while branches are still in
// flight does NOT re-run those spawned children. `persistSnapshot` captures the
// live children with no resumable state (status undefined, no output); on
// restore xstate drops them (`children: {}`), so `collecting` has nothing left
// to await and `runAgent` settles `{ status: 'idle' }` in `collecting` with
// `summaries: {}` — the run never completes. This is the same limitation the
// module header notes: a durable step host replays child-done events to resume;
// `runAgent`'s live-actor path cannot revive an async child frozen mid-flight.
// Kept skipped until spawned-child resume is supported.
test.skip("resumes a mid-flight snapshot and completes with all summaries", async () => {
  const subtopics = ["durability", "concurrency", "observability", "resumption"];
  const executors = {
    generateText: async (request: AgentTextRequest) => {
      if (request.model === "planner") return { output: { subtopics } };
      if (request.model === "worker") {
        const subtopic = request.prompt?.split("Subtopic: ")[1] ?? "";
        // Delay so the captured `collecting` snapshot still has live branches.
        await new Promise((r) => setTimeout(r, 20));
        return { output: `summary of ${subtopic}` };
      }
      return { output: "composed digest" };
    },
  };

  // Capture the first `collecting` snapshot (all 4 branches spawned, none done).
  let captured: Snapshot<unknown> | null = null;
  await runAgent(fanOutMachine, {
    input: { topic: "durability" },
    executors,
    onTransition: (snapshot) => {
      if (JSON.stringify(snapshot.value) !== '"collecting"') return;
      if (!captured && Object.keys(snapshot.context.summaries).length < subtopics.length) {
        captured = persistSnapshot(snapshot);
      }
    },
  });
  assert.ok(captured, "expected a mid-flight collecting snapshot");

  const resumed = await runAgent(fanOutMachine, { snapshot: captured!, executors });

  assert.equal(resumed.status, "done");
  assert.deepEqual(resumed.status === "done" ? resumed.output.summaries : null, {
    "branch-0": "summary of durability",
    "branch-1": "summary of concurrency",
    "branch-2": "summary of observability",
    "branch-3": "summary of resumption",
  });
});
