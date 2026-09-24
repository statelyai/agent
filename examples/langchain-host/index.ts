/**
 * LangChain + XState agent, both directions — the "use them together" example.
 *
 * The migration guide (docs/langgraph-comparison.md) covers moving *off* LangGraph.
 * This one is the other answer: keep LangChain, and let a state machine own
 * control flow. Real `@langchain/core` / `@langchain/openai` / `langchain`
 * 1.x, no shims.
 *
 *   Direction A — LangChain model as executor (./executors.ts)
 *     `createLangChainExecutors(model)` wraps any `BaseChatModel` into the
 *     `{ generateText, streamText, decide }` contract. Your model config, your
 *     callbacks, your retries — the machine just owns which call happens next
 *     and which events are legal.
 *
 *   Direction B — machine as a LangChain tool (./bridge.ts)
 *     `start_workflow` / `resume_workflow` are `DynamicStructuredTool`s over
 *     the email-drafter machine, driven by LangChain 1.x's `createAgent` loop.
 *     The agent converses; the machine refuses illegal moves.
 *
 * Stacked, that is the best of both worlds: LangChain makes every model call
 * (Direction A) inside a machine that a LangChain agent calls as a tool
 * (Direction B).
 *
 * LangSmith: because the model call is LangChain's own, tracing is env-var
 * driven and needs no code here — set `LANGSMITH_TRACING=true` and
 * `LANGSMITH_API_KEY=...` and every generation, stream, and decision below
 * shows up as a trace. Use `@statelyai/agent/otel` when the host should trace
 * the machine's own spans instead.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/langchain-host/index.ts
 *   Both directions run live against ChatOpenAI.
 */
import assert from "node:assert/strict";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { runAgent } from "@statelyai/agent";
import { jokeMachine } from "../joke/index.js";
import { createLangChainExecutors } from "./executors.js";
import {
  createEmailHostAgent,
  resumeWorkflowTool,
  startWorkflowTool,
  useModel,
  type ToolResult,
} from "./bridge.js";

export * from "./executors.js";
export * from "./bridge.js";

const LIVE_MODEL = "gpt-5.4-mini";

// ─── Direction A: LangChain model as the machine's executors ───

/**
 * The joke machine exercises all three executor slots in one run:
 * `streamText` (tell), `generateText` with a structured schema (rate), and
 * `decide` (keep going or stop). Every one of them is a LangChain model call.
 */
export async function runJokeDemo(model: BaseChatModel, onChunk?: (chunk: string) => void) {
  const result = await runAgent(jokeMachine, {
    input: { topic: "state machines" },
    executors: createLangChainExecutors({ model }),
    ...(onChunk ? { onChunk } : {}),
  });
  if (result.status !== "done") {
    throw new Error(`Joke agent did not complete: ${result.status}`);
  }
  return result.output;
}

// ─── Direction B: the machine as LangChain tools ───

/**
 * Drive the two bridge tools directly, the way LangChain's tool node does, and
 * read back the JSON they return. No agent loop, no model in the conversation
 * seat — just the bridge.
 */
export async function runBridgeDemo(machineModel: BaseChatModel) {
  useModel(machineModel);

  const started = JSON.parse(
    await startWorkflowTool.invoke({
      prompt: "Tell the team the deploy pipeline is twice as fast.",
    }),
  ) as ToolResult;
  assert.equal(started.status, "pending");
  if (started.status !== "pending") throw new Error("expected pending");

  const sent = JSON.parse(
    await resumeWorkflowTool.invoke({ handle: started.handle, eventType: "SEND", text: null }),
  ) as ToolResult;
  assert.equal(sent.status, "pending");

  const finished = JSON.parse(
    await resumeWorkflowTool.invoke({ handle: started.handle, eventType: "END", text: null }),
  ) as ToolResult;
  assert.equal(finished.status, "done");
  return { started, finished };
}

/** The full LangChain agent loop over the same two tools. */
export async function runAgentLoopDemo(
  model: BaseChatModel,
  machineModel: BaseChatModel,
  ask: string,
) {
  const agent = createEmailHostAgent(model, machineModel);
  const result = await agent.invoke({ messages: [new HumanMessage(ask)] });
  return result.messages.at(-1)?.text ?? "";
}

// ─── Demos ───

/** Both directions against a real ChatOpenAI. */
export async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY to run the langchain-host example.");
  }
  const model = new ChatOpenAI({ model: LIVE_MODEL });

  console.log("— Direction A: LangChain model as executor —");
  const jokeOutput = await runJokeDemo(model, (chunk) => process.stdout.write(chunk));
  console.log(`\nRating: ${jokeOutput.lastRating}, jokes told: ${jokeOutput.jokes.length}\n`);

  console.log("— Direction B: createAgent over the machine's two tools —");
  const agent = createEmailHostAgent(model);
  const result = await agent.invoke({
    messages: [
      new HumanMessage(
        "Email team@example.com with subject 'Deploy pipeline is faster' telling the team our " +
          "deploy pipeline is now twice as fast thanks to the new build cache. Send it, then " +
          "finish. I'm pre-approving every choice: if the workflow offers 'Draft anyway', take " +
          "it; when the draft is ready, SEND; when it asks about another email, END.",
      ),
    ],
  });
  console.log(result.messages.at(-1)?.text ?? "");
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
