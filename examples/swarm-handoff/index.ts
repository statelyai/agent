/**
 * Swarm handoff — an active-agent conversation where the MODEL decides which
 * specialist should take the next turn, with the active agent persisted across
 * a JSON snapshot round-trip.
 *
 * Shows:
 *   - `context.activeAgent` tracks who is "holding the mic" ('travel' | 'food').
 *   - `context.history` is the one shared conversation: the agent that takes
 *     the mic after a handoff reads every earlier turn, so "what should I eat
 *     there?" still means Lisbon.
 *   - each agent has its own reply request (distinct model ref + system) that
 *     runs one conversation turn, then the machine settles idle in `waiting`.
 *   - the human only supplies the next message (SAY) or ends the conversation
 *     (END). Whether to hand off is a model decision: `routing` invokes
 *     `agent.decide` over HANDOFF / KEEP, and the HANDOFF transition guard
 *     rejects a handoff to the agent that already holds the mic, so the
 *     decision retries instead of a no-op switch landing in context.
 *   - the loop is bounded by a state: after `MAX_TURNS` replies the machine
 *     idles in `budgetSpent`, which declares only END, so the host's
 *     `getInteraction` call sees the bound instead of guessing at a guard.
 *   - the idle snapshot is JSON round-tripped between turns, proving the
 *     active agent and the conversation survive a real persistence layer.
 *
 * Dual-mode: `runSwarmHandoffExample(options?)` takes injectable executors
 * (the test passes mocks — CI with no API key); the direct run below uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/swarm-handoff/index.ts
 */
import { z } from "zod";
import type { Snapshot as PersistedSnapshot } from "xstate";
import { openai } from "@ai-sdk/openai";
import {
  getInteraction,
  interactionMetaSchema,
  setupAgent,
  type AgentRuntimeOptions,
  type AgentRunInit,
  type AgentRunResult,
  runAgent,
} from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const agentName = z.enum(["travel", "food"]);
/**
 * One conversation turn, in chat-message shape (`role` + `content`) so a host
 * reads `history` as a transcript; `agent` says which concierge spoke.
 */
const turnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  agent: agentName.optional(),
});
type Turn = z.infer<typeof turnSchema>;

const replyInput = z.object({ message: z.string(), history: z.array(turnSchema) });

/**
 * One concierge turn's prompt: the conversation so far, then the new message.
 * Without it a handed-off concierge would get "What are the must-try dishes
 * there?" with no idea where "there" is.
 */
function replyPrompt({ input }: { input: z.infer<typeof replyInput> }): string {
  if (input.history.length === 0) return input.message;
  return [
    "Conversation so far:",
    ...input.history.map((turn) => `[${turn.agent ?? "user"}] ${turn.content}`),
    "",
    `New message from the user: ${input.message}`,
  ].join("\n");
}

/** The history after a reply: the user's message, then the agent who answered it. */
function withReply(
  context: { message: string; history: Turn[] },
  agent: z.infer<typeof agentName>,
  reply: string,
): Turn[] {
  return [
    ...context.history,
    { role: "user", content: context.message },
    { role: "assistant", content: reply, agent },
  ];
}

/** Replies the conversation may run before only END is legal. */
export const MAX_TURNS = 4;

const models = {
  travel: openai("gpt-6-luna"),
  food: openai("gpt-6-luna"),
  router: openai("gpt-6-luna"),
};

const agentSetup = setupAgent({
  models,
  meta: interactionMetaSchema,
  context: z.object({
    message: z.string(),
    activeAgent: agentName,
    reply: z.string().nullable(),
    turns: z.number().int(),
    /** The shared conversation: whoever takes the mic reads what came before. */
    history: z.array(turnSchema),
  }),
  input: z.object({
    message: z.string(),
    activeAgent: agentName.optional(),
  }),
  // No `reply`: every reply was already delivered at an idle turn, so
  // repeating the last one here would show it twice. The output is the
  // conversation's final state: who held the mic, and for how many turns.
  output: z.object({
    activeAgent: agentName,
    turns: z.number().int(),
  }),
  events: {
    /** Human: the next message for whoever ends up holding the mic. */
    SAY: z.object({ message: z.string() }),
    /** Human: stop here. */
    END: z.object({}),
    /** Model: hand the mic to the other specialist. */
    HANDOFF: z.object({ to: agentName }),
    /** Model: the current specialist keeps the mic. */
    KEEP: z.object({}),
  },
  requests: {
    travelReply: {
      schemas: { input: replyInput, output: z.string() },
      model: "travel",
      system: "You are a travel concierge. Help with destinations, flights, and itineraries.",
      prompt: replyPrompt,
    },
    foodReply: {
      schemas: { input: replyInput, output: z.string() },
      model: "food",
      system: "You are a food concierge. Help with restaurants, dishes, and dietary needs.",
      prompt: replyPrompt,
    },
  },
});

