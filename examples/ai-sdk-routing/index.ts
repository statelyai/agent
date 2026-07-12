/**
 * Vercel AI SDK routing — ported to `setupAgent` with co-located
 * `requests:`. `answerCustomerQuery` picks its model/system per
 * classification, showcasing per-call model/system as functions of input.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#routing
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-routing/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { setupAgent, runAgent } from "../../src/index.js";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { runExampleMain } from "../helpers/main.js";

const classificationSchema = z.object({
  reasoning: z.string(),
  type: z.enum(["general", "refund", "technical"]),
  complexity: z.enum(["simple", "complex"]),
});

export const models = defineModels({
  classifier: openai("gpt-5.4-mini"),
  simpleAnswerer: openai("gpt-4o-mini"),
  complexAnswerer: openai("o4-mini"),
});

const contextSchema = z.object({
  query: z.string(),
  classification: classificationSchema.nullable(),
  response: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ query: z.string() }),
  output: z.object({
    classification: classificationSchema,
    response: z.string(),
  }),
  // After classifying, `classification` is always set — narrow it non-null.
  // responding sets response before done reads it — narrow that too.
  states: {
    classifying: {},
    responding: {
      schemas: { context: contextSchema.extend({ classification: classificationSchema }) },
    },
    done: {
      schemas: {
        context: contextSchema.extend({
          classification: classificationSchema,
          response: z.string(),
        }),
      },
    },
  },
  requests: {
    classifyCustomerQuery: {
      schemas: {
        input: z.object({ query: z.string() }),
        output: classificationSchema,
      },
      model: "classifier",
      system:
        "You route customer support queries. Classify each into a type — general, refund, or technical — and a complexity — simple (answerable directly) or complex (needs deeper reasoning). Explain your reasoning briefly.",
      prompt: ({ input }) => `Classify this customer query:\n${input.query}`,
    },
    answerCustomerQuery: {
      schemas: {
        input: z.object({
          query: z.string(),
          classification: classificationSchema,
        }),
        output: z.string(),
      },
      model: ({ input }) =>
        input.classification.complexity === "simple" ? "simpleAnswerer" : "complexAnswerer",
      system: ({ input }) =>
        ({
          general:
            "You are a friendly support generalist. Answer the customer directly and concisely, and point them to the right next step.",
          refund:
            "You are a refunds specialist. State whether the request qualifies, explain the policy plainly, and give the exact steps to get the refund.",
          technical:
            "You are a technical support engineer. Diagnose the likely cause and give numbered troubleshooting steps the customer can follow.",
        })[input.classification.type],
      prompt: ({ input }) => input.query,
    },
  },
});

export const aiSdkRoutingMachine = agentSetup.createMachine({
  id: "ai-sdk-routing",
  context: ({ input }) => ({
    query: input.query,
    classification: null,
    response: null,
  }),
  initial: "classifying",
  states: {
    classifying: {
      invoke: {
        id: "classifyCustomerQuery",
        src: "classifyCustomerQuery",
        input: ({ context }) => ({ query: context.query }),
        onDone: ({ output }) => ({
          target: "responding",
          context: { classification: output },
        }),
      },
    },
    responding: {
      invoke: {
        id: "answerCustomerQuery",
        src: "answerCustomerQuery",
        input: ({ context }) => ({
          query: context.query,
          classification: context.classification,
        }),
        onDone: ({ output }) => ({
          target: "done",
          context: { response: output },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        classification: context.classification,
        response: context.response,
      }),
    },
  },
});

export async function runAiSdkRoutingExample(
  observe?: Parameters<typeof runAgent>[1]["onTransition"],
) {
  const result = await runAgent(aiSdkRoutingMachine, {
    input: { query: "The app crashes on launch." },
    ...createAiSdkExecutors({ models }),
    onTransition: observe,
  });
  if (result.status !== "done") {
    throw new Error(`Routing example did not complete: ${result.status}`);
  }
  return result.output;
}

runExampleMain(import.meta.url, async () => {
  console.log(
    await runAiSdkRoutingExample((snapshot) =>
      console.log("[state]", JSON.stringify(snapshot.value)),
    ),
  );
});
