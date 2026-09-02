/**
 * Support-ticket triage with a bounded lifecycle. Classification is one text
 * request; everything the machine adds after it is lifecycle control you can
 * point at:
 *
 *   classifying → checkingConfidence ─┬─ replying → done
 *                                     └─ escalating (a human decides) → replying
 *
 *   replying ──(draft failed)──> replyFailed ─┬─ replying   (one retry)
 *                                             └─ failed     (reply degraded)
 *
 * The pieces:
 *   - A confidence guard. The classifier reports how sure it is; below the
 *     threshold the run does NOT reply on its own — it settles idle in
 *     `escalating` and waits for a person to confirm the category or type the
 *     right one. `meta.interaction` tells a host how to render that, and the
 *     `waiting` tag plus `isIdle` make the idle settle deterministic.
 *   - One retry on reply generation. A failed draft is not an exception: it
 *     routes through `replyFailed`, retries once, then degrades to a `failed`
 *     outcome carrying a fallback reply rather than throwing.
 *   - A simulated SLA note, computed host-side from category and sentiment. No
 *     wall-clock timers: a demo should not make you wait four hours.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/triage/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import type { SnapshotFrom } from "xstate";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { createAgentSchemas, getStateMeta, runAgent, setupAgent } from "@statelyai/agent";

export const categorySchema = z.enum(["billing", "technical", "other"]);
export const sentimentSchema = z.enum(["positive", "neutral", "negative"]);

/** What the classifier returns, including how sure it is. */
export const classificationSchema = z.object({
  sentiment: sentimentSchema,
  category: categorySchema,
  // A classifier that does not hedge is taken at its word; anything it flags
  // below the threshold goes to a person.
  confidence: z.number().min(0).max(1).default(1),
});

/** The classic triage shape, kept stable for hosts that read it. */
export const triageSchema = z.object({
  sentiment: sentimentSchema,
  category: categorySchema,
  reply: z.string(),
});

/** Machine output: a readable summary first, then the structured fields. */
export const triageOutputSchema = z.object({
  summary: z.string(),
  ...triageSchema.shape,
  escalated: z.boolean(),
});

/** Below this, a person decides the category before any reply is drafted. */
export const CONFIDENCE_THRESHOLD = 0.6;

/** Simulated SLA: derived from the classification, no timers involved. */
export function slaNoteFor(classification: z.infer<typeof classificationSchema>): string {
  const base =
    classification.category === "billing" ? 4 : classification.category === "technical" ? 8 : 24;
  const hours = classification.sentiment === "negative" ? Math.max(1, base / 2) : base;
  return `SLA: first response due in ${hours}h (${classification.category}, ${classification.sentiment}).`;
}

const contextSchema = z.object({
  ticket: z.string(),
  classification: classificationSchema.nullable(),
  reply: z.string(),
  /** The simulated clock, as prose. */
  slaNote: z.string(),
  /** The last thing that happened — what an idle host shows the human. */
  notice: z.string(),
  escalated: z.boolean(),
  replyAttempts: z.number(),
});

/** Typed `meta.interaction` hints, read off the idle snapshot by a host. */
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

const schemas = createAgentSchemas({
  meta: metaSchema,
  context: contextSchema,
  input: z.object({ ticket: z.string() }),
  output: triageOutputSchema,
  events: {
    /** Accept the model's category as classified. */
    CONFIRM: z.object({}),
    /** Override it. Free text lands in `category` and the machine validates it. */
    RECLASSIFY: z.object({ category: z.string() }),
  },
});

export const models = defineModels({
  ticketTriage: openai("gpt-5.4-mini"),
});

const triageAgentSetup = setupAgent({
  schemas,
  models,
  requests: {
    classifyTicket: {
      schemas: {
        input: z.object({ ticket: z.string() }),
        output: classificationSchema,
      },
      model: "ticketTriage",
      system: [
        "You triage inbound support tickets. For each ticket, return:",
        "- sentiment: the customer's tone (positive, neutral, or negative).",
        "- category: billing, technical, or other.",
        "- confidence: 0 to 1, how sure you are of the category. Be honest —",
        "  anything vague or off-topic belongs below 0.6, and a human takes it.",
      ].join("\n"),
      prompt: ({ input }) => input.ticket,
    },
    draftReply: {
      schemas: {
        input: z.object({
          ticket: z.string(),
          category: categorySchema,
          sentiment: sentimentSchema,
          slaNote: z.string(),
        }),
        output: z.object({ reply: z.string() }),
      },
      model: "ticketTriage",
      system:
        "You write support replies: two or three sentences, addressed to the " +
        "customer, acknowledging the issue and stating the next step. No " +
        "greeting boilerplate.",
      prompt: ({ input }) =>
        [
          `Ticket (${input.category}, customer sounds ${input.sentiment}):`,
          input.ticket,
          input.slaNote,
        ].join("\n"),
    },
  },
  // `classifying` assigns `classification` before any of these is entered —
  // narrow it non-null so they can read it.
  states: {
    checkingConfidence: {
      schemas: { context: contextSchema.extend({ classification: classificationSchema }) },
    },
    escalating: {
      schemas: { context: contextSchema.extend({ classification: classificationSchema }) },
    },
    replying: {
      schemas: { context: contextSchema.extend({ classification: classificationSchema }) },
    },
    done: { schemas: { context: contextSchema.extend({ classification: classificationSchema }) } },
    failed: {
      schemas: { context: contextSchema.extend({ classification: classificationSchema }) },
    },
  },
});

export const triageSchemas = schemas;