export const swarmHandoffSchemas = agentSetup.schemas;

export const swarmHandoffMachine = agentSetup.createMachine({
  id: "swarm-handoff",
  context: ({ input }) => ({
    message: input.message,
    activeAgent: input.activeAgent ?? "travel",
    reply: null,
    turns: 0,
    history: [],
  }),
  initial: "dispatching",
  states: {
    // Dispatch to whichever agent currently holds the mic.
    dispatching: {
      type: "choice",
      choice: ({ context }) =>
        context.activeAgent === "food" ? { target: "foodTurn" } : { target: "travelTurn" },
    },
    travelTurn: {
      invoke: {
        src: "travelReply",
        input: ({ context }) => ({ message: context.message, history: context.history }),
        onDone: ({ context, output }) => ({
          target: "checkingBudget",
          context: {
            reply: output.result,
            turns: context.turns + 1,
            history: withReply(context, "travel", output.result),
          },
        }),
        onError: { target: "failed" },
      },
    },
    foodTurn: {
      invoke: {
        src: "foodReply",
        input: ({ context }) => ({ message: context.message, history: context.history }),
        onDone: ({ context, output }) => ({
          target: "checkingBudget",
          context: {
            reply: output.result,
            turns: context.turns + 1,
            history: withReply(context, "food", output.result),
          },
        }),
        onError: { target: "failed" },
      },
    },
    // The turn budget is a state, not a guard the host has to guess at:
    // once it is spent the machine idles in `budgetSpent`, where SAY is not
    // declared at all, so `getInteraction` shows END as the only way on.
    checkingBudget: {
      type: "choice",
      choice: ({ context }) =>
        context.turns >= MAX_TURNS ? { target: "budgetSpent" } : { target: "waiting" },
    },
    budgetSpent: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "The {activeAgent} concierge answered. That was the last turn; end here.",
          events: { END: { label: "End the conversation", style: "default" } },
        },
      },
      on: { END: { target: "finished" } },
    },
    // No invoke: runAgent settles idle here. The host persists the snapshot,
    // then resumes with the human's next message (or END).
    waiting: {
      tags: ["waiting"],
      meta: {
        interaction: {
          // `{activeAgent}` resolves against context when the label is shown.
          label: "The {activeAgent} concierge answered. Ask a follow-up, or end here.",
          events: { END: { label: "End the conversation", style: "default" } },
          textEvent: "SAY",
        },
      },
      on: {
        SAY: ({ event }) => ({ target: "routing", context: { message: event.message } }),
        END: { target: "finished" },
      },
    },
    // The handoff decision belongs to the model, not to the host.
    routing: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          name: "route",
          model: "router",
          system:
            "Two concierges share one conversation: 'travel' (destinations, flights, " +
            "itineraries) and 'food' (restaurants, dishes, dietary needs). Choose " +
            "HANDOFF to move the message to the other concierge, or KEEP when the " +
            "current one should answer it.",
          prompt:
            `Current concierge: ${context.activeAgent}\n` + `Next message: ${context.message}`,
          allowedEvents: ["HANDOFF", "KEEP"],
          maxRetries: 2,
        }),
        // A router outage is not a reason to drop the message: the current
        // concierge answers it.
        onError: { target: "dispatching" },
      },
      on: {
        // Handing off to yourself is not a handoff: reject it so `agent.decide`
        // retries with the rejection in its attempts.
        HANDOFF: ({ context, event }) =>
          event.to === context.activeAgent
            ? undefined
            : { target: "dispatching", context: { activeAgent: event.to } },
        KEEP: { target: "dispatching" },
      },
    },
    finished: {
      type: "final",
      output: ({ context }) => ({ activeAgent: context.activeAgent, turns: context.turns }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({ activeAgent: context.activeAgent, turns: context.turns }),
    },
  },
});

/** A real persistence layer: the snapshot goes out as JSON and comes back. */
export function roundTrip<T>(snapshot: T): T {
  return JSON.parse(JSON.stringify(snapshot)) as T;
}

