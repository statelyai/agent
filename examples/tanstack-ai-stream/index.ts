/**
 * TanStack AI stream — bridge a `runAgent` run to TanStack AI's wire protocol
 * so a `useChat` client streams a state-machine agent live.
 *
 * TanStack AI's server helpers take an `AsyncIterable<StreamChunk>` of AG-UI
 * events and hand back an SSE `Response`; `useChat` on the client consumes it.
 * Nothing in that contract assumes a model call, so a machine run drops
 * straight in: `agentRunToAgUiStream` fans runAgent's observational seams into
 * AG-UI events —
 *   - `onChunk`     → `TEXT_MESSAGE_CONTENT` deltas, one assistant message per
 *                     streamed request (keyed by invoke id).
 *   - `onResult`    → `TEXT_MESSAGE_END`, closing that message.
 *   - `onTransition`→ `STEP_STARTED` / `STEP_FINISHED`, so the UI can name the
 *                     machine state producing each token.
 *   - the settled result → `RUN_FINISHED` (or `RUN_ERROR`).
 * `toServerSentEventsResponse(stream)` then serves it, and a
 * `useChat({ connection: fetchServerSentEvents('/api/chat') })` client needs no
 * changes — see ./chat.tsx.
 *
 * The machine is a two-step streaming answer (outline → answer), so a single
 * chat turn produces two assistant messages and four step events.
 *
 * This example is a real workspace package depending on real `@tanstack/ai` and
 * `@tanstack/ai-react`, so every type below is the published one and CI catches
 * API drift. It is not a full Start project (no route tree) — see the wiring
 * note on `POST` at the bottom. `pnpm dev` boots a plain Vite server that mounts
 * ./chat.tsx and serves this handler at `/api/chat`; see ./vite.config.ts.
 *
 * Run in the browser: pnpm --filter @statelyai/example-tanstack-ai-stream dev
 * Run on the command line: OPENAI_API_KEY=... npx tsx examples/tanstack-ai-stream/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import type { AnyMachineSnapshot, AnyStateMachine } from "xstate";
import {
  createScriptedExecutors,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
  type AgentTextRequest,
  type RunAgentOptions,
} from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { maybeCreateRunInspection } from "./inspect.js";
import {
  chatParamsFromRequest,
  EventType,
  toServerSentEventsResponse,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
// On shims: this example used to hand-write stand-ins for `@tanstack/ai` and
// `@tanstack/ai-react`, to keep fast-moving meta-frameworks out of the library's
// devDeps. That traded CI noise for silent drift — a shim only stays honest
// until the upstream package moves. Host examples for frameworks published on
// npm are now real workspace packages (this one, ../next-host,
// ../tanstack-start-host) with real dependencies, so the typecheck catches drift
// instead of a dated comment claiming it was verified once. The examples still
// on shims are the ones with nothing to depend on: ../flue-host and ../eve-host
// target unpublished hosts, and ../langsmith-otel stubs an exporter on purpose.

export const models = defineModels({
  writer: openai("gpt-5.4-mini"),
});

// ─── The machine: outline the answer, then write it ───

const contextSchema = z.object({
  question: z.string(),
  outline: z.string().nullable(),
  answer: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ question: z.string() }),
  output: z.object({ outline: z.string(), answer: z.string() }),
  requests: {
    // Two streamed requests: each becomes its own assistant message on the wire.
    streamOutline: {
      mode: "stream",
      schemas: {
        input: z.object({ question: z.string() }),
        output: z.string(),
      },
      model: "writer",
      system: "Sketch a two-bullet outline of the answer. No preamble.",
      prompt: ({ input }) => input.question,
    },
    streamAnswer: {
      mode: "stream",
      schemas: {
        input: z.object({ question: z.string(), outline: z.string() }),
        output: z.string(),
      },
      model: "writer",
      system: "Answer in two sentences, following the outline.",
      prompt: ({ input }) => `Question: ${input.question}\nOutline: ${input.outline}`,
    },
  },
});

export const tanstackAiStreamMachine = agentSetup.createMachine({
  id: "tanstack-ai-stream",
  context: ({ input }) => ({
    question: input.question,
    outline: null,
    answer: null,
  }),
  // Both fields are set before `done`; fall back to "" to satisfy the output type.
  output: ({ context }) => ({
    outline: context.outline ?? "",
    answer: context.answer ?? "",
  }),
  initial: "outlining",
  states: {
    outlining: {
      invoke: {
        id: "outline",
        src: "streamOutline",
        input: ({ context }) => ({ question: context.question }),
        onDone: ({ output }) => ({
          target: "answering",
          context: { outline: output },
        }),
      },
    },
    answering: {
      invoke: {
        id: "answer",
        src: "streamAnswer",
        input: ({ context }) => ({
          question: context.question,
          outline: context.outline ?? "",
        }),
        onDone: ({ output }) => ({
          target: "done",
          context: { answer: output },
        }),
      },
    },
    done: { type: "final" },
  },
});

// ─── runAgent → AG-UI events ───

/**
 * A push queue bridging callbacks to an async iterable. runAgent reports
 * progress by calling handlers; TanStack AI wants something to `for await` over,
 * so events are buffered here and drained as they arrive.
 */
