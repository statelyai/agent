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
import { withReadline } from "../helpers/cli.js";
import {
  persistSnapshot,
  runAgent,
  setupAgent,
  type RunAgentOptions,
  type RunAgentResult,
} from "../../src/index.js";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { resolveExecutors, runExampleMain } from "../helpers/main.js";

const agentName = z.enum(["travel", "food"]);

export const models = defineModels({
  travel: openai("gpt-5.4-mini"),
  food: openai("gpt-5.4-mini"),
});

const agentSetup = setupAgent({
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

export const swarmHandoffSchemas = agentSetup.schemas;

export const swarmHandoffMachine = agentSetup.createMachine({
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
        onDone: ({ output }) => ({
          target: "waiting",
          context: { reply: output },
        }),
      },
    },
    foodTurn: {
      invoke: {
        id: "foodReply",
        src: "foodReply",
        input: ({ context }) => ({ message: context.message }),
        onDone: ({ output }) => ({
          target: "waiting",
          context: { reply: output },
        }),
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
  const executors = resolveExecutors(models, options);

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
  const persisted = persistSnapshot(first.snapshot);

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

/**
 * Interactive REPL: the user talks to whichever agent holds the mic, and can
 * hand off with `/travel <message>` or `/food <message>`. Each turn runs the
 * machine from the persisted idle snapshot; a handoff is a real HANDOFF event
 * that switches `activeAgent` and re-routes.
 */
async function runInteractive() {
  const executors = createAiSdkExecutors({ models });

  let active: "travel" | "food" = "travel";
  console.log("Swarm handoff — two concierges share one conversation.");
  console.log(
    "Type a message for the current agent, or hand off with " +
      "`/travel <msg>` or `/food <msg>`. Ctrl-D or empty line to quit.\n",
  );

  // Turn 1 seeds the conversation from a fresh run; later turns resume the
  // persisted snapshot with a HANDOFF event.
  type Snapshot = ReturnType<typeof swarmHandoffMachine.resolveState>;
  let snapshot: Snapshot | null = null;

  const onTransition = (snap: Snapshot) => {
    // Surface the turn's routing (which agent's turn state runs).
    if (snap.value === "travelTurn" || snap.value === "foodTurn") {
      console.log(`  [state] ${snap.value}`);
    }
  };

  // One turn: resume from the persisted snapshot with a HANDOFF, or seed a
  // fresh run on the very first turn.
  async function runTurn(
    to: "travel" | "food",
    message: string,
  ): Promise<RunAgentResult<typeof swarmHandoffMachine>> {
    if (snapshot) {
      return runAgent(swarmHandoffMachine, {
        snapshot,
        event: { type: "HANDOFF" as const, to, message },
        ...executors,
        onTransition,
      });
    }
    return runAgent(swarmHandoffMachine, {
      input: { message, activeAgent: to },
      ...executors,
      onTransition,
    });
  }

  await withReadline(async (rl) => {
    while (true) {
      const line: string = (await rl.question(`[${active}] you> `)).trim();
      if (!line) break;

      let to: "travel" | "food" = active;
      let message = line;
      const match = /^\/(travel|food)\s+(.*)$/s.exec(line);
      if (match) {
        to = match[1] as "travel" | "food";
        message = match[2] ?? "";
      }
      if (to !== active) {
        console.log(`--- handoff: ${active} → ${to} ---`);
      }

      const result = await runTurn(to, message);
      if (result.status !== "idle") {
        console.error(`Conversation ended unexpectedly: ${result.status}`);
        break;
      }
      active = result.snapshot.context.activeAgent;
      snapshot = persistSnapshot(result.snapshot);
      console.log(`[${active}] ${result.snapshot.context.reply ?? ""}\n`);
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

runExampleMain(import.meta.url, async () => {
  const forceDemo = process.argv.includes("--demo");
  if (forceDemo || !process.stdout.isTTY) {
    await runDemo();
  } else {
    await runInteractive();
  }
});
