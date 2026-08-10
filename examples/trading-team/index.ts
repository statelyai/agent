/**
 * Trading team: parallel specialist analysts, a MULTI-ROUND bull/bear debate, a
 * trader proposal, risk review, and a portfolio decision that can REJECT and
 * force a revision. Ported from TradingAgents.
 *
 * Two control-flow shapes make it faithful to that pattern:
 *   - Debate is a bounded loop, not a one-shot. Bull and bear ALTERNATE
 *     (`bullArguing → bearArguing → debateCheck`), each turn appended to a typed
 *     transcript so the bear rebuts the bull's latest point and vice versa;
 *     `debateCheck` loops until `round >= maxDebateRounds` (default 1).
 *   - The risk desk owns the policy, and the trader does not. The trader's first
 *     proposal never carries risk controls (its brief says so: risk controls are
 *     the desk's job), so the deterministic `policyCheck` gate always sends the
 *     first proposal back once with the desk's actual limits attached. The
 *     revision complies and clears. Every send-back and clearance appends a line
 *     to `riskNotice`, which is the run's readable trail.
 *   - Risk review is a rejection loop. On `approved: false`, `decisionCheck`
 *     routes back to `proposing` with the rejection reason in context so the
 *     trader revises. Bounded to one revision (`maxRevisions`, default 1); a
 *     second rejection ends in the `rejected` terminal (a normal output, not an
 *     error).
 *
 * Data feeds and order execution stay host-owned; this example never trades.
 * Dual-mode: `runTradingTeamExample(options?)` takes an injectable `generateText`
 * (tests pass a scripted mock, keyless CI); the direct run uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/trading-team/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const analysesSchema = z.object({
  fundamentals: z.string().nullable(),
  sentiment: z.string().nullable(),
  technical: z.string().nullable(),
});
const actionSchema = z.enum(["buy", "hold", "sell"]);
// One debate turn. The transcript is an ordered array of these, so alternation
// order and round count are readable straight off the context.
const debateTurnSchema = z.object({
  stance: z.enum(["bull", "bear"]),
  argument: z.string(),
});
const proposalSchema = z.object({
  action: actionSchema,
  /** Position size as a percent of the portfolio. */
  sizePct: z.number(),
  /** Stop-loss as a percent below entry, or null when no risk control is set. */
  stopLossPct: z.number().nullable(),
  rationale: z.string(),
});

/**
 * The risk desk's standing policy. The trader is not shown it until a proposal
 * is sent back, which is what makes the first send-back deterministic rather
 * than a coin flip on the model's mood.
 */
const DESK_POLICY = {
  maxPositionPct: 2,
  requireStopLoss: true,
  /** How many times the desk will send a proposal back before escalating. */
  maxSendBacks: 1,
} as const;

const POLICY_TEXT =
  `Risk desk policy: position size at most ${DESK_POLICY.maxPositionPct}% of the ` +
  "portfolio, and every proposal must set an explicit stopLossPct.";

/** The policy breaches in a proposal, empty when it complies. */
function policyBreaches(proposal: z.infer<typeof proposalSchema>): string[] {
  const breaches: string[] = [];
  if (DESK_POLICY.requireStopLoss && proposal.stopLossPct === null) {
    breaches.push("no stop-loss set");
  }
  if (proposal.sizePct > DESK_POLICY.maxPositionPct) {
    breaches.push(
      `size ${proposal.sizePct}% exceeds the ${DESK_POLICY.maxPositionPct}% desk limit`,
    );
  }
  return breaches;
}
const riskSchema = z.object({ acceptable: z.boolean(), concerns: z.array(z.string()) });
const decisionSchema = z.object({
  approved: z.boolean(),
  action: actionSchema,
  reason: z.string(),
});

export const models = defineModels({
  analyst: openai("gpt-5.4-mini"),
  researcher: openai("gpt-5.4-mini"),
  trader: openai("gpt-5.4-mini"),
  risk: openai("gpt-5.4-mini"),
  portfolio: openai("gpt-5.4-mini"),
});