function createChunkQueue<T>() {
  const buffer: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  return {
    push(item: T): void {
      buffer.push(item);
      wake?.();
      wake = null;
    },
    close(): void {
      closed = true;
      wake?.();
      wake = null;
    },
    async *drain(): AsyncGenerator<T> {
      while (true) {
        while (buffer.length > 0) yield buffer.shift() as T;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/** Options for {@link agentRunToAgUiStream}: the run inputs it forwards to `runAgent`. */
export type AgentAgUiStreamOptions<TMachine extends AnyStateMachine> = Pick<
  RunAgentOptions<TMachine>,
  "input" | "executors" | "signal" | "inspect"
> & {
  /** AG-UI conversation/run identifiers echoed on the run-level events. */
  threadId?: string;
  runId?: string;
};

/**
 * Bridges a `runAgent` run to an AG-UI event stream. Starts the run, translates
 * its streaming seams into wire events, and ends the stream when the run
 * settles. The returned iterable is exactly what `toServerSentEventsResponse`
 * (and `useChat`) consume.
 */
export async function* agentRunToAgUiStream<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: AgentAgUiStreamOptions<TMachine> = {},
): AsyncGenerator<StreamChunk> {
  const { threadId = crypto.randomUUID(), runId = crypto.randomUUID(), ...runOptions } = options;
  const queue = createChunkQueue<StreamChunk>();
  // Every AG-UI event carries an optional `timestamp`; stamp it once here so no
  // call site has to remember.
  const emit = (chunk: StreamChunk) => queue.push({ ...chunk, timestamp: Date.now() });

  // Assistant messages still open, keyed by invoke id — a streamed request may
  // outlive the transition that started it (parallel states), so track a set.
  const openMessages = new Set<string>();
  let currentStep: string | null = null;

  emit({ type: EventType.RUN_STARTED, threadId, runId });

  const run = runAgent(machine, {
    ...runOptions,
    onChunk: (chunk, { request }) => {
      if (!openMessages.has(request.id)) {
        openMessages.add(request.id);
        // `role` is required on TEXT_MESSAGE_START (the AG-UI schema defaults it
        // to "assistant", so the parsed type has it non-optional).
        emit({
          type: EventType.TEXT_MESSAGE_START,
          messageId: request.id,
          role: "assistant",
        });
      }
      emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: request.id,
        delta: chunk,
      });
    },
    onResult: (request) => {
      if (openMessages.delete(request.id)) {
        emit({ type: EventType.TEXT_MESSAGE_END, messageId: request.id });
      }
    },
    // Each machine state becomes an AG-UI step: close the previous, open the next.
    onTransition: (snapshot) => {
      const stepName = String((snapshot as AnyMachineSnapshot).value);
      if (stepName === currentStep) return;
      if (currentStep !== null) emit({ type: EventType.STEP_FINISHED, stepName: currentStep });
      emit({ type: EventType.STEP_STARTED, stepName });
      currentStep = stepName;
    },
  }).then(
    (result) => {
      // Close anything still open (e.g. the run errored mid-stream), then the step.
      for (const id of openMessages) emit({ type: EventType.TEXT_MESSAGE_END, messageId: id });
      if (currentStep !== null) emit({ type: EventType.STEP_FINISHED, stepName: currentStep });

      if (result.status === "done") {
        emit({ type: EventType.RUN_FINISHED, threadId, runId, result: result.output });
      } else {
        emit({ type: EventType.RUN_ERROR, message: `agent run ${result.status}` });
      }
      queue.close();
    },
    (error: unknown) => {
      emit({
        type: EventType.RUN_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      queue.close();
    },
  );

  yield* queue.drain();
  await run;
}

// ─── The route ───

/** What the scripted stand-in answers, keyed by `setupAgent({ requests })` key. */
const scriptedAnswers: Record<string, string> = {
  streamOutline: "- what they are\n- why they help",
  streamAnswer: "State machines make an agent's control flow explicit and replayable.",
};

/**
 * Keyless executors so the route runs with no API key: `createScriptedExecutors`
 * holds the answers (function entries route on `request.name`, so the script
 * does not depend on which request runs first), and `streamText` is wrapped to
 * replay them word by word — a single chunk per message would be a valid stream
 * but a dull one, and the client should see real incremental deltas.
 *
 * A fresh script per run: the queues are consumed FIFO, so a shared instance
 * would run dry on the second chat turn.
 */
export function createScriptedChatExecutors(): AgentRequestExecutors {
  const answer = (request: AgentTextRequest) => scriptedAnswers[request.name ?? ""] ?? "";
  const scripted = createScriptedExecutors({ text: [answer, answer] });

  return {
    ...scripted,
    streamText: async (request, info) => {
      // Drawing from `generateText` takes the entry off the shared queue without
      // the built-in whole-string chunk, leaving the deltas to this loop.
      const result = await scripted.generateText(request);
      for (const delta of String(result.output).split(/(?<=\s)/)) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        info?.onChunk?.(delta);
      }
      return result;
    },
  };
}

/** Real models when `OPENAI_API_KEY` is set, scripted playback otherwise. */
export function resolveExecutors(): AgentRequestExecutors {
  return process.env.OPENAI_API_KEY
    ? createAiSdkExecutors({ models })
    : createScriptedChatExecutors();
}

/** Flattens a parsed AG-UI message to plain text, whichever shape it arrived in. */
export function messageText(message: UIMessage | { content?: unknown }): string {
  if ("parts" in message && Array.isArray(message.parts)) {
    return message.parts
      .map((part) => (part.type === "text" ? part.content : ""))
      .join("")
      .trim();
  }
  const { content } = message as { content?: unknown };
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "content" in part ? part.content : ""))
      .join("")
      .trim();
  }
  return "";
}

