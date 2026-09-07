/**
 * Raw `openai` npm package host for XState agent machines.
 *
 * The mapping itself now ships in the package as
 * `@statelyai/agent/openai` — `createOpenAiExecutors` implements the
 * framework's `{ generateText, streamText, decide }` executor contract
 * directly against the raw `openai` package's Chat Completions API (not the
 * `responses` API — chat.completions is the canonical/stable surface), with
 * no Vercel AI SDK in between. Proof that the executor contract is "three
 * plain functions," not an AI-SDK-specific shape. Compare
 * `@statelyai/agent/ai-sdk` (same contract, mapped through the AI SDK).
 *
 * What is left here is the host: which model ids the demo machines' model
 * refs resolve to, and three runnable demos over them.
 *
 * Every executor the adapter builds reports token `usage`, mapped from
 * OpenAI's snake_case `response.usage` onto the framework's `AgentCallUsage`,
 * so `runAgent`'s run-level budget and the usage event log are populated by a
 * raw-SDK host too. Streaming asks for it explicitly with
 * `stream_options.include_usage`.
 *
 * The adapter's `streamText` is deliberately TEXT-ONLY: it sends no tools and
 * no `response_format`, because a chunk-by-chunk structured envelope has
 * nothing useful to hand `onChunk` mid-stream. A request that declares tools
 * or a structured output schema is rejected with a message pointing at
 * `generateText`, rather than silently returning unstructured text.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/openai-sdk-host/index.ts
 */
import type OpenAI from "openai";
import { runAgent } from "@statelyai/agent";
import { createOpenAiExecutors } from "@statelyai/agent/openai";
import { triageMachine } from "../triage/index.js";
import { twentyQuestionsMachine } from "../twenty-questions/index.js";

async function promptAnswer(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${question} `);
  } finally {
    rl.close();
  }
}

// The demo machines (triage, twenty-questions) carry model refs that both map
// to one real OpenAI id — a raw-SDK host resolves them itself.
const resolveDemoModel = () => "gpt-5.4-mini";

export async function runTriageDemo(client: OpenAI, ticket: string) {
  const { generateText } = createOpenAiExecutors({ client, resolveModel: resolveDemoModel });
  const result = await runAgent(triageMachine, {
    input: { ticket },
    executors: { generateText },
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });
  if (result.status !== "done") {
    throw new Error(`Triage demo did not complete: ${result.status}`);
  }
  return result.output;
}

export async function runStreamingDemo(client: OpenAI) {
  const { streamText } = createOpenAiExecutors({ client });
  let text = "";
  await streamText(
    {
      name: "streamingDemo",
      model: "gpt-5.4-mini",
      system: "You tell short, punchy jokes.",
      prompt: "Tell a joke about state machines.",
      tools: {},
    },
    { onChunk: (chunk) => (text += chunk) },
  );
  return text;
}

// Drives twenty-questions' inline `agent.decide` + machine-owned human-input
// states via the `userInput` executor — the same human-loop pattern
// twenty-questions/index.ts's own main() uses (no host-side idle/event loop
// or fabricated events; `runAgent` gathers input inline via `userInput`).
export async function runTwentyQuestionsDemo(client: OpenAI) {
  const { generateText, decide } = createOpenAiExecutors({
    client,
    resolveModel: resolveDemoModel,
  });

  const result = await runAgent(twentyQuestionsMachine, {
    input: { questionsRemaining: 20 },
    executors: { generateText, decide },
    userInput: async ({ prompt }) => promptAnswer(prompt ?? ">"),
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });

  if (result.status !== "done") {
    throw new Error(`Twenty questions demo did not complete: ${result.status}`);
  }
  return result.output;
}

async function main() {
  const { default: OpenAIClient } = await import("openai");
  const client = new OpenAIClient();

  console.log("— generateText (structured output via response_format) —");
  console.log(await runTriageDemo(client, "My invoice is wrong and I am furious."));

  console.log("— streamText (live chunks) —");
  console.log(await runStreamingDemo(client));

  console.log("— decide (tool_choice: required) —");
  const result = await runTwentyQuestionsDemo(client);
  console.log(`Final score — user: ${result.userScore}, agent: ${result.agentScore}`);
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