const setup = setupAgent({
  models,
  context: z.object({
    symbol: z.string(),
    marketData: z.string(),
    analyses: analysesSchema,
    debate: z.array(debateTurnSchema),
    round: z.number(),
    maxDebateRounds: z.number(),
    // Set when a decision is rejected or the desk sends a proposal back; fed
    // into the next proposal.
    rejectionReason: z.string().nullable(),
    revisions: z.number(),
    maxRevisions: z.number(),
    // Desk send-backs, budgeted separately from portfolio-manager rejections.
    sendBacks: z.number(),
    // One line per desk action, the run's readable trail.
    riskNotice: z.string(),
    proposal: proposalSchema.nullable(),
    risk: riskSchema.nullable(),
    decision: decisionSchema.nullable(),
  }),
  input: z.object({
    symbol: z.string(),
    marketData: z.string(),
    maxDebateRounds: z.number().default(1),
    maxRevisions: z.number().default(1),
  }),
  // `riskNotice` is the one leading string; the decision prose stays nested so
  // it never outgrows the trail.
  output: z.object({
    riskNotice: z.string(),
    outcome: z.enum(["approved", "rejected"]),
    action: actionSchema,
    revisions: z.number(),
    sendBacks: z.number(),
    details: z.object({
      reason: z.string(),
      proposal: proposalSchema.nullable(),
      risk: riskSchema.nullable(),
    }),
  }),
  // Narrow the fields each state guarantees, so downstream reads are non-null
  // without assertions. `reviewingRisk`/`deciding` always run after a proposal;
  // both terminals always run after a decision.
  states: {
    policyCheck: { context: { proposal: proposalSchema } },
    reviewingRisk: { context: { proposal: proposalSchema } },
    deciding: { context: { proposal: proposalSchema, risk: riskSchema } },
    done: { context: { decision: decisionSchema } },
    rejected: { context: { decision: decisionSchema } },
  },
  requests: {
    analyze: {
      schemas: {
        input: z.object({
          role: z.enum(["fundamentals", "sentiment", "technical"]),
          data: z.string(),
        }),
        output: z.string(),
      },
      model: "analyst",
      system: ({ input }) =>
        `You are the ${input.role} analyst. Analyze only the supplied data, in ` +
        "at most two short sentences.",
      prompt: ({ input }) => input.data,
    },
    // One debate turn. Sees the analyst reports AND the running transcript, so a
    // rebuttal can address the opponent's latest argument.
    debate: {
      schemas: {
        input: z.object({
          stance: z.enum(["bull", "bear"]),
          analyses: analysesSchema,
          transcript: z.array(debateTurnSchema),
        }),
        output: z.string(),
      },
      model: "researcher",
      system: ({ input }) =>
        `Argue the ${input.stance} case in at most three sentences. Address the ` +
        "analyst reports and directly rebut the opponent's most recent argument " +
        "in the transcript.",
      prompt: ({ input }) =>
        JSON.stringify({ analyses: input.analyses, transcript: input.transcript }),
    },
    // Proposal (or revision). On a revision `rejectionReason` is set and must be
    // addressed.
    propose: {
      schemas: {
        input: z.object({
          analyses: analysesSchema,
          debate: z.array(debateTurnSchema),
          rejectionReason: z.string().nullable(),
        }),
        output: proposalSchema,
      },
      model: "trader",
      // Separation of duties, and the reason the first send-back is certain: on
      // the opening proposal the trader is told risk controls are not its job,
      // so `stopLossPct` comes back null and `policyCheck` bounces it. The
      // rejection reason then carries the desk's actual policy, and the revision
      // can comply.
      system: ({ input }) =>
        input.rejectionReason
          ? "Propose buy, hold, or sell from the analyst evidence and the debate. " +
            "Your prior proposal was sent back: address the stated reason exactly, " +
            "including any size limit and stop-loss requirement. Keep the rationale " +
            "to one sentence. Do not invent data."
          : "Propose buy, hold, or sell from the analyst evidence and the debate, " +
            "with a position size in percent of the portfolio. Risk controls belong " +
            "to the risk desk, not to you: set stopLossPct to null. Keep the " +
            "rationale to one sentence. Do not invent data.",
      prompt: ({ input }) => JSON.stringify(input),
    },
    reviewRisk: {
      schemas: {
        input: z.object({ proposal: proposalSchema }),
        output: riskSchema,
      },
      model: "risk",
      system:
        "Review the proposal for unsupported assumptions and downside risk. List " +
        "at most two concerns, a few words each.",
      prompt: ({ input }) => JSON.stringify(input.proposal),
    },
    decide: {
      schemas: {
        input: z.object({ proposal: proposalSchema, risk: riskSchema }),
        output: decisionSchema,
      },
      model: "portfolio",
      system:
        "Make the final paper-trading decision. Reject unsupported or " +
        "unacceptable-risk proposals with a clear one-sentence reason.",
      prompt: ({ input }) => JSON.stringify(input),
    },
  },
});

