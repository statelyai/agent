import { test } from "vitest";
import assert from "node:assert/strict";
import type { AgentTextRequest, AgentRequestExecutorInfo } from "@statelyai/agent";
import { runParallelStreamsExample } from "./index.js";

test("parallel streaming requests are disambiguated by request.id in onChunk", async () => {
  const streamText = async (request: AgentTextRequest, info?: AgentRequestExecutorInfo) => {
    // Emit two chunks per stream so they interleave across the two regions.
    const parts = request.model === "thinker" ? ["analysis ", "chunk"] : ["poem ", "chunk"];
    for (const part of parts) {
      info?.onChunk?.(part);
    }
    return { output: parts.join("") };
  };

  const { output, buffers } = await runParallelStreamsExample({
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
  assert.deepEqual(output, {
    analysis: "analysis chunk",
    poem: "poem chunk",
  });
});
