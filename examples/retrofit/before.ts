/**
 * BEFORE — a hand-rolled support-ticket resolution agent, no @statelyai/agent.
 *
 * A realistic tangle you might actually ship: a `while (true)` loop, phase
 * tracked in mutable strings + boolean flags, tool choice dispatched through a
 * nested `if/else`, an inline retry/backoff wrapper around every model call, a
 * `$100` refund limit enforced by an `if`, and a human-approval pause faked with
 * a returned `{ pending }` sentinel + a `resume()` closure that re-enters the
 * loop. Transcript bookkeeping is duplicated at every branch.
 *
 * It works. `retrofit/index.ts` is the same behavior as an agent machine; the
 * `step1/2/3` files walk the conversion. Injectable `generateText` for tests.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/retrofit/before.ts
 */
import { generateText, tool, type GenerateTextResult, type ToolSet } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

/** Refunds at or below this settle automatically; above needs a human. */
const REFUND_LIMIT = 100;

/** A tiny fixed order table (stand-in for your orders DB). */
const ORDERS: Record<string, { customer: string; total: number; item: string }> = {
  A1001: { customer: "Ada Lovelace", total: 240, item: "Standing desk" },
  B2002: { customer: "Alan Turing", total: 60, item: "Mechanical keyboard" },
};

type Phase = "triage" | "resolving" | "awaiting_approval" | "done";

interface TranscriptEntry {
  role: "system" | "assistant" | "tool";
  content: string;
}

export interface SupportResult {
  refunded: boolean;
  escalated: boolean;
  resolution: string;
  transcript: TranscriptEntry[];
}

/** The human-approval sentinel: state is trapped in the `resume` closure. */
export interface PendingApproval {
  pending: "approval";
  amount: number;
  resume: (approved: boolean) => Promise<SupportResult | PendingApproval>;
}

export type RunOutcome = SupportResult | PendingApproval;

/** Injected for tests; a direct run uses the real AI SDK. */
export type GenerateText = typeof generateText;

interface Deps {
  generateText?: GenerateText;
  model?: string;
}

/** The inline retry/backoff wrapper wrapped around EVERY model call. */
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 50));
    }
  }
  throw new Error(`${label} failed after ${tries} attempts: ${String(lastError)}`);
}

const tools = {
  lookupOrder: tool({
    description: "Look up an order by its id.",
    inputSchema: z.object({ orderId: z.string() }),
  }),
  issueRefund: tool({
    description: "Refund the customer a dollar amount.",
    inputSchema: z.object({ amount: z.number(), reason: z.string() }),
  }),
  escalate: tool({
    description: "Escalate the ticket to a human specialist.",
    inputSchema: z.object({ reason: z.string() }),
  }),
  resolve: tool({
    description: "Close the ticket with a final reply to the customer.",
    inputSchema: z.object({ message: z.string() }),
  }),
} satisfies ToolSet;

/** Hand-maintained tool-call union — the type-level twin of the if/else below. */
type SupportToolCall =
  | { toolName: "lookupOrder"; input: { orderId: string } }
  | { toolName: "issueRefund"; input: { amount: number; reason: string } }
  | { toolName: "escalate"; input: { reason: string } }
  | { toolName: "resolve"; input: { message: string } };

/**
 * Drive one support ticket to a resolution — or to a `{ pending }` sentinel when
 * a refund exceeds the limit and needs sign-off. All state (messages, flags,
 * transcript) lives in this closure, which is exactly why the pause has to hand
 * back a `resume` that re-enters the loop.
 */