/** Both terminals report the same shape: the desk trail leads, prose nests. */
function finalOutput(
  context: {
    riskNotice: string;
    decision: z.infer<typeof decisionSchema>;
    revisions: number;
    sendBacks: number;
    proposal: z.infer<typeof proposalSchema> | null;
    risk: z.infer<typeof riskSchema> | null;
  },
  outcome: "approved" | "rejected",
) {
  return {
    riskNotice: context.riskNotice.trimEnd(),
    outcome,
    action: context.decision.action,
    revisions: context.revisions,
    sendBacks: context.sendBacks,
    details: {
      reason: context.decision.reason,
      proposal: context.proposal,
      risk: context.risk,
    },
  };
}

export const tradingTeamMachine = setup.createMachine({
  id: "trading-team",
  context: ({ input }) => ({
    symbol: input.symbol,
    marketData: input.marketData,
    analyses: { fundamentals: null, sentiment: null, technical: null },
    debate: [],
    round: 0,
    maxDebateRounds: input.maxDebateRounds,
    rejectionReason: null,
    revisions: 0,
    maxRevisions: input.maxRevisions,
    sendBacks: 0,
    riskNotice: "",
    proposal: null,
    risk: null,
    decision: null,
  }),
  initial: "analyzing",
  states: {
    // Three specialists in parallel (unchanged fan-out).
    analyzing: {
      type: "parallel",
      onDone: { target: "bullArguing" },
      states: {
        fundamentals: {
          initial: "active",
          states: {
            active: {
              invoke: {
                src: "analyze",
                input: ({ context }) => ({ role: "fundamentals", data: context.marketData }),
                onDone: ({ output, context }) => ({
                  target: "done",
                  context: { analyses: { ...context.analyses, fundamentals: output } },
                }),
              },
            },
            done: { type: "final" },
          },
        },
        sentiment: {
          initial: "active",
          states: {
            active: {
              invoke: {
                src: "analyze",
                input: ({ context }) => ({ role: "sentiment", data: context.marketData }),
                onDone: ({ output, context }) => ({
                  target: "done",
                  context: { analyses: { ...context.analyses, sentiment: output } },
                }),
              },
            },
            done: { type: "final" },
          },
        },
        technical: {
          initial: "active",
          states: {
            active: {
              invoke: {
                src: "analyze",
                input: ({ context }) => ({ role: "technical", data: context.marketData }),
                onDone: ({ output, context }) => ({
                  target: "done",
                  context: { analyses: { ...context.analyses, technical: output } },
                }),
              },
            },
            done: { type: "final" },
          },
        },
      },
    },
    // Debate loop: bull argues, then bear rebuts, one round per pass.
    bullArguing: {
      invoke: {
        src: "debate",
        input: ({ context }) => ({
          stance: "bull",
          analyses: context.analyses,
          transcript: context.debate,
        }),
        onDone: ({ output, context }) => ({
          target: "bearArguing",
          context: { debate: [...context.debate, { stance: "bull", argument: output }] },
        }),
      },
    },
    bearArguing: {
      invoke: {
        src: "debate",
        input: ({ context }) => ({
          stance: "bear",
          analyses: context.analyses,
          transcript: context.debate,
        }),
        onDone: ({ output, context }) => ({
          target: "debateCheck",
          context: {
            debate: [...context.debate, { stance: "bear", argument: output }],
            round: context.round + 1,
          },
        }),
      },
    },
    // Bounded-loop guard: another round, or move on to the trader.
    debateCheck: {
      type: "choice",
      choice: ({ context }) =>
        context.round >= context.maxDebateRounds
          ? { target: "proposing" }
          : { target: "bullArguing" },
    },
    proposing: {
      invoke: {
        src: "propose",
        input: ({ context }) => ({
          analyses: context.analyses,
          debate: context.debate,
          rejectionReason: context.rejectionReason,
        }),
        onDone: ({ output }) => ({ target: "policyCheck", context: { proposal: output } }),
      },
    },
    // The deterministic desk gate. No model call: the proposal either meets the
    // written policy or it does not. The opening proposal never does (the trader
    // is briefed not to set risk controls), so the send-back always happens once
    // and is visible in `riskNotice`.
    policyCheck: {
      type: "choice",
      choice: ({ context }) => {
        const breaches = policyBreaches(context.proposal);
        const round = context.sendBacks + 1;
        if (breaches.length === 0) {
          return {
            target: "reviewingRisk",
            context: {
              riskNotice:
                `${context.riskNotice}${round}. cleared. ` +
                `size ${context.proposal.sizePct}%, stop-loss ${context.proposal.stopLossPct}%\n`,
            },
          };
        }
        // Budget spent: the desk escalates the breach to the portfolio manager
        // rather than looping forever.
        if (context.sendBacks >= DESK_POLICY.maxSendBacks) {
          return {
            target: "reviewingRisk",
            context: {
              riskNotice: `${context.riskNotice}${round}. escalated. ${breaches.join("; ")}\n`,
            },
          };
        }
        return {
          target: "proposing",
          context: {
            sendBacks: context.sendBacks + 1,
            rejectionReason: `${breaches.join("; ")}. ${POLICY_TEXT}`,
            riskNotice: `${context.riskNotice}${round}. blocked. ${breaches.join("; ")}\n`,
          },
        };
      },
    },
    reviewingRisk: {
      invoke: {
        src: "reviewRisk",
        input: ({ context }) => ({ proposal: context.proposal }),
        onDone: ({ context, output }) => ({
          target: "deciding",
          context: {
            risk: output,
            riskNotice:
              `${context.riskNotice}risk review. ` +
              `${output.acceptable ? "acceptable" : "not acceptable"}. ` +
              `${output.concerns.join("; ") || "no concerns"}\n`,
          },
        }),
      },
    },
    deciding: {
      invoke: {
        src: "decide",
        input: ({ context }) => ({ proposal: context.proposal, risk: context.risk }),
        // On rejection, record the reason and count the revision so the loop
        // guard can bound it.
        onDone: ({ output, context }) => ({
          target: "decisionCheck",
          context: {
            decision: output,
            revisions: output.approved ? context.revisions : context.revisions + 1,
            rejectionReason: output.approved ? context.rejectionReason : output.reason,
            riskNotice:
              `${context.riskNotice}portfolio. ` +
              `${output.approved ? "approved" : "rejected"}. ${output.reason}\n`,
          },
        }),
      },
    },
    // Approved → done. Rejected and revision budget left → revise. Rejected
    // again → the `rejected` terminal.
    decisionCheck: {
      type: "choice",
      choice: ({ context }) =>
        context.decision?.approved
          ? { target: "done" }
          : context.revisions > context.maxRevisions
            ? { target: "rejected" }
            : { target: "proposing" },
    },
    done: {
      type: "final",
      output: ({ context }) => finalOutput(context, "approved"),
    },
    rejected: {
      type: "final",
      output: ({ context }) => finalOutput(context, "rejected"),
    },
  },
});

