import { expect, test } from "vitest";
import type { UIMessageChunk } from "ai";
import { runAgent, type AgentRequestExecutor } from "@statelyai/agent";
import {
  agentRunToUIMessageStream,
  aiSdkUiStreamMachine,
  runAiSdkUiStreamExample,
} from "./index.js";

const TAGLINE = "Fast, typed agents.";
const PITCH = "Ship agents as explicit state machines. Stream every token to the UI.";
const FULL_ANSWER = TAGLINE + PITCH;

/** Mock streamText: emits one scripted answer per call, word by word, through
 * runAgent's `onChunk` seam. No network, no key. */
function mockStreamText(scripts: readonly string[]): AgentRequestExecutor {
  let call = 0;
  return async (_request, info) => {
    const text = scripts[Math.min(call, scripts.length - 1)]!;
    call++;
    for (const token of text.match(/\S+\s*/g) ?? [text]) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      info?.onChunk?.(token);
    }
    return { output: text };
  };
}

async function collectChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

test("streamed text parts concatenate to the full answer, inside start/finish framing", async () => {
  const stream = agentRunToUIMessageStream(aiSdkUiStreamMachine, {
    input: { product: "a state-machine agent framework" },
    executors: { streamText: mockStreamText([TAGLINE, PITCH]) },
  });

  const chunks = await collectChunks(stream);
  const types = chunks.map((chunk) => chunk.type);

  // Message-level framing per the installed UI message protocol.
  expect(types.at(0)).toBe("start");
  expect(types.at(-1)).toBe("finish");
  // Per-request text-part framing.
  expect(types).toContain("text-start");
  expect(types).toContain("text-end");
  expect(types.filter((type) => type === "text-start")).toHaveLength(2);
  expect(types.filter((type) => type === "text-end")).toHaveLength(2);

  // The text deltas concatenate to the full streamed answer.
  const text = chunks
    .filter(
      (chunk): chunk is Extract<UIMessageChunk, { type: "text-delta" }> =>
        chunk.type === "text-delta",
    )
    .map((chunk) => chunk.delta)
    .join("");
  expect(text).toBe(FULL_ANSWER);
});

test("a data-agent-state part appears for each machine state entered", async () => {
  const result = await runAiSdkUiStreamExample({
    product: "a state-machine agent framework",
    streamText: mockStreamText([TAGLINE, PITCH]),
  });

  // The reconstructed message's text parts join to the full answer.
  expect(result.text).toBe(FULL_ANSWER);

  // Every machine state the run entered surfaced as a data part, in order.
  expect(result.states).toContain("pitch");
  expect(result.states).toContain("done");
  expect(result.states.indexOf("pitch")).toBeLessThan(result.states.indexOf("done"));
});

test("machine exports a runnable definition", () => {
  expect(aiSdkUiStreamMachine.id).toBe("ai-sdk-ui-stream");
});

test("each finished stream leaves a timing lane in the output", async () => {
  const result = await runAgent(aiSdkUiStreamMachine, {
    input: { product: "a state-machine agent framework" },
    executors: { streamText: mockStreamText([TAGLINE, PITCH]) },
  });

  expect(result.status).toBe("done");
  const summary = result.status === "done" ? result.output.streamSummary : "";
  // One lane per stream, with its word count and a measured elapsed time.
  expect(summary).toMatch(/^tagline 3 words in \d+ms · pitch 12 words in \d+ms$/);
});
