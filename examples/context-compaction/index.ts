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
 * Tuning: higher `maxMessages` = fewer summarize calls, more verbatim fidelity,
 * larger per-turn context; higher `keepRecent` = recent nuance survives
 * compaction at the cost of window size. Keep `keepRecent` comfortably below
 * `maxMessages` or the machine compacts on nearly every turn. Counting
 * messages is the simplest trigger; to use a token budget instead, swap the
 * `checkingWindow` predicate for a token estimate — nothing else moves.
 *
 * Human turns are machine events, not `agent.userInput`: `awaitingUser` has no
 * invoke, so the run settles **idle** there and a host (demo UI, test, or the
 * stdin loop below) resumes it with `USER_MESSAGE { text }`. The state carries
 * `meta.interaction` so hosts know what to label the input and where to route
 * free chat text (`textEvent`). Labels support `{contextKey}` interpolation.
 *
 * Type `exit` to end; the machine outputs the final summary, recent messages,
 * and turn count.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/context-compaction/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import type { SnapshotFrom } from "xstate";
import {
  type AgentMessage,
  type AgentRequestExecutor,
  assistantMessage,
  createAgentSchemas,
  getStateMeta,
  runAgent,
  setupAgent,
  systemMessage,
  userMessage,
} from "@statelyai/agent";

/**
 * Typed `meta.interaction` hints. Hosts read them off the idle snapshot to
 * label the input box and route free chat text to an event.
 */
const metaSchema = z.object({
  interaction: z
    .object({
      label: z.string(),
      events: z
        .record(
          z.string(),
          z.object({
            label: z.string().optional(),
            style: z.enum(["primary", "danger", "default"]).optional(),
          }),
        )
        .optional(),
      textEvent: z.string().optional(),
    })
    .optional(),
});

// Annotated so the exported const has a portable, nameable type (TS2742).
export const models = defineModels({
  chat: openai("gpt-5.4-mini"),
});

export const contextCompactionSchemas = createAgentSchemas({
  context: z.object({
    messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
    summary: z.string().nullable(),
    turns: z.number(),
    maxMessages: z.number(),
    keepRecent: z.number(),
    pendingInput: z.string().nullable(),
    // The latest assistant reply, mirrored out of `messages` so a host that
    // renders context (the demo UI) can show it — message arrays are plumbing.
    reply: z.string(),
    // Human-readable window state, interpolated into the interaction label.
    windowStatus: z.string(),
  }),
  meta: metaSchema,
  events: {
    /** One human chat turn. The idle `awaitingUser` state waits for this. */
    USER_MESSAGE: z.object({ text: z.string() }),
  },
  input: z.object({
    // Compact once history grows past this many messages...
    maxMessages: z.number().default(8),
    // ...keeping this many recent messages verbatim after compaction.
    keepRecent: z.number().default(4),
  }),
  output: z.object({
    summary: z.string().nullable(),
    messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
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
  // Deterministic idle detection: the run settles whenever the machine is
  // parked in the tagged waiting-for-a-human state.
  isSuspended: (snapshot) => snapshot.hasTag("waiting"),
  requests: {
    // Chat reply. Rendered as: [summary-as-system?] + recent messages.
    respond: {
      schemas: {
        input: z.object({
          summary: z.string().nullable(),
          messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
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
          staleMessages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
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
    reply: "",
    windowStatus: "0 messages in the window, no summary yet",
  }),
  initial: "awaitingUser",
  states: {
    // No invoke: the run settles idle here and a host resumes it with
    // `USER_MESSAGE`. `meta.interaction.textEvent` tells the host that free
    // chat text becomes that event's single string field (`text`).
    awaitingUser: {
      tags: ["waiting"],
      meta: {
        interaction: {
          // `{turns}` / `{windowStatus}` resolve against the snapshot context.
          label: "Say something (turn {turns} — {windowStatus}). Type 'exit' to finish.",
          textEvent: "USER_MESSAGE",
          events: { USER_MESSAGE: { label: "Send", style: "primary" } },
        },
      },
      on: {
        USER_MESSAGE: ({ event }) => ({
          target: "routingInput",
          context: { pendingInput: event.text },
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
        onDone: ({ context, output }) => {
          const messages = [
            ...context.messages,
            userMessage(context.pendingInput ?? ""),
            assistantMessage(output),
          ];
          return {
            target: "checkingWindow",
            context: {
              messages,
              turns: context.turns + 1,
              pendingInput: null,
              reply: output,
              windowStatus: `${messages.length}/${context.maxMessages} messages${
                context.summary ? ", summary active" : ", no summary yet"
              }`,
            },
          };
        },
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
            windowStatus: `compacted to ${context.keepRecent} recent messages, summary active`,
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

type CompactionSnapshot = SnapshotFrom<typeof contextCompactionMachine>;

/** `{key}` placeholders in interaction labels resolve against context. */
export function resolveInteractionLabel(label: string, context: Record<string, unknown>): string {
  return label
    .replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = context[key];
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** The prompt a host shows while the machine sits idle in `awaitingUser`. */
export function idlePrompt(snapshot: CompactionSnapshot): string {
  const label = getStateMeta(snapshot).interaction?.label ?? "You:";
  return resolveInteractionLabel(label, snapshot.context);
}

/**
 * Dual-mode runner. The test passes mocked executors and a scripted message
 * queue (so CI stays keyless); the direct run below uses real models + stdin.
 */
export async function runContextCompactionExample(options?: {
  input?: { maxMessages?: number; keepRecent?: number };
  generateText?: AgentRequestExecutor;
  /** Scripted chat turns, consumed in order on each idle settle. */
  userMessages?: string[];
  onTransition?: (snapshot: CompactionSnapshot) => void;
}) {
  const queued = [...(options?.userMessages ?? [])];
  const shared = {
    executors: options?.generateText
      ? { generateText: options.generateText }
      : createAiSdkExecutors({ models }),
    ...(options?.onTransition ? { onTransition: options.onTransition } : {}),
  };

  let result = await runAgent(contextCompactionMachine, {
    input: {
      maxMessages: options?.input?.maxMessages ?? 8,
      keepRecent: options?.input?.keepRecent ?? 4,
    },
    ...shared,
  });

  // Each chat turn settles the run idle. Resume from `persistedSnapshot`.
  while (result.status === "idle") {
    const text = queued.length
      ? (queued.shift() as string)
      : options?.userMessages
        ? "exit"
        : await promptLine(`${idlePrompt(result.snapshot)}\n> `);
    result = await runAgent(contextCompactionMachine, {
      snapshot: result.persistedSnapshot,
      event: { type: "USER_MESSAGE", text },
      ...shared,
    });
  }

  if (result.status !== "done") {
    throw new Error(`Context compaction did not complete: ${result.status}`);
  }
  return result;
}

export async function main() {
  const result = await runContextCompactionExample({
    onTransition: (snapshot) => {
      console.log("[state]", JSON.stringify(snapshot.value));
      if (snapshot.value === "compacting") {
        console.log("\n[compacting context...]");
      }
      // Print the latest assistant reply as it lands.
      const last = snapshot.context.messages.at(-1);
      if (snapshot.value === "checkingWindow" && last?.role === "assistant") {
        const text = typeof last.content === "string" ? last.content : "";
        console.log(`Assistant: ${text}`);
      }
    },
  });

  console.log(`\nTurns: ${result.output.turns}`);
  console.log(`Kept ${result.output.messages.length} recent messages.`);
  if (result.output.summary) {
    console.log(`\nRunning summary:\n${result.output.summary}`);
  }
}

/** Prompt once on stdin and resolve the trimmed reply. */
async function promptLine(query: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
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