export interface RunTradingTeamOptions {
  symbol?: string;
  marketData?: string;
  maxDebateRounds?: number;
  maxRevisions?: number;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition (the debate rounds and rejection loop). */
  onProgress?: (state: string) => void;
}

export interface TradingTeamResult {
  riskNotice: string;
  outcome: "approved" | "rejected";
  action: z.infer<typeof actionSchema>;
  revisions: number;
  sendBacks: number;
  details: {
    reason: string;
    proposal: z.infer<typeof proposalSchema> | null;
    risk: z.infer<typeof riskSchema> | null;
  };
  progress: string[];
}

/** Runs the trading-team flow; records state progress so the loops are observable. */
export async function runTradingTeamExample(
  options: RunTradingTeamOptions = {},
): Promise<TradingTeamResult> {
  const {
    symbol = "ACME",
    marketData = "Illustrative data only: revenue +8%, neutral sentiment, flat momentum.",
    maxDebateRounds = 1,
    maxRevisions = 1,
    generateText,
    onProgress,
  } = options;

  const progress: string[] = [];
  const result = await runAgent(tradingTeamMachine, {
    input: { symbol, marketData, maxDebateRounds, maxRevisions },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    onTransition: (snapshot) => {
      const value = snapshot.value;
      const state = typeof value === "string" ? value : (Object.keys(value)[0] ?? "");
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Trading team did not complete: ${result.status}`);
  }
  return { ...result.output, progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run this example.");
  void runTradingTeamExample({
    onProgress: (state) => console.log(`  → ${state}`),
  }).then((result) => {
    console.log("\n" + result.riskNotice);
    console.log("\nOutcome:", result.outcome, "-", result.action);
  });
}
