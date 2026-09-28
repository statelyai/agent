/**
 * An XState v5-style machine, kept as JSON, running as an agent on v6.
 *
 * `machine.json` is written the way v5 machines are: string targets
 * (`"onError": "failed"`), named actions and guards (`"saveDraft"`,
 * `"canRevise"`), and an invoke by `src` name — exactly what `createMachine`
 * took in v5, or what Stately Studio exports. None of it mentions a model.
 *
 * The code below supplies what JSON cannot hold, by name:
 *
 *   - `draftReply`, the invoked actor, is a model request (`createTextLogic`).
 *   - `inputs.draftReply` builds its input from context.
 *   - `assigns` are the v5 `assign(...)` actions: each returns context fields.
 *   - `guards.canRevise` bounds the revision loop.
 *
 * `fromV5Config` (./from-v5-config.ts) bridges the few v5 → v6 JSON
 * differences and returns a plain v6 machine; the agent runtime runs it like
 * any other.
 *
 * Run: OPENAI_API_KEY=... pnpm tsx examples/xstate-v5-json/index.ts
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  createAgentRuntime,
  createTextLogic,
  runToQuiescence,
  type AgentRequestExecutors,
} from "@statelyai/agent";
import { fromV5Config } from "./from-v5-config.js";

/** Change requests allowed before the machine gives up. */
export const MAX_REVISIONS = 2;

const models = { writer: openai("gpt-5.4-mini") };

type Context = {
  ticket: string;
  draft: string | null;
  feedback: string | null;
  revisions: number;
};

const machineConfig = JSON.parse(
  readFileSync(new URL("./machine.json", import.meta.url), "utf8"),
) as object;

export const supportReplyMachine = fromV5Config(machineConfig, {
  actors: {
    draftReply: createTextLogic({
      schemas: {
        input: z.object({ ticket: z.string(), feedback: z.string().nullable() }),
        output: z.string(),
      },
      model: "writer",
      system: "You write short, friendly support replies — three sentences at most.",
      prompt: ({ input }) =>
        input.feedback
          ? `Ticket: ${input.ticket}\nRewrite the reply. Reviewer feedback: ${input.feedback}`
          : `Ticket: ${input.ticket}\nWrite the reply.`,
    }),
  },
  inputs: {
    draftReply: ({ context }: { context: Context }) => ({
      ticket: context.ticket,
      feedback: context.feedback,
    }),
  },
  assigns: {
    saveTicket: ({ event }) => ({ ticket: event.text }),
    saveDraft: ({ event }) => ({ draft: event.output.result }),
    saveFeedback: ({ context, event }) => ({
      feedback: event.text,
      revisions: context.revisions + 1,
    }),
  },
  guards: {
    canRevise: ({ context }) => context.revisions < MAX_REVISIONS,
  },
});

export type ReviewEvent = { type: "APPROVE" } | { type: "REVISE"; text: string };

export interface V5JsonResult {
  outcome: "sent" | "gaveUp" | "failed";
  draft: string | null;
  revisions: number;
}

/**
 * A script host: submits the ticket, then answers each review with the next
 * scripted event, resuming from the persisted snapshot every time.
 */
export async function runXstateV5JsonExample(
  executors: Partial<AgentRequestExecutors> = createAiSdkExecutors({ models }),
  options: { ticket?: string; reviews?: ReviewEvent[] } = {},
): Promise<V5JsonResult> {
  const { ticket = "I was charged twice for my March invoice.", reviews = [{ type: "APPROVE" }] } =
    options;
  const events: Array<{ type: string; text?: string }> = [
    { type: "SUBMIT", text: ticket },
    ...reviews,
  ];

  let result = await runToQuiescence(createAgentRuntime(supportReplyMachine, { executors }));
  while (result.status === "idle") {
    const event = events.shift();
    if (!event) throw new Error(`No event left to send in '${String(result.snapshot.value)}'.`);
    result = await runToQuiescence(createAgentRuntime(supportReplyMachine, { executors }), {
      snapshot: result.persist(),
      event: event as never,
    });
  }
  if (result.status === "error") throw result.error;

  const context = result.snapshot.context as Context;
  return {
    outcome: result.snapshot.value as V5JsonResult["outcome"],
    draft: context.draft,
    revisions: context.revisions,
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  runXstateV5JsonExample().then(
    (result) => console.log(result),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