/**
 * The `POST /api/chat` handler: parses the AG-UI request body, runs the machine
 * on the newest question, and returns the event stream as an SSE `Response`.
 *
 * `chatParamsFromRequest` is TanStack AI's own parser for the AG-UI wire body.
 * It validates STRICTLY — `threadId`, `runId`, `messages[].id`, `tools` and
 * `context` are all required by the protocol — and throws a 400 `Response` if
 * the body does not conform, which is why the catch below re-throws it as-is.
 */
export async function handleChatRequest(
  request: Request,
  executors: AgentRequestExecutors = resolveExecutors(),
): Promise<Response> {
  const params = await chatParamsFromRequest(request);
  const lastUser = [...params.messages].reverse().find((message) => message.role === "user");
  const question = (lastUser ? messageText(lastUser) : "") || "Why state machines for agents?";

  const stream = agentRunToAgUiStream(tanstackAiStreamMachine, {
    input: { question },
    executors,
    inspect: await maybeCreateRunInspection(),
    threadId: params.threadId,
    runId: params.runId,
  });
  return toServerSentEventsResponse(stream);
}

/**
 * The server-route handler. In a real TanStack Start app this file lives at
 * `src/routes/api/chat.ts` and the export is a generated file route:
 *
 *   import { createFileRoute } from '@tanstack/react-router';
 *   export const Route = createFileRoute('/api/chat')({
 *     server: { handlers: { POST } },
 *   });
 *
 * That call is deliberately NOT made here: `createFileRoute`'s path parameter is
 * typed `keyof FileRoutesByPath`, a union produced by Start's `routeTree.gen.ts`
 * codegen. Without a generated route tree the union is empty, so the call cannot
 * typecheck — and faking the augmentation would just be a shim in disguise. The
 * handler itself is the part worth testing, so it is exported directly.
 */
export const POST = ({ request }: { request: Request }): Promise<Response> =>
  handleChatRequest(request);

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const question = "Why state machines for agents?";
    console.log(`POST /api/chat → { question: ${JSON.stringify(question)} }\n`);
    console.log("SSE frames as a useChat client would receive them:\n");

    // Consume the real route response, printing the wire bytes verbatim.
    const response = await handleChatRequest(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thread-1",
          runId: "run-1",
          messages: [{ id: "m1", role: "user", content: question }],
          tools: [],
          context: [],
        }),
      }),
      createAiSdkExecutors({ models }),
    );

    const body = response.body;
    if (!body) throw new Error("no response body");
    const decoder = new TextDecoder();
    for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
      process.stdout.write(decoder.decode(bytes, { stream: true }));
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