export async function runSwarmHandoffExample(
  options: AgentRuntimeOptions<typeof swarmHandoffMachine> &
    AgentRunInit<typeof swarmHandoffMachine> = {},
) {
  // Spread-merge, so a caller passing only `onTransition` keeps the live executors.
  const resolved: AgentRuntimeOptions<typeof swarmHandoffMachine> &
    AgentRunInit<typeof swarmHandoffMachine> = {
    executors: createAiSdkExecutors(swarmHandoffMachine),
    ...options,
  };

  // Turn 1: the travel agent holds the mic and answers.
  const first = await runAgent(swarmHandoffMachine, {
    ...resolved,
    input: { message: "I want a 3-day trip to Lisbon.", activeAgent: "travel" },
    ...resolved,
  });
  if (first.status !== "idle") {
    throw new Error(`Swarm handoff did not settle idle after turn 1: ${first.status}`);
  }
  const firstReply = first.snapshot.context.reply ?? "";

  // Persist the snapshot the way a host would, through JSON.
  const persisted = roundTrip(first.persist());

  // ...later, new process: the human asks a food question. The MODEL decides
  // the travel concierge should hand it to the food concierge.
  const second = await runAgent(swarmHandoffMachine, {
    ...resolved,
    snapshot: persisted,
    event: { type: "SAY", message: "What are the must-try dishes there?" },
    ...resolved,
  });
  if (second.status !== "idle") {
    throw new Error(`Swarm handoff did not settle idle after turn 2: ${second.status}`);
  }

  return {
    travel: { activeAgent: "travel" as const, reply: firstReply },
    food: {
      activeAgent: second.snapshot.context.activeAgent,
      reply: second.snapshot.context.reply ?? "",
    },
  };
}

/**
 * Interactive REPL: the user talks to the conversation, and the model decides
 * which concierge answers each message. Every turn resumes the persisted idle
 * snapshot with a SAY event; an empty line sends END.
 */
async function runInteractive() {
  const executors = createAiSdkExecutors(swarmHandoffMachine);

  let active: "travel" | "food" = "travel";
  console.log("Swarm handoff — two concierges share one conversation.");
  console.log(
    "Type a message; the router decides which concierge answers. " +
      "Empty line ends the conversation.\n",
  );

  // Turn 1 seeds the conversation from a fresh run; later turns resume the
  // persisted snapshot with a SAY event.
  type LiveSnapshot = ReturnType<typeof swarmHandoffMachine.resolveState>;
  let snapshot: PersistedSnapshot<unknown> | null = null;

  const onTransition = (snap: LiveSnapshot) => {
    // Surface the turn's routing (which agent's turn state runs).
    if (snap.value === "travelTurn" || snap.value === "foodTurn") {
      console.log(`  [state] ${snap.value}`);
    }
  };

  async function runTurn(message: string): Promise<AgentRunResult<typeof swarmHandoffMachine>> {
    if (snapshot) {
      return runAgent(swarmHandoffMachine, {
        executors,
        onTransition,
        snapshot,
        event: { type: "SAY" as const, message },
      });
    }
    return runAgent(swarmHandoffMachine, {
      executors,
      onTransition,
      input: { message, activeAgent: active },
    });
  }

  await withReadline(async (rl) => {
    while (true) {
      const line: string = (await rl.question(`[${active}] you> `)).trim();
      if (!line) break;

      const result = await runTurn(line);
      if (result.status !== "idle") {
        console.error(`Conversation ended unexpectedly: ${result.status}`);
        break;
      }
      const handedTo = result.snapshot.context.activeAgent;
      if (handedTo !== active) {
        console.log(`--- handoff: ${active} → ${handedTo} ---`);
      }
      active = handedTo;
      snapshot = roundTrip(result.persist());
      console.log(`[${active}] ${result.snapshot.context.reply ?? ""}\n`);
      if (!getInteraction(result.snapshot)?.textEvent) {
        console.log("Turn budget reached.");
        break;
      }
    }
  });
}

// Non-interactive fallback: the scripted two-turn demo (CI / non-TTY).
async function runDemo() {
  const { travel, food } = await runSwarmHandoffExample();
  console.log(`[${travel.activeAgent}] ${travel.reply}`);
  console.log(`\n--- handoff ---\n`);
  console.log(`[${food.activeAgent}] ${food.reply}`);
}

/** Open a readline interface, run `fn` with it, and always close it. */
async function withReadline<T>(
  fn: (rl: { question: (query: string) => Promise<string> }) => Promise<T>,
): Promise<T> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn(rl);
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
  void (async () => {
    const forceDemo = process.argv.includes("--demo");
    if (forceDemo || !process.stdout.isTTY) {
      await runDemo();
    } else {
      await runInteractive();
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
