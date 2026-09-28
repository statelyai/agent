/**
 * Long-term memory — LangGraph's memory-agent template as a machine whose
 * memory store is an injected value, recalled before every answer and written
 * after it.
 *
 * The idea: a chat assistant that remembers facts about a user across
 * conversations. Before answering it searches the user's memories for the
 * relevant ones; after answering it saves anything new worth remembering. The
 * store outlives the thread, so a later conversation starts knowing what an
 * earlier one learned.
 *
 * LangGraph shape (langchain-ai/memory-agent) — a model node that may call an
 * `upsert_memory` tool, a store node, and a loop per user message:
 *
 *   START → call_model ─┬─ (upsert_memory call) → store_memory → call_model
 *                       └─ (no tool call) → END   (wait for the next message)
 *
 *   call_model reads `store.search(("memories", user_id))`; the store persists
 *   across threads.
 *
 * Here recall, answering and saving are three visible states, and the store is
 * a plain `string[]` that comes in as input and goes out as output:
 *
 *   awaitingMessage ──MESSAGE──▶ recalling → answering → savingMemories ─┬─▶ awaitingMessage
 *          │                                                             └─▶ done (turn limit)
 *          └──END_SESSION──▶ done
 *
 * What maps to what:
 *   - store.search(namespace)   → `recalling` (ONE Jev call, one boolean question per stored
 *                                 memory; top `RECALL_LIMIT` above `RECALL_THRESHOLD`)
 *   - call_model                → `answering` (request `answer`: reply + the new
 *                                 facts worth remembering, as structured output)
 *   - upsert_memory tool call   → `newMemories` in that structured output; there is
 *                                 no tool round-trip, the machine writes them
 *   - store_memory              → `savingMemories` (a `choice` state: dedupe,
 *                                 append, cap at `MAX_MEMORIES`, then route)
 *   - END (wait for a message)  → `awaitingMessage`, a resting state with
 *                                 `meta.interaction` and `textEvent: "MESSAGE"`
 *   - the store / user_id       → machine input `{ userId, memories }`, returned
 *                                 in output `memories` for the host to persist
 *
 * Differences from LangGraph worth calling out:
 *   - Recall is a JUDGMENT, not a search. The template embeds the message and
 *     takes the nearest memories. Here `recalling` calls the AI SDK's
 *     `experimental_evaluate` with Jev (`@ai-sdk/typesafe-ai`) as the
 *     evaluation model, with the message and the whole store as state and one
 *     boolean question per memory ("does this fact bear on the message?"). The
 *     probabilities rank the store; the threshold and `RECALL_LIMIT` are code
 *     (`searchMemoryStore`). The text model is reserved for `answering`.
 *   - The store is injected, not ambient. There is no module-level store and no
 *     `BaseStore` handle in config: the host passes the user's memories in and
 *     saves `output.memories` back. Cross-thread memory is "start the next run
 *     from the last run's output", which the tests do literally.
 *   - Recall is a state, not a line inside the model node, so what the model
 *     was shown is visible in the request input for every turn.
 *   - The store is capped. `MAX_MEMORIES` is enforced in `savingMemories`, which
 *     drops the oldest facts and counts them as `evicted`; the template's store
 *     grows without bound.
 *   - The session is bounded. After `MAX_TURNS` messages the run ends in `done`
 *     with a notice. This is deliberately NOT a failure: every message was
 *     answered and every memory saved; the session simply closes, the same as
 *     `END_SESSION`. (The usual "budget exhausted → failed" rule is for loops
 *     that owe an answer they could not produce; this one owes nothing.)
 *
 * Stand-in: the store is an in-memory list, and every recall judges all of
 * it (at most `MAX_MEMORIES`). An empty store has nothing to judge: the actor
 * returns no answers without calling the judge, so `recalling` answers with
 * nothing recalled, the same as a failed search.
 *
 * Dual-mode: `runLongTermMemoryExample(options?)` takes an injectable
 * `generateText`, an injectable judge model, and scripted human events (tests
 * pass all three, so CI needs no API key); the direct run uses real models
 * and stdin.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/long-term-memory/index.ts
 */
import { z } from "zod";
import { createAsyncLogic, type SnapshotFrom } from "xstate";
import { openai } from "@ai-sdk/openai";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getInteraction,
  getStatePath,
  interactionMetaSchema,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

const models = {
  assistant: openai("gpt-5.4-mini"),
};

/**
 * The judge: TypeSafe's Jev through the AI SDK's evaluation-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock evaluation model instead.
 */
const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

