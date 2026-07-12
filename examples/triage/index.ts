/**
 * Support-ticket triage: one text request classifies a ticket into
 * sentiment + category and drafts a short reply, then the machine finishes.
 * The simplest, cheapest end-to-end agent in this set.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/triage/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { createAgentSchemas, createTextLogic, runAgent, setupAgent } from "../../src/index.js";
import { runExampleMain } from "../helpers/main.js";

export const triageSchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  category: z.enum(["billing", "technical", "other"]),
  reply: z.string(),
});

const contextSchema = z.object({
  ticket: z.string(),
  triage: triageSchema.nullable(),
});

const schemas = createAgentSchemas({
  context: contextSchema,
  input: z.object({ ticket: z.string() }),
  output: triageSchema,
});

export const models = defineModels({
  ticketTriage: openai("gpt-5.4-mini"),
});

export const triageTicket = createTextLogic({
  schemas: {
    input: z.object({ ticket: z.string() }),
    output: triageSchema,
  },
  model: "ticketTriage",
  system: [
    "You triage inbound support tickets. For each ticket, return:",
    "- sentiment: the customer's tone (positive, neutral, or negative).",
    "- category: billing, technical, or other.",
    "- reply: two or three sentences, addressed to the customer, that",
    "  acknowledge the issue and state the next step. No greeting boilerplate.",
  ].join("\n"),
  prompt: ({ input }) => input.ticket,
});

export const triageActors = {
  triageTicket,
};

const triageAgentSetup = setupAgent({
  schemas,
  models,
  actorSources: triageActors,
  // `triaging` assigns `triage` before `done` is entered — narrow it non-null there.
  states: {
    triaging: {},
    done: {
      schemas: { context: contextSchema.extend({ triage: triageSchema }) },
    },
  },
});

export const triageSchemas = schemas;

export const triageMachine = triageAgentSetup.createMachine({
  id: "ticket-triage",
  context: ({ input }) => ({ ticket: input.ticket, triage: null }),
  initial: "triaging",
  states: {
    triaging: {
      invoke: {
        src: "triageTicket",
        input: ({ context }) => ({ ticket: context.ticket }),
        onDone: ({ output }) => ({
          target: "done",
          context: { triage: output },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => context.triage,
    },
  },
});

// Sample data — a stand-in for a ticket pulled from your support inbox.
const SAMPLE_TICKET =
  "I was charged twice for my March subscription and the second charge never " +
  "showed up as a plan on my account. Can you refund the duplicate? This is " +
  "the third time billing has gone wrong this year.";

export async function main() {
  const executors = createAiSdkExecutors({ models });

  const result = await runAgent(triageMachine, {
    input: { ticket: SAMPLE_TICKET },
    ...executors,
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });

  if (result.status !== "done") {
    throw new Error(`Triage did not complete: ${result.status}`);
  }
  console.log(JSON.stringify(result.output, null, 2));
}

runExampleMain(import.meta.url, main);