export const triageMachine = triageAgentSetup.createMachine({
  id: "ticket-triage",
  context: ({ input }) => ({
    ticket: input.ticket,
    classification: null,
    reply: "",
    slaNote: "",
    notice: "",
    escalated: false,
    replyAttempts: 0,
  }),
  initial: "classifying",
  states: {
    classifying: {
      invoke: {
        src: "classifyTicket",
        input: ({ context }) => ({ ticket: context.ticket }),
        onDone: ({ output }) => ({
          target: "checkingConfidence",
          context: { classification: output, slaNote: slaNoteFor(output) },
        }),
      },
    },
    // The guard, as a state you can point at: confident enough to reply, or a
    // person decides first.
    checkingConfidence: {
      type: "choice",
      choice: ({ context }) =>
        context.classification.confidence >= CONFIDENCE_THRESHOLD
          ? {
              target: "replying",
              context: {
                notice:
                  `Classified as ${context.classification.category} ` +
                  `(${context.classification.sentiment}), confidence ${context.classification.confidence}.`,
              },
            }
          : {
              target: "escalating",
              context: {
                escalated: true,
                notice:
                  `Low confidence (${context.classification.confidence}) on ` +
                  `"${context.classification.category}" — a human decides this one.`,
              },
            },
    },
    // No invoke: the run settles idle here and a host resumes it with CONFIRM
    // or RECLASSIFY.
    escalating: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label:
            "{notice} {slaNote} Confirm the category, or type the right one " +
            "(billing, technical, other).",
          textEvent: "RECLASSIFY",
          events: {
            CONFIRM: { label: "Confirm category", style: "primary" },
            RECLASSIFY: { label: "Set category", style: "default" },
          },
        },
      },
      on: {
        CONFIRM: ({ context }) => ({
          target: "replying",
          context: {
            notice: `Human confirmed ${context.classification.category}. Drafting the reply.`,
          },
        }),
        // An unknown category keeps the turn and explains why, so the host
        // re-prompts with feedback instead of silently.
        RECLASSIFY: ({ context, event }) => {
          const parsed = categorySchema.safeParse(event.category.trim().toLowerCase());
          if (!parsed.success) {
            return {
              context: {
                notice: `"${event.category.trim()}" is not a category. Use billing, technical, or other.`,
              },
            };
          }
          const classification = {
            ...context.classification,
            category: parsed.data,
            confidence: 1,
          };
          return {
            target: "replying",
            context: {
              classification,
              slaNote: slaNoteFor(classification),
              notice: `Human set the category to ${parsed.data}. Drafting the reply.`,
            },
          };
        },
      },
    },
    replying: {
      invoke: {
        src: "draftReply",
        input: ({ context }) => ({
          ticket: context.ticket,
          category: context.classification.category,
          sentiment: context.classification.sentiment,
          slaNote: context.slaNote,
        }),
        onDone: ({ output }) => ({ target: "done", context: { reply: output.reply } }),
        onError: ({ context }) => ({
          target: "replyFailed",
          context: { replyAttempts: context.replyAttempts + 1 },
        }),
      },
    },
    // One retry, then degrade. The budget is a typed guard, not a try/catch.
    replyFailed: {
      type: "choice",
      choice: ({ context }) =>
        context.replyAttempts < 2
          ? { target: "replying", context: { notice: "Reply generation failed; retrying once." } }
          : {
              target: "failed",
              context: {
                notice: "Reply generation failed twice; handing the ticket to a support agent.",
                reply:
                  "We have your ticket and a support agent is picking it up now. " +
                  `${context.slaNote}`,
              },
            },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        summary: `${context.notice} ${context.slaNote} Drafted reply: ${context.reply}`,
        sentiment: context.classification.sentiment,
        category: context.classification.category,
        reply: context.reply,
        escalated: context.escalated,
      }),
    },
    // Best-effort terminal: the draft never landed, so a holding reply ships
    // instead of an error.
    failed: {
      type: "final",
      output: ({ context }) => ({
        summary: `${context.notice} ${context.slaNote}`,
        sentiment: context.classification.sentiment,
        category: context.classification.category,
        reply: context.reply,
        escalated: context.escalated,
      }),
    },
  },
});

export type TriageSnapshot = SnapshotFrom<typeof triageMachine>;

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

/** The label a host shows while the run waits on a human. */
export function escalationLabel(snapshot: TriageSnapshot): string {
  const interaction = getStateMeta(snapshot).interaction;
  return resolveInteractionLabel(interaction?.label ?? "Confirm the category.", snapshot.context);
}

// Sample data — a stand-in for a ticket pulled from your support inbox.
const SAMPLE_TICKET =
  "I was charged twice for my March subscription and the second charge never " +
  "showed up as a plan on my account. Can you refund the duplicate? This is " +
  "the third time billing has gone wrong this year.";

export async function main() {
  const executors = createAiSdkExecutors({ models });

  const pasted = await promptLine("Paste a ticket (blank = sample) > ");
  const ticket = pasted === "" ? SAMPLE_TICKET : pasted;

  const shared = {
    executors,
    onTransition: (snapshot: TriageSnapshot) =>
      console.log("[state]", JSON.stringify(snapshot.value)),
  };

  let result = await runAgent(triageMachine, { input: { ticket }, ...shared });

  // A low-confidence classification settles the run idle; resume it with the
  // human's decision.
  while (result.status === "idle") {
    const answer = await promptLine(`${escalationLabel(result.snapshot)}\n> `);
    result = await runAgent(triageMachine, {
      snapshot: result.persist(),
      event: answer === "" ? { type: "CONFIRM" } : { type: "RECLASSIFY", category: answer },
      ...shared,
    });
  }

  if (result.status !== "done") {
    throw new Error(`Triage did not complete: ${result.status}`);
  }
  console.log(JSON.stringify(result.output, null, 2));
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