/** Messages one session answers before it closes (in `done`, not `failed`). */
export const MAX_TURNS = 8;

/** Facts the store keeps; saving past this drops the oldest. */
export const MAX_MEMORIES = 20;

/** Memories recalled per message. */
export const RECALL_LIMIT = 3;

/** Transcript lines the model sees besides the recalled memories. */
const TRANSCRIPT_TAIL = 6;

/** A memory is recalled when Jev's probability that it bears on the message clears this. */
export const RECALL_THRESHOLD = 0.5;

/**
 * store.search as a judgment: the message and every stored memory are the
 * state, and each memory gets its own boolean question. One call, one
 * probability per memory. The judge model is injected by tests and hosts; the
 * default is Jev, which reads `TYPESAFE_AI_API_KEY` from the environment.
 */
export function createSearchMemories(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: Record<string, { probability: number }> },
    { message: string; memories: string[] }
  >({
    run: async ({ input, signal }) => {
      if (input.memories.length === 0) return { answers: {} };
      const { answers } = await evaluate({
        model,
        state: { message: input.message, memories: input.memories },
        questions: Object.fromEntries(
          input.memories.map((_memory, index) => [
            `memory${index}`,
            {
              type: "boolean" as const,
              instructions: `Does \`memories[${index}]\` state a fact about the user that bears on answering \`message\`?`,
              criteria: {
                true: "The reply would be better or more personal for knowing this fact.",
                false: "The fact is about something else, or only shares a word with the message.",
              },
            },
          ]),
        ),
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/**
 * The recall cut, pure: memories whose relevance clears `RECALL_THRESHOLD`,
 * most relevant first (newer first on a tie), at most `limit`. `relevance[i]`
 * is Jev's probability for `memories[i]`.
 */
export function searchMemoryStore(
  memories: string[],
  relevance: Array<number | undefined>,
  limit: number,
): string[] {
  return memories
    .map((text, index) => ({ text, index, p: relevance[index] ?? 0 }))
    .filter((scored) => scored.p >= RECALL_THRESHOLD)
    .sort((left, right) => right.p - left.p || right.index - left.index)
    .slice(0, limit)
    .map((scored) => scored.text);
}

/** Dedupe (case/space-insensitive), append, and keep the newest `MAX_MEMORIES`. */
function mergeMemories(store: string[], incoming: string[]) {
  const key = (fact: string) => fact.trim().toLowerCase().replace(/\s+/g, " ");
  const seen = new Set(store.map(key));
  const added: string[] = [];
  for (const fact of incoming) {
    const k = key(fact);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    added.push(fact.trim());
  }
  const merged = [...store, ...added];
  const evicted = Math.max(0, merged.length - MAX_MEMORIES);
  return { memories: merged.slice(evicted), added: added.length, evicted };
}

const longTermMemoryContextSchema = z.object({
  userId: z.string(),
  /** The injected store. Returned in output so the host can persist it. */
  memories: z.array(z.string()),
  /** The message being answered this turn. */
  message: z.string(),
  /** What `recalling` found for `message`. */
  recalled: z.array(z.string()),
  /** Facts the last answer proposed, waiting for `savingMemories`. */
  pendingMemories: z.array(z.string()),
  /** The assistant's last reply (the one human-readable progress string). */
  reply: z.string(),
  /** "User: …" / "Assistant: …" lines for this session. */
  transcript: z.array(z.string()),
  turns: z.number(),
  recalledTotal: z.number(),
  savedTotal: z.number(),
  evicted: z.number(),
  failure: z.string().nullable(),
});

type LongTermMemoryContext = z.infer<typeof longTermMemoryContextSchema>;

/** The session summary both final states lead with. */
function renderSummary(context: LongTermMemoryContext, ending: string): string {
  return [
    ending,
    context.reply ? `Last reply: ${context.reply}` : "",
    `Session for ${context.userId}: ${context.turns} message(s), ` +
      `${context.recalledTotal} memory recall(s), ${context.savedTotal} new memor${context.savedTotal === 1 ? "y" : "ies"} saved` +
      (context.evicted > 0 ? `, ${context.evicted} oldest evicted (cap ${MAX_MEMORIES})` : "") +
      ".",
    `The store now holds ${context.memories.length}/${MAX_MEMORIES} memories.`,
  ]
    .filter(Boolean)
    .join("\n");
}

const agentSetup = setupAgent({
  models,
  meta: interactionMetaSchema,
  context: longTermMemoryContextSchema,
  input: z.object({
    userId: z.string().default("demo"),
    memories: z.array(z.string()).default([]),
  }),
  output: z.object({
    summary: z.string(),
    memories: z.array(z.string()),
    turns: z.number(),
  }),
  events: {
    MESSAGE: z.object({ text: z.string() }),
    END_SESSION: z.object({}),
  },
  actors: {
    // store.search: a Jev judgment per memory (see createSearchMemories).
    searchMemories: createSearchMemories(),
  },
  requests: {
    // call_model: answer with the recalled memories in view, and name any new
    // durable facts (the upsert_memory tool's arguments, as structured output).
    answer: {
      schemas: {
        input: z.object({
          userId: z.string(),
          message: z.string(),
          memories: z.array(z.string()),
          transcript: z.array(z.string()),
        }),
        output: z.object({
          reply: z.string(),
          newMemories: z.array(z.string()),
        }),
      },
      model: "assistant",
      system:
        "You are a helpful assistant with long-term memory about the user. Use the " +
        "recalled memories when they are relevant; do not invent memories. Reply " +
        "briefly. Then list in newMemories any NEW durable facts about the user from " +
        "their latest message (name, preferences, plans, relationships), each as one " +
        "short third-person sentence. Leave newMemories empty if there is nothing new.",
      prompt: ({ input }) =>
        [
          `User id: ${input.userId}`,
          "Recalled memories:",
          input.memories.length ? input.memories.map((fact) => `- ${fact}`).join("\n") : "(none)",
          "",
          "Recent conversation:",
          input.transcript.length ? input.transcript.join("\n") : "(start of session)",
          "",
          `User: ${input.message}`,
        ].join("\n"),
    },
  },
});

export const longTermMemorySchemas = agentSetup.schemas;

export const longTermMemoryMachine = agentSetup.createMachine({
  id: "long-term-memory",
  context: ({ input }) => ({
    userId: input.userId,
    memories: input.memories,
    message: "",
    recalled: [],
    pendingMemories: [],
    reply:
      input.memories.length > 0
        ? `Welcome back. I have ${input.memories.length} memor${input.memories.length === 1 ? "y" : "ies"} about you. What's on your mind?`
        : "Hi! I don't know anything about you yet. What's on your mind?",
    transcript: [],
    turns: 0,
    recalledTotal: 0,
    savedTotal: 0,
    evicted: 0,
    failure: null,
  }),
  initial: "awaitingMessage",
  states: {
    // Resting state: the run settles idle and a host resumes with MESSAGE or
    // END_SESSION. The label is the assistant's last reply.
    awaitingMessage: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{reply}",
          textEvent: "MESSAGE",
          events: {
            MESSAGE: { label: "Send", style: "primary" },
            END_SESSION: { label: "End session" },
          },
        },
      },
      on: {
        MESSAGE: ({ context, event }) => ({
          target: "recalling",
          context: { message: event.text, turns: context.turns + 1 },
        }),
        END_SESSION: { target: "done" },
      },
    },
    // store.search before every answer: keep the top RECALL_LIMIT memories
    // that clear the threshold. A search failure (or an empty store, which has
    // no questions to ask) degrades to answering with nothing recalled rather
    // than dropping the message.
    recalling: {
      invoke: {
        src: "searchMemories",
        input: ({ context }) => ({ message: context.message, memories: context.memories }),
        onDone: ({ context, output }) => {
          const recalled = searchMemoryStore(
            context.memories,
            context.memories.map((_memory, index) => output.answers[`memory${index}`]?.probability),
            RECALL_LIMIT,
          );
          return {
            target: "answering",
            context: { recalled, recalledTotal: context.recalledTotal + recalled.length },
          };
        },
        onError: () => ({ target: "answering", context: { recalled: [] } }),
      },
    },
    answering: {
      invoke: {
        src: "answer",
        input: ({ context }) => ({
          userId: context.userId,
          message: context.message,
          memories: context.recalled,
          transcript: context.transcript.slice(-TRANSCRIPT_TAIL),
        }),
        onDone: ({ context, output }) => ({
          target: "savingMemories",
          context: {
            reply: output.result.reply,
            pendingMemories: output.result.newMemories,
            transcript: [
              ...context.transcript,
              `User: ${context.message}`,
              `Assistant: ${output.result.reply}`,
            ],
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `answer failed: ${String(event.error)}` },
        }),
      },
    },
    // store_memory: dedupe + append + cap, then route. The turn limit is
    // checked here so the last message is still answered and saved.
    savingMemories: {
      type: "choice",
      choice: ({ context }) => {
        const saved = mergeMemories(context.memories, context.pendingMemories);
        const patch = {
          memories: saved.memories,
          pendingMemories: [],
          savedTotal: context.savedTotal + saved.added,
          evicted: context.evicted + saved.evicted,
        };
        return context.turns >= MAX_TURNS
          ? { target: "done", context: patch }
          : { target: "awaitingMessage", context: patch };
      },
    },
    // Both endings are successes: END_SESSION, or MAX_TURNS messages answered.
    done: {
      type: "final",
      output: ({ context }) => ({
        summary: renderSummary(
          context,
          context.turns >= MAX_TURNS
            ? `Session closed after the ${MAX_TURNS}-message limit (not a failure: every message was answered and saved).`
            : "Session ended by the user.",
        ),
        memories: context.memories,
        turns: context.turns,
      }),
    },
    // The model call failed. The store is returned unchanged from the last
    // completed save, so the host can still persist it.
    failed: {
      type: "final",
      output: ({ context }) => ({
        summary: renderSummary(context, `Session failed: ${context.failure ?? "unknown error"}`),
        memories: context.memories,
        turns: context.turns,
      }),
    },
  },
});

type LongTermMemorySnapshot = SnapshotFrom<typeof longTermMemoryMachine>;

/** What a host (or the test) sends to unblock the idle message state. */
export type LongTermMemoryHumanEvent = { type: "MESSAGE"; text: string } | { type: "END_SESSION" };

export interface RunLongTermMemoryOptions {
  userId?: string;
  /** The user's store, from a previous run's `output.memories`. */
  memories?: string[];
  /** Injected for tests; the direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** The judge model; tests pass a mock, the direct run uses Jev. */
  judge?: Experimental_EvaluationModel;
  /** Scripted human events, consumed in order on each idle settle; then stdin. */
  humanEvents?: LongTermMemoryHumanEvent[];
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
  /** Observes each reply shown while idle. */
  onReply?: (reply: string) => void;
}

export interface LongTermMemoryResult {
  summary: string;
  memories: string[];
  turns: number;
  /** The final state reached: `done` or `failed`. */
  outcome: string;
  progress: string[];
}

/** Runs one chat session, resuming from `persist()` on every idle settle. */
export async function runLongTermMemoryExample(
  options: RunLongTermMemoryOptions = {},
): Promise<LongTermMemoryResult> {
  const { userId = "demo", memories = [], generateText, judge, onProgress, onReply } = options;
  const queued = [...(options.humanEvents ?? [])];
  const progress: string[] = [];
  const shared = {
    executors: generateText ? { generateText } : createAiSdkExecutors({ models }),
    ...(judge ? { actors: { searchMemories: createSearchMemories(judge) } } : {}),
    onTransition: (snapshot: LongTermMemorySnapshot) => {
      const state = getStatePath(snapshot);
      // A resume re-reports the restored state; record each state once per visit.
      if (progress.at(-1) === state) return;
      progress.push(state);
      onProgress?.(state);
    },
  };

  let result = await runToQuiescence(
    createAgentRuntime(longTermMemoryMachine, {
      ...shared,
    }),
    {
      input: { userId, memories },
      ...shared,
    },
  );
  while (result.status === "idle") {
    const reply = getInteraction(result.snapshot)?.label ?? result.snapshot.context.reply;
    onReply?.(reply);
    const event = queued.shift() ?? toHumanEvent(await promptLine(`${reply}\n> `));
    result = await runToQuiescence(
      createAgentRuntime(longTermMemoryMachine, {
        ...shared,
      }),
      {
        snapshot: result.persist(),
        event,
        ...shared,
      },
    );
  }

  if (result.status !== "done") {
    throw new Error(`Long-term-memory example did not complete: ${result.status}`);
  }
  return { ...result.output, outcome: getStatePath(result.snapshot), progress };
}

/** `/end` (or an empty line) ends the session; anything else is a message. */
function toHumanEvent(text: string): LongTermMemoryHumanEvent {
  return text === "" || text === "/end" ? { type: "END_SESSION" } : { type: "MESSAGE", text };
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
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    // Two sessions for the same user: the second starts from the first's
    // output, which is the whole cross-thread memory claim.
    console.log("Session 1 (type /end or an empty line to finish)\n");
    const first = await runLongTermMemoryExample({ userId: "demo" });
    console.log(`\n${first.summary}\n\nSession 2, same store\n`);
    const second = await runLongTermMemoryExample({ userId: "demo", memories: first.memories });
    console.log(`\n${second.summary}`);
    console.log("\nMemories:\n" + second.memories.map((fact) => `- ${fact}`).join("\n"));
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
