/**
 * Vercel AI SDK UI message stream — bridge a `runAgent` run to the AI SDK v6 UI
 * message protocol so a `useChat` client streams it unchanged.
 *
 * LangGraph users get `toUIMessageStreamResponse()` from its streaming
 * integrations: a run turns into the wire protocol `useChat` speaks. This is the
 * same story for a runAgent machine. `agentRunToUIMessageStream` fans runAgent's
 * observational seams into UI message chunks —
 *   - `onChunk` → text parts (`text-start` / `text-delta` / `text-end`), one per
 *     streamed request, keyed by the invoke id.
 *   - `onTransition` → `data-agent-state` data parts, so the client can render
 *     which machine state produced each token.
 *   - the settled result → the closing `finish` frame.
 * `handleChatRequest` then serves it as `createUIMessageStreamResponse({ stream })`
 * — a `POST /api/chat` handler a `useChat({ api: '/api/chat' })` client points at
 * with no changes.
 *
 * The machine is a two-step streaming copy chain (tagline → pitch) at the same
 * scale as the joke / marketing-chain examples. Each finished stream leaves a
 * lane in `streamSummary` (word count + elapsed ms), so the streaming story is
 * still readable once the run is over and the tokens have stopped moving.
 *
 * Dual-mode: `runAiSdkUiStreamExample(options?)` takes an injectable `streamText`
 * (tests pass a mock — keyless CI); the direct run uses a real model and consumes
 * the stream server-side with `readUIMessageStream`.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-ui-stream/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { AnyMachineSnapshot, AnyStateMachine } from "xstate";
import {
  runAgent,
  setupAgent,
  type AgentRequestExecutor,
  type RunAgentOptions,
} from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

export const models = defineModels({
  writer: openai("gpt-5.4-mini"),
});

/** The data-part type carrying each machine state the run enters. */
const AGENT_STATE_PART = "data-agent-state";

const contextSchema = z.object({
  product: z.string(),
  tagline: z.string().nullable(),
  pitch: z.string().nullable(),
  /** One lane per finished stream: word count and elapsed ms, measured here. */
  streamSummary: z.string().nullable(),
  /** When the current stream started — the clock for the lane above. */
  startedAt: z.number(),
});

/** "tagline 4 words in 120ms" */
function streamLane(label: string, text: string, elapsedMs: number) {
  return `${label} ${text.trim().split(/\s+/).filter(Boolean).length} words in ${elapsedMs}ms`;
}

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ product: z.string() }),
  output: z.object({ pitch: z.string(), tagline: z.string(), streamSummary: z.string() }),
  requests: {
    // Two streamed text requests: each becomes one UI text part.
    streamTagline: {
      mode: "stream",
      schemas: { input: z.object({ product: z.string() }), output: z.string() },
      model: "writer",
      system: "You are a copywriter. Reply with a single punchy tagline, no quotes.",
      prompt: ({ input }) => `Write a tagline for: ${input.product}`,
    },
    streamPitch: {
      mode: "stream",
      schemas: {
        input: z.object({ product: z.string(), tagline: z.string() }),
        output: z.string(),
      },
      model: "writer",
      system: "You are a copywriter. Expand the tagline into a two-sentence pitch.",
      prompt: ({ input }) =>
        `Product: ${input.product}\nTagline: ${input.tagline}\nWrite the pitch.`,
    },
  },
});

export const aiSdkUiStreamSchemas = agentSetup.schemas;

export const aiSdkUiStreamMachine = agentSetup.createMachine({
  id: "ai-sdk-ui-stream",
  context: ({ input }) => ({
    product: input.product,
    tagline: null,
    pitch: null,
    streamSummary: null,
    startedAt: Date.now(),
  }),
  // All three are set before `done`; fall back to "" to satisfy the output type.
  output: ({ context }) => ({
    pitch: context.pitch ?? "",
    tagline: context.tagline ?? "",
    streamSummary: context.streamSummary ?? "",
  }),
  initial: "tagline",
  states: {
    tagline: {
      invoke: {
        id: "tagline",
        src: "streamTagline",
        input: ({ context }) => ({ product: context.product }),
        // Close this stream's lane and restart the clock for the next one.
        onDone: ({ context, output }) => {
          const now = Date.now();
          return {
            target: "pitch",
            context: {
              tagline: output,
              startedAt: now,
              streamSummary: streamLane("tagline", output, now - context.startedAt),
            },
          };
        },
      },
    },
    pitch: {
      invoke: {
        id: "pitch",
        src: "streamPitch",
        input: ({ context }) => ({ product: context.product, tagline: context.tagline ?? "" }),
        onDone: ({ context, output }) => {
          const now = Date.now();
          const lane = streamLane("pitch", output, now - context.startedAt);
          return {
            target: "done",
            context: {
              pitch: output,
              streamSummary: `${context.streamSummary ?? ""} · ${lane}`.trim(),
            },
          };
        },
      },
    },
    done: { type: "final" },
  },
});

/** Options for {@link agentRunToUIMessageStream}: the run inputs it forwards to `runAgent`. */
export type AgentUiStreamOptions<TMachine extends AnyStateMachine> = Pick<
  RunAgentOptions<TMachine>,
  "input" | "executors" | "signal"
>;

