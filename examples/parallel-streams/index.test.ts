import { test } from "vitest";
import assert from "node:assert/strict";
import type { AgentTextRequest, AgentRequestExecutorInfo } from "@statelyai/agent";
import { runParallelStreamsExample } from "./index.js";

test("parallel streaming requests are disambiguated by request.id in onChunk", async () => {
  const streamText = async (request: AgentTextRequest, info?: AgentRequestExecutorInfo) => {
    // Emit two chunks per stream so they interleave across the two regions.
    // Routed on the request NAME, the `setupAgent({ requests })` key.
    const parts = request.name === "thinker" ? ["analysis ", "chunk"] : ["poem ", "chunk"];
    for (const part of parts) {
      info?.onChunk?.(part);
    }
    return { output: parts.join("") };
  };

  const { output, buffers, lastChunkAt } = await runParallelStreamsExample({
    input: { topic: "actors" },
    executors: {
      // generateText is required by the type but unused here (both requests stream).
      generateText: async () => ({ output: "" }),
      streamText,
    },
  });

  // onChunk routed each stream's chunks to the right buffer via request.id.
  assert.equal(buffers.thinker, "analysis chunk");
  assert.equal(buffers.poet, "poem chunk");
  assert.equal(
    output.summary,
    'Two streams completed for "actors": analysis (14 chars) and poem (10 chars).',
  );
  assert.equal(output.analysis, "analysis chunk");
  assert.equal(output.poem, "poem chunk");
  // Completion order survives to the final view: one line per lane, numbered
  // in the order the lanes finished. It is rendered in `output`, not stored.
  const lanes = output.laneSummary.split("\n");
  assert.equal(lanes.length, 2);
  assert.match(lanes[0]!, /^1\. (analysis|poem)$/);
  assert.match(lanes[1]!, /^2\. (analysis|poem)$/);
  assert.notEqual(lanes[0]!.slice(3), lanes[1]!.slice(3));
  assert.deepEqual(output.failures, []);
  // The summary references the streams instead of repeating their text, so the
  // demo does not render the same content twice.
  assert.ok(!output.summary.includes("analysis chunk"));
  assert.ok(!output.summary.includes("poem chunk"));
  // Timing is the host's, measured around the run — never in the machine.
  assert.ok(typeof lastChunkAt.thinker === "number");
  assert.ok(typeof lastChunkAt.poet === "number");
});

test("a failing stream ends its region instead of hanging the parallel machine", async () => {
  const { output } = await runParallelStreamsExample({
    input: { topic: "actors" },
    executors: {
      generateText: async () => ({ output: "" }),
      streamText: async (request) => {
        if (request.name === "poet") throw new Error("poet is out of ink");
        return { output: "analysis only" };
      },
    },
  });

  assert.equal(output.analysis, "analysis only");
  assert.equal(output.poem, "");
  assert.deepEqual(output.laneSummary, "1. analysis");
  assert.equal(output.failures.length, 1);
  assert.match(output.failures[0]!, /^poem: /);
});
