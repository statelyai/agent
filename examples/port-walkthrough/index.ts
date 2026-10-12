/**
 * AFTER: the `before.ts` loop as an agent machine, run with `runAgent`.
 *
 * Same call shape and same result type as `before.ts`:
 *   - `if (steps++ >= 8)` → the `checkingSteps` choice state, against MAX_STEPS
 *   - `generateText` with `search` → the `assist` request, same tool
 *   - "did the model call a tool?" → the `chooseAction` decision
 *   - `await approve(...)` → the idle `awaitingApproval` state, answered by
 *     `onIdle` here or by a second `runAgent` call with `{ snapshot, event }`
 *   - `sendEmail` → an actor that only `sending` invokes, entered from APPROVE
 *
 * The invokes have no `onError`, on purpose: the loop let an SDK error reject
 * its promise, and `runSupportAgent` rethrows a run that settles `error`.
 *
 * Tests pass mock executors (no API key); a direct run uses a real model.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/port-walkthrough/index.ts
 */
import { createAsyncLogic } from "xstate";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import {
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { emailSchema, search } from "./before.js";

/** The loop's step cap. */
export const MAX_STEPS = 8;

// Model IDs here are illustrative; substitute your provider's current models.
const models = { quick: openai("gpt-5.4-mini") };

// The loop's sendEmail implementation, unchanged, wrapped as an actor.
const sendEmailActor = createAsyncLogic({
  schemas: { input: emailSchema, output: z.object({ id: z.string() }) },
  run: async ({ input }): Promise<{ id: string }> => ({ id: `msg_${input.to}` }),
});

const agentSetup = setupAgent({
  models,
  actors: { sendEmail: sendEmailActor },
  context: z.object({
    request: z.string(),
    reply: z.string(),
    draft: emailSchema.nullable(),
    sent: z.boolean(),
    // Set only by APPROVE, cleared once the email is sent.
    approved: z.boolean(),
    steps: z.number(),
  }),
  input: z.object({ request: z.string() }),
  // The loop's three returns, one per final state.
  output: z.union([
    z.object({ sent: z.boolean(), stopped: z.literal("step-limit") }),
    z.object({ sent: z.boolean(), reply: z.string() }),
    z.object({ sent: z.boolean(), pending: z.literal(true) }),
  ]),
  events: {
    REPLY: {},
    CONTINUE: {},
    SEND_EMAIL: emailSchema,
    APPROVE: {},
    REJECT: {},
  },
  meta: interactionMetaSchema,
  requests: {
    assist: {
      model: "quick",
      schemas: {
        input: z.object({ request: z.string(), reply: z.string(), sent: z.boolean() }),
        output: z.string(),
      },
      system: "You are a support agent. Search the docs before you answer.",
      prompt: ({ input }) =>
        [
          input.request,
          input.reply && `Your draft so far: ${input.reply}`,
          input.sent && "The email to the customer was sent.",
        ]
          .filter(Boolean)
          .join("\n"),
      tools: { search }, // the loop's tool, unchanged
    },
  },
});

export const supportLoopMachine = agentSetup.createMachine({
  id: "support-loop",
  context: ({ input }) => ({
    request: input.request,
    reply: "",
    draft: null,
    sent: false,
    approved: false,
    steps: 0,
  }),
  initial: "checkingSteps",
  states: {
    // The loop's first line: `if (steps++ >= 8) return { sent, stopped: "step-limit" }`.
    checkingSteps: {
      type: "choice",
      choice: ({ context }) =>
        context.steps >= MAX_STEPS ? { target: "failed" } : { target: "assisting" },
    },
    assisting: {
      invoke: {
        src: "assist",
        input: ({ context }) => ({
          request: context.request,
          reply: context.reply,
          sent: context.sent,
        }),
        onDone: ({ context, output }) => ({
          target: "deciding",
          context: { reply: output.result, steps: context.steps + 1 },
        }),
      },
    },
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "quick",
          name: "chooseAction",
          system:
            "Reply to the customer with your draft, look further, or propose an email to send.",
          prompt: `Request: ${context.request}\nDraft so far: ${context.reply}`,
          allowedEvents: ["REPLY", "CONTINUE", "SEND_EMAIL"],
        }),
      },
      on: {
        REPLY: { target: "replied" },
        CONTINUE: { target: "checkingSteps" },
        SEND_EMAIL: ({ event }) => ({
          target: "awaitingApproval",
          context: { draft: { to: event.to, subject: event.subject, body: event.body } },
        }),
      },
    },
    // No invoke: the run settles { status: "idle" } here.
    awaitingApproval: {
      meta: {
        interaction: {
          label: "Send this email to {draft.to}?",
          events: {
            APPROVE: { label: "Send", style: "primary" },
            REJECT: { label: "Discard", style: "danger" },
          },
        },
      },
      on: {
        APPROVE: () => ({ target: "sending", context: { approved: true } }),
        REJECT: { target: "declined" },
      },
    },
    sending: {
      invoke: {
        src: "sendEmail",
        input: ({ context }) => context.draft!,
        onDone: () => ({
          target: "checkingSteps",
          context: { sent: true, approved: false, draft: null },
        }),
      },
    },
    replied: {
      type: "final",
      output: ({ context }) => ({ sent: context.sent, reply: context.reply }),
    },
    // The loop's `{ pending: true }` for a declined send, kept so callers do not change.
    declined: {
      type: "final",
      output: ({ context }) => ({ sent: context.sent, pending: true as const }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({ sent: context.sent, stopped: "step-limit" as const }),
    },
  },
});

/** `before.ts`'s `runSupportAgent`, with the `while` loop replaced by `runAgent`. */
export async function runSupportAgent(
  request: string,
  approve: (draft: unknown) => Promise<boolean>,
  executors: Partial<AgentRequestExecutors> = createAiSdkExecutors({ models }),
) {
  const result = await runAgent(supportLoopMachine, {
    input: { request },
    executors,
    onIdle: async (snapshot) =>
      (await approve(snapshot.context.draft))
        ? { type: "APPROVE" as const }
        : { type: "REJECT" as const },
  });
  if (result.status === "done") return result.output;
  throw result.status === "error" ? result.error : new Error(`Run settled ${result.status}`);
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const approve = async (draft: unknown) => {
      console.log("Draft:", draft);
      return (await rl.question("Send it? (y/n) > ")).trim().toLowerCase() === "y";
    };
    try {
      console.log(await runSupportAgent("Refund my duplicate charge", approve));
    } finally {
      rl.close();
    }
  })();
}
