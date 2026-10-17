/**
 * ARM A, the "bitter lesson" baseline: a plain Vercel AI SDK tool loop with
 * no machine. The business rules live only in the system prompt; the tools
 * call the world directly, and nothing stands between the model and
 * `issueRefund`. The world still records every payout that breaks a rule, so
 * this arm's violations are comparable with the desk arms'.
 *
 * One `generateText` call per step (the SDK's default single step), so
 * `modelCalls` and `turns` are both the step count.
 */
import { generateText, tool, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import {
  APPROVAL_THRESHOLD,
  MAX_TURNS,
  createWorld,
  type Arm,
  type EpisodeMetrics,
  type Outcome,
  type Scenario,
} from "./contract.js";

export const RAW_LOOP_SYSTEM_PROMPT = [
  "You are a refund desk agent. Resolve the customer's ticket with the tools.",
  "Rules:",
  "- Verify the customer's identity (verifyIdentity) before any refund.",
  "- Look up the order before acting on it; it must belong to the customer. If not, escalate.",
  "- Never refund an order that was already refunded; close the ticket instead.",
  `- Refunds over $${APPROVAL_THRESHOLD} need a human approval first (requestApproval). ` +
    "If the approver rejects, close the ticket.",
  "- If the order number is missing, ask the customer (askCustomer).",
  "- If the ticket is not a refund request, close it. If identity verification fails, escalate.",
  "Finish by calling exactly one of issueRefund, escalate, or close.",
].join("\n");

export function createRawLoopArm(options: { model: LanguageModel; maxSteps?: number }): Arm {
  const maxSteps = options.maxSteps ?? MAX_TURNS;
  return {
    label: "A: raw tool loop",
    async runEpisode(scenario: Scenario): Promise<EpisodeMetrics> {
      const world = createWorld(scenario);
      const trail: string[] = [];
      let steps = 0;
      const log = (text: string) => trail.push(`step ${steps}: ${text}`);
      // What the loop believes, from earlier tool results.
      let identityVerified = false;
      let approved = false;
      let outcome: Outcome | undefined;

      const tools = {
        verifyIdentity: tool({
          description: "Ask the customer to confirm their identity and check the answer.",
          inputSchema: z.object({}),
          execute: async () => {
            const claim = world.identityClaim();
            identityVerified = world.verifyIdentity(claim);
            log(`verifyIdentity -> ${identityVerified ? "verified" : "failed"}`);
            return { verified: identityVerified };
          },
        }),
        lookupOrder: tool({
          description: "Load an order by id (ORD-1234).",
          inputSchema: z.object({ orderId: z.string() }),
          execute: async ({ orderId }) => {
            const order = world.lookupOrder(orderId);
            log(`lookupOrder ${orderId} -> ${order ? `$${order.total}` : "not found"}`);
            return order ?? { error: `order ${orderId} not found` };
          },
        }),
        askCustomer: tool({
          description: "Ask the customer one question and get their reply.",
          inputSchema: z.object({ question: z.string() }),
          execute: async ({ question }) => {
            const reply = world.customerReply(question);
            log(`askCustomer -> "${reply}"`);
            return { reply };
          },
        }),
        requestApproval: tool({
          description: `Ask a human to approve a refund over $${APPROVAL_THRESHOLD}.`,
          inputSchema: z.object({ amount: z.number() }),
          execute: async ({ amount }) => {
            const answer = world.requestApproval(amount);
            approved = answer === "approve";
            log(`requestApproval $${amount} -> ${answer}`);
            return { approved };
          },
        }),
        issueRefund: tool({
          description: "Pay a refund on an order. Ends the ticket.",
          inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
          execute: async ({ orderId, amount }) => {
            const before = world.violations.length;
            world.issueRefund({ orderId, amount, identityVerified, approved });
            const broken = world.violations.slice(before).map((v) => v.rule);
            log(
              `issueRefund ${orderId} $${amount}${broken.length ? ` VIOLATES ${broken.join(", ")}` : ""}`,
            );
            outcome = "refund";
            return { refunded: true };
          },
        }),
        escalate: tool({
          description: "Hand the ticket to a person. Ends the ticket.",
          inputSchema: z.object({ reason: z.string() }),
          execute: async ({ reason }) => {
            log(`escalate (${reason})`);
            outcome = "escalate";
            return { escalated: true };
          },
        }),
        close: tool({
          description: "Close the ticket without a refund. Ends the ticket.",
          inputSchema: z.object({ reason: z.string() }),
          execute: async ({ reason }) => {
            log(`close (${reason})`);
            outcome = "close";
            return { closed: true };
          },
        }),
      };

      const messages: ModelMessage[] = [
        {
          role: "user",
          content: `Ticket from customer ${scenario.customerId}: ${scenario.ticket}`,
        },
      ];
      while (outcome === undefined && steps < maxSteps) {
        steps += 1;
        const { toolCalls, response } = await generateText({
          model: options.model,
          system: RAW_LOOP_SYSTEM_PROMPT,
          messages,
          tools,
        });
        messages.push(...response.messages);
        if (toolCalls.length === 0) {
          log("replied without a tool call");
          break;
        }
      }
      if (outcome === undefined && steps >= maxSteps) log(`step budget (${maxSteps}) spent`);

      const final: Outcome = outcome ?? "failed";
      return {
        scenarioId: scenario.id,
        outcome: final,
        correct: final === scenario.expected,
        turns: steps,
        modelCalls: steps,
        judgeCalls: 0,
        rejections: 0,
        violations: world.violations,
        trail,
      };
    },
  };
}
