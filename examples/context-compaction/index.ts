/**
 * Context compaction — a chat loop that manages its own context window.
 *
 * The Vercel AI SDK core does not auto-compact message history: growing the
 * `messages` array forever is a real userland concern. This machine handles it
 * as an *explicit state*, not hidden middleware:
 *
 *   - Bounded history: once `messages.length` exceeds `maxMessages`, an
 *     always-transition routes into a dedicated `compacting` state instead of
 *     letting the window grow unchecked.
 *   - Compaction as a machine state: `compacting` invokes a `summarize` request
 *     over the stale messages (everything but the last `keepRecent`) plus the
 *     prior summary, folding them into one running summary. The state is
 *     inspectable — you can see in the state chart exactly when the agent
 *     compacts, and pause/persist there.
 *   - Summary-as-context: the `respond` request is rendered from the running
 *     summary (as a system message) followed by only the recent messages, so
 *     every reply stays grounded in older turns without resending them.
 *
 * Type `exit` to end; the machine outputs the final summary, recent messages,
 * and turn count.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/context-compaction/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import {
  type AgentMessage,
  assistantMessage,
  createAgentSchemas,
  runAgent,
  setupAgent,
  systemMessage,
  userMessage,
} from "../../src/index.js";
import { runExampleMain } from "../helpers/main.js";

// Annotated so the exported const has a portable, nameable type (TS2742).
export const models = defineModels({
  chat: openai("gpt-5.4-mini"),
});

export const contextCompactionSchemas = createAgentSchemas({
  context: z.object({
    messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
    summary: z.string().nullable(),
    turns: z.number(),
    maxMessages: z.number(),
    keepRecent: z.number(),
    pendingInput: z.string().nullable(),
  }),
  input: z.object({
    // Compact once history grows past this many messages...
    maxMessages: z.number().default(8),
    // ...keeping this many recent messages verbatim after compaction.
    keepRecent: z.number().default(4),
  }),
  output: z.object({
    summary: z.string().nullable(),
    messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
    turns: z.number(),
  }),
});

const RESPOND_SYSTEM =
  "You are a helpful, concise assistant in an ongoing conversation. " +
  "Earlier turns may have been condensed into a context note; treat it as " +
  "established fact and stay consistent with it.";

const SUMMARIZE_SYSTEM =
  "You compact conversation history for context-window management. Fold the " +
  "PRIOR SUMMARY and the OLD MESSAGES into one compact summary. Preserve " +
  "concrete facts, names, numbers, decisions made, and any open questions. " +
  "Drop pleasantries and redundant phrasing. Write it as terse notes, not " +
  "prose. Return only the summary text.";

const agentSetup = setupAgent({
  schemas: contextCompactionSchemas,
  models,
  requests: {
    // Chat reply. Rendered as: [summary-as-system?] + recent messages.
    respond: {
      schemas: {
        input: z.object({
          summary: z.string().nullable(),
          messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
        }),
        output: z.string(),
      },
      model: "chat",
      system: RESPOND_SYSTEM,
      messages: ({ input }) => [
        ...(input.summary
          ? [systemMessage(`Summary of earlier conversation:\n${input.summary}`)]
          : []),
        ...input.messages,
      ],
    },
    // Compact stale history + prior summary into one running summary.
    summarize: {
      schemas: {
        input: z.object({
          priorSummary: z.string().nullable(),
          staleMessages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
        }),
        output: z.object({ summary: z.string() }),
      },
      model: "chat",
      system: SUMMARIZE_SYSTEM,
      prompt: ({ input }) =>
        [
          input.priorSummary
            ? `PRIOR SUMMARY:\n${input.priorSummary}`
            : "PRIOR SUMMARY:\n(none yet)",
          "",
          "OLD MESSAGES:",
          input.staleMessages
            .map((message) => {
              const text = typeof message.content === "string" ? message.content : "";
              return `${message.role}: ${text}`;
            })
            .join("\n"),
        ].join("\n"),
    },
  },
});

export const contextCompactionMachine = agentSetup.createMachine({
  id: "context-compaction",
  context: ({ input }) => ({
    messages: [],
    summary: null,
    turns: 0,
    maxMessages: input.maxMessages,
    keepRecent: input.keepRecent,
    pendingInput: null,
  }),
  initial: "awaitingUser",
  states: {
    awaitingUser: {
      tags: ["awaiting-user"],
      invoke: {
        src: "agent.userInput",
        input: { prompt: "You:" },
        onDone: ({ event }) => ({
          target: "routingInput",
          context: { pendingInput: String(event.output ?? "") },
        }),
      },
    },

    // Branch on the raw user input: literal "exit" (or empty) ends the loop.
    routingInput: {
      type: "choice",
      choice: ({ context }) => {
        const text = (context.pendingInput ?? "").trim().toLowerCase();
        return text === "exit" || text === "" ? { target: "done" } : { target: "responding" };
      },
    },

    responding: {
      invoke: {
        src: "respond",
        // Only the recent messages are resent; the summary carries the rest.
        input: ({ context }) => ({
          summary: context.summary,
          messages: [...context.messages, userMessage(context.pendingInput ?? "")],
        }),
        onDone: ({ context, output }) => ({
          target: "checkingWindow",
          context: {
            messages: [
              ...context.messages,
              userMessage(context.pendingInput ?? ""),
              assistantMessage(output),
            ],
            turns: context.turns + 1,
            pendingInput: null,
          },
        }),
        // On a failed reply, drop back to the prompt rather than stalling.
        onError: { target: "awaitingUser", context: { pendingInput: null } },
      },
    },

    // Always-check: compact when the window is over budget, else keep chatting.
    checkingWindow: {
      type: "choice",
      choice: ({ context }) =>
        context.messages.length > context.maxMessages
          ? { target: "compacting" }
          : { target: "awaitingUser" },
    },

    compacting: {
      invoke: {
        src: "summarize",
        // Summarize everything except the last `keepRecent` messages.
        input: ({ context }) => ({
          priorSummary: context.summary,
          staleMessages: context.messages.slice(0, -context.keepRecent),
        }),
        onDone: ({ context, output }) => ({
          target: "awaitingUser",
          context: {
            summary: output.summary,
            messages: context.messages.slice(-context.keepRecent),
          },
        }),
        // If summarization fails, keep going without dropping history.
        onError: { target: "awaitingUser" },
      },
    },

    done: {
      type: "final",
      output: ({ context }) => ({
        summary: context.summary,
        messages: context.messages,
        turns: context.turns,
      }),
    },
  },
});

const executors = createAiSdkExecutors({ models });

async function promptLine(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${question} `);
  } finally {
    rl.close();
  }
}

export async function main() {
  const result = await runAgent(contextCompactionMachine, {
    input: { maxMessages: 8, keepRecent: 4 },
    ...executors,
    userInput: async ({ prompt }) => promptLine(prompt ?? "You:"),
    onTransition: (snapshot) => {
      console.log("[state]", JSON.stringify(snapshot.value));
      if (snapshot.value === "compacting") {
        console.log("\n[compacting context...]");
      }
      // Print the latest assistant reply as it lands.
      const last = (snapshot.context.messages as AgentMessage[]).at(-1);
      if (snapshot.value === "checkingWindow" && last?.role === "assistant") {
        const text = typeof last.content === "string" ? last.content : "";
        console.log(`Assistant: ${text}`);
      }
    },
  });

  if (result.status !== "done") {
    throw new Error(`Context compaction did not complete: ${result.status}`);
  }

  console.log(`\nTurns: ${result.output.turns}`);
  console.log(`Kept ${result.output.messages.length} recent messages.`);
  if (result.output.summary) {
    console.log(`\nRunning summary:\n${result.output.summary}`);
  }
}

runExampleMain(import.meta.url, main);
