/**
 * Swarm handoff — an active-agent conversation that hands off between two
 * specialists, with the active agent persisted across a snapshot round-trip.
 *
 * Shows:
 *   - `context.activeAgent` tracks who is "holding the mic" ('travel' | 'food').
 *   - each agent has its own reply request (distinct model ref + system) that
 *     runs one conversation turn, then the machine settles idle in `waiting`.
 *   - a `HANDOFF` event switches `activeAgent` and re-enters `routing`; the
 *     idle snapshot is JSON round-tripped, proving the active agent survives a
 *     real persistence layer (two `runAgent` invocations).
 *
 * Dual-mode: `runSwarmHandoffExample(options?)` takes injectable executors
 * (the test passes mocks — keyless CI); the direct run below uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/swarm-handoff/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { type LanguageModel } from "ai";
import { runAgent, setupAgent, type RunAgentOptions } from "../../src/index.js";
import { createAiSdkExecutors } from "../../src/ai-sdk/index.js";

const agentName = z.enum(["travel", "food"]);

export const models: Record<"travel" | "food", LanguageModel> = {
  travel: openai("gpt-5.4-mini"),
  food: openai("gpt-5.4-mini"),
} as const;

const agent = setupAgent({
  models,
  context: z.object({
    message: z.string(),
    activeAgent: agentName,
    reply: z.string().nullable(),
  }),
  input: z.object({
    message: z.string(),
    activeAgent: agentName.optional(),
  }),
  output: z.object({ activeAgent: agentName, reply: z.string() }),
  events: {
    // Hand the mic to the other specialist and give them the next message.
    HANDOFF: z.object({ to: agentName, message: z.string() }),
  },
  requests: {
    travelReply: {
      schemas: {
        input: z.object({ message: z.string() }),
        output: z.string(),
      },
      model: "travel",
      system: "You are a travel concierge. Help with destinations, flights, and itineraries.",
      prompt: ({ input }) => input.message,
    },
    foodReply: {
      schemas: {
        input: z.object({ message: z.string() }),
        output: z.string(),
      },
      model: "food",
      system: "You are a food concierge. Help with restaurants, dishes, and dietary needs.",
      prompt: ({ input }) => input.message,
    },
  },
});

export const swarmHandoffSchemas = agent.schemas;

export const swarmHandoffMachine = agent.createMachine({
  id: "swarm-handoff",
  context: ({ input }) => ({
    message: input.message,
    activeAgent: input.activeAgent ?? "travel",
    reply: null,
  }),
  output: ({ context }) => ({
    activeAgent: context.activeAgent,
    reply: context.reply ?? "",
  }),
  initial: "routing",
  states: {
    // Dispatch to whichever agent currently holds the mic.
    routing: {
      type: "choice",
      choice: ({ context }) =>
        context.activeAgent === "food" ? { target: "foodTurn" } : { target: "travelTurn" },
    },
    travelTurn: {
      invoke: {
        id: "travelReply",
        src: "travelReply",
        input: ({ context }) => ({ message: context.message }),
        onDone: ({ output }) => ({ target: "waiting", context: { reply: output } }),
      },
    },
    foodTurn: {
      invoke: {
        id: "foodReply",
        src: "foodReply",
        input: ({ context }) => ({ message: context.message }),
        onDone: ({ output }) => ({ target: "waiting", context: { reply: output } }),
      },
    },
    // No invoke: runAgent settles idle here. A HANDOFF switches the active
    // agent and re-routes; the host persists the snapshot in between.
    waiting: {
      on: {
        HANDOFF: ({ event }) => ({
          target: "routing",
          context: { activeAgent: event.to, message: event.message },
        }),
      },
    },
  },
});

export async function runSwarmHandoffExample(
  options?: RunAgentOptions<typeof swarmHandoffMachine>,
) {
  const executors = options ?? { ...createAiSdkExecutors({ models }) };

  // Turn 1: the travel agent holds the mic and answers.
  const first = await runAgent(swarmHandoffMachine, {
    input: { message: "I want a 3-day trip to Lisbon.", activeAgent: "travel" },
    ...executors,
  });
  if (first.status !== "idle") {
    throw new Error(`Swarm handoff did not settle idle after turn 1: ${first.status}`);
  }
  const firstReply = first.snapshot.context.reply ?? "";

  // Persist the snapshot (host's choice of store) — JSON round-trip it to
  // prove `activeAgent` survives a real persistence layer.
  const persisted = JSON.parse(JSON.stringify(first.snapshot));

  // ...later, new process: hand off to the food agent for the next turn.
  const second = await runAgent(swarmHandoffMachine, {
    snapshot: persisted,
    event: {
      type: "HANDOFF",
      to: "food",
      message: "What are the must-try dishes there?",
    },
    ...executors,
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

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  const { travel, food } = await runSwarmHandoffExample();
  console.log(`[${travel.activeAgent}] ${travel.reply}`);
  console.log(`\n--- handoff ---\n`);
  console.log(`[${food.activeAgent}] ${food.reply}`);
}
