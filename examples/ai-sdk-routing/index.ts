/**
 * Vercel AI SDK routing — ported to `setupAgent` with co-located
 * `requests:`. `answerCustomerQuery` picks its model/system per
 * classification, showcasing per-call model/system as functions of input.
 *
 * The responder is grounded: each reply carries the matching `SAMPLE_POLICIES`
 * excerpt and is told it is the only source of policy facts, so the demo does
 * not invent refund windows or fees.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#routing
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-routing/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { setupAgent, runAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

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

/**
 * Sample policy excerpts (stand-in for a real policy store). The responder is
 * told these are the ONLY source of policy facts, so it can't invent refund
 * windows or fees that don't exist.
 */
export const SAMPLE_POLICIES: Record<z.infer<typeof classificationSchema>["type"], string> = {
  general:
    "Support hours are 09:00–18:00 UTC, Monday to Friday. Account and billing changes are self-serve under Settings → Account.",
  refund:
    "Damaged-on-arrival items qualify for a full refund when reported within 30 days of delivery. Refunds are issued to the original payment method and settle in 5–7 business days. Return shipping is prepaid by us for damaged items; there is no restocking fee.",
  technical:
    "Crash reports are collected automatically. Supported versions are 4.2 and later; older builds must update before we can investigate. Known issue: sync can crash on launch when the local cache is corrupt — clearing the cache under Settings → Storage resolves it.",
};

/** Appended to every responder system prompt: answer only from the excerpt. */
const GROUNDING_RULE =
  " Use ONLY the policy excerpt provided in the message as a source of policy facts — do not invent windows, fees, or timelines. If the excerpt does not cover the question, say so and offer to escalate.";

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
    responding: { context: { classification: classificationSchema } },
    done: { context: { classification: classificationSchema, response: z.string() } },
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
        })[input.classification.type] + GROUNDING_RULE,
      // Ship the matching policy excerpt with the query so the answer is grounded
      // in sample data rather than invented policy details.
      prompt: ({ input }) =>
        [
          "Policy excerpt (the only source of policy facts):",
          SAMPLE_POLICIES[input.classification.type],
          "",
          `Customer: ${input.query}`,
        ].join("\n"),
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
        onError: { target: "failed" },
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
        onError: { target: "failed" },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        classification: context.classification,
        response: context.response,
      }),
    },
    // Best-effort output when a model call fails.
    failed: {
      type: "final",
      output: () => ({
        classification: { reasoning: "", type: "general" as const, complexity: "simple" as const },
        response: "",
      }),
    },
  },
});

export async function runAiSdkRoutingExample(
  observe?: Parameters<typeof runAgent>[1]["onTransition"],
) {
  const result = await runAgent(aiSdkRoutingMachine, {
    input: { query: "The app crashes on launch." },
    executors: createAiSdkExecutors({ models }),
    onTransition: observe,
  });
  if (result.status !== "done") {
    throw new Error(`Routing example did not complete: ${result.status}`);
  }
  return result.output;
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    console.log(
      await runAiSdkRoutingExample((snapshot) =>
        console.log("[state]", JSON.stringify(snapshot.value)),
      ),
    );
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