/**
 * Bridges a `runAgent` run to a UI message stream. Starts the run, translates
 * its streaming seams into UI message chunks, and closes the stream when the run
 * settles. The returned `ReadableStream<UIMessageChunk>` is exactly what
 * `createUIMessageStreamResponse` / `useChat` consume.
 */
export function agentRunToUIMessageStream<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: AgentUiStreamOptions<TMachine> = {},
): ReadableStream<UIMessageChunk> {
  return createUIMessageStream({
    execute: async ({ writer }) => {
      // Open text parts, keyed by invoke id — a streamed request may still be
      // open when the next transition fires (parallel states), so track a set.
      const openTextParts = new Set<string>();

      writer.write({ type: "start" });

      const result = await runAgent(machine, {
        ...options,
        // Each streamed chunk becomes a text delta on its request's text part.
        onChunk: (chunk, { request }) => {
          if (!openTextParts.has(request.id)) {
            openTextParts.add(request.id);
            writer.write({ type: "text-start", id: request.id });
          }
          writer.write({ type: "text-delta", id: request.id, delta: chunk });
        },
        // A resolved request closes its text part.
        onResult: (request) => {
          if (openTextParts.delete(request.id)) {
            writer.write({ type: "text-end", id: request.id });
          }
        },
        // Every machine transition surfaces as a data part the client can render.
        onTransition: (snapshot) => {
          const state = String((snapshot as AnyMachineSnapshot).value);
          writer.write({ type: AGENT_STATE_PART, data: { state } });
        },
      });

      // Close any part still open (e.g. the run errored mid-stream), surface a
      // non-done outcome as an error frame, then close the message.
      for (const id of openTextParts) {
        writer.write({ type: "text-end", id });
      }
      if (result.status !== "done") {
        writer.write({ type: "error", errorText: `agent run ${result.status}` });
      }
      writer.write({ type: "finish" });
    },
  });
}

/** Minimal shim for the web `Request` a route handler reads: this repo has no DOM
 * lib. In a real Next/Hono/Express app `Request` is global — delete this. */
export interface ChatRequest {
  json(): Promise<unknown>;
}

/**
 * A `POST /api/chat`-shaped handler: reads `{ product }` off the request body,
 * runs the machine, and returns the UI message stream as an SSE `Response`. A
 * `useChat({ api: '/api/chat' })` client points at this unchanged.
 */
export async function handleChatRequest(
  request: ChatRequest,
  executors: RunAgentOptions<typeof aiSdkUiStreamMachine>["executors"],
) {
  const body = ((await request.json()) ?? {}) as { product?: string };
  const stream = agentRunToUIMessageStream(aiSdkUiStreamMachine, {
    input: { product: body.product ?? "a state-machine agent framework" },
    executors,
  });
  return createUIMessageStreamResponse({ stream });
}

export interface RunAiSdkUiStreamOptions {
  product?: string;
  /** Injected for tests; the direct run supplies a real streaming executor. */
  streamText?: AgentRequestExecutor;
  /** Observes each message snapshot as the stream is reconstructed. */
  onMessage?: (message: UIMessage) => void;
}

export interface AiSdkUiStreamResult {
  /** The text parts concatenated: the full streamed answer. */
  text: string;
  /** The `data-agent-state` parts, in order — every machine state entered. */
  states: string[];
}

type MessagePart = UIMessage["parts"][number];

const isTextPart = (part: MessagePart): part is { type: "text"; text: string } =>
  part.type === "text";

const isAgentStatePart = (
  part: MessagePart,
): part is { type: typeof AGENT_STATE_PART; data: { state: string } } =>
  part.type === AGENT_STATE_PART;

/**
 * Runs the machine, bridges it to a UI message stream, and reconstructs the
 * message server-side with `readUIMessageStream` (no React needed — a `useChat`
 * client points {@link handleChatRequest} instead, unchanged).
 */
export async function runAiSdkUiStreamExample(
  options: RunAiSdkUiStreamOptions = {},
): Promise<AiSdkUiStreamResult> {
  const { product = "a state-machine agent framework", streamText, onMessage } = options;
  const executors = streamText ? { streamText } : createAiSdkExecutors({ models });
  const stream = agentRunToUIMessageStream(aiSdkUiStreamMachine, { input: { product }, executors });

  // readUIMessageStream yields the message re-materialized after each chunk; the
  // last snapshot carries every part.
  let message: UIMessage | undefined;
  for await (const next of readUIMessageStream({ stream })) {
    message = next;
    onMessage?.(next);
  }

  const parts = message?.parts ?? [];
  return {
    text: parts
      .filter(isTextPart)
      .map((part) => part.text)
      .join(""),
    states: parts.filter(isAgentStatePart).map((part) => part.data.state),
  };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const product = "a state-machine agent framework";
    console.log(`Streaming UI message parts for: ${product}\n`);

    // Print text as it arrives (the delta since the last snapshot), the way a
    // useChat client would render it live.
    let printed = 0;
    const result = await runAiSdkUiStreamExample({
      product,
      onMessage: (message) => {
        const text = message.parts
          .filter(isTextPart)
          .map((part) => part.text)
          .join("");
        if (text.length > printed) {
          process.stdout.write(text.slice(printed));
          printed = text.length;
        }
      },
    });

    console.log(`\n\nStates entered: ${result.states.join(" → ")}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