export async function runSupportAgent(ticket: string, deps: Deps = {}): Promise<RunOutcome> {
  const gen = deps.generateText ?? generateText;
  const model = deps.model ?? "gpt-5.4-mini";

  // Duplicated bookkeeping: everything that happens gets pushed to BOTH the
  // model `messages` and the human-readable `transcript`, by hand, everywhere.
  const messages: Array<{ role: "user" | "assistant" | "tool"; content: string }> = [
    { role: "user", content: ticket },
  ];
  const transcript: TranscriptEntry[] = [];

  let phase: Phase = "triage";
  let refunded = false;
  let escalated = false;
  let resolution = "";
  let pendingRefundAmount = 0;

  const call = (prompt: string, useTools: boolean) =>
    withRetry("generateText", () =>
      gen({
        model: openai(model),
        system:
          "You are a support agent. Triage the ticket, look up orders when useful, " +
          "issue small refunds directly, escalate anything you cannot resolve, and " +
          "close with a final reply.",
        prompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })) as never,
        ...(useTools ? { tools } : {}),
      } as never),
    ) as Promise<GenerateTextResult<typeof tools, never>>;

  async function drive(): Promise<RunOutcome> {
    while (true) {
      if (phase === "triage") {
        const { text } = await call(`Classify and plan next step for: ${ticket}`, false);
        messages.push({ role: "assistant", content: text });
        transcript.push({ role: "assistant", content: `triage: ${text}` });
        phase = "resolving";
      } else if (phase === "resolving") {
        const result = await call("Take the next action on this ticket.", true);
        const toolCalls = result.toolCalls as unknown as SupportToolCall[] | undefined;

        if (!toolCalls || toolCalls.length === 0) {
          // No tool: treat the text as the closing reply.
          resolution = result.text;
          transcript.push({ role: "assistant", content: result.text });
          phase = "done";
        } else {
          // Nested if/else tool dispatch — one arm per tool, easy to fall out of
          // sync with the tool set above.
          for (const c of toolCalls) {
            if (c.toolName === "lookupOrder") {
              const order = ORDERS[c.input.orderId];
              const summary = order
                ? `Order ${c.input.orderId}: ${order.item}, $${order.total}, ${order.customer}`
                : `Order ${c.input.orderId} not found`;
              messages.push({ role: "tool", content: summary });
              transcript.push({ role: "tool", content: summary });
            } else if (c.toolName === "issueRefund") {
              if (c.input.amount > REFUND_LIMIT) {
                // The escalation-threshold branch: pause for a human.
                pendingRefundAmount = c.input.amount;
                phase = "awaiting_approval";
              } else {
                refunded = true;
                resolution = `Refunded $${c.input.amount}: ${c.input.reason}`;
                messages.push({ role: "tool", content: resolution });
                transcript.push({ role: "tool", content: resolution });
                phase = "done";
              }
            } else if (c.toolName === "escalate") {
              escalated = true;
              resolution = `Escalated: ${c.input.reason}`;
              transcript.push({ role: "tool", content: resolution });
              phase = "done";
            } else if (c.toolName === "resolve") {
              resolution = c.input.message;
              transcript.push({ role: "assistant", content: c.input.message });
              phase = "done";
            }
          }
        }
      }

      if (phase === "awaiting_approval") {
        // The pause. There is no state machine to persist, so we hand back a
        // sentinel plus a `resume` that closes over everything and re-enters the
        // loop. Nothing here is serializable; nothing survives a process restart.
        return {
          pending: "approval",
          amount: pendingRefundAmount,
          resume: async (approved: boolean) => {
            if (approved) {
              refunded = true;
              resolution = `Refunded $${pendingRefundAmount} after approval`;
              transcript.push({ role: "tool", content: resolution });
            } else {
              escalated = true;
              resolution = `Refund of $${pendingRefundAmount} denied; escalated`;
              transcript.push({ role: "tool", content: resolution });
            }
            phase = "done";
            return drive();
          },
        };
      }

      if (phase === "done") {
        return { refunded, escalated, resolution, transcript };
      }
    }
  }

  return drive();
}

// Direct run (real model). Kept minimal — the machine version is the one to read.
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const outcome = await runSupportAgent("Please refund order A1001, it arrived damaged.");
    if ("pending" in outcome) {
      console.log(`Paused for approval of $${outcome.amount}. Approving...`);
      console.log(await outcome.resume(true));
    } else {
      console.log(outcome);
    }
  })();
}
