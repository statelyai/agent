/**
 * Braintrust evals over an agent machine.
 *
 * The machine under test is the email drafter (`../email-drafter/agent-logic.js`)
 * — unmodified. Nothing about it was written "for evals": the seams an eval
 * needs are the ones `runAgent` already returns.
 *
 * Three scorers, three seams:
 * - `output_structure` — `result.output`, the machine's final-state output.
 * - `state_path` / `event_trajectory` — where the machine went, collected from
 *   XState transitions through `onTransition`.
 * - `token_budget` — `result.usage`, summed across the run's resume legs.
 *
 * Two modes, one code path:
 * - keyless (default) — `createScriptedExecutors` plays canned model answers.
 *   Deterministic, free, no network. This is what the test asserts.
 * - live — set `OPENAI_API_KEY` to score the real model instead. Same dataset,
 *   same scorers; only the executors change.
 *
 * Braintrust: `Eval()` runs locally with `noSendLogs: true` and prints a local
 * summary, so the eval runs with no Braintrust account. Set `BRAINTRUST_API_KEY`
 * to upload the experiment instead — that path needs an account and is not
 * exercised by the test.
 *
 * This file scores whole runs. `./seams.ts` scores ONE transition at a time:
 * same machine, routed executors, one `Eval()` per seam.
 *
 * Run: npx tsx examples/braintrust-evals/index.ts
 */
import { Eval } from "braintrust";
import type { EventFromLogic, Snapshot, SnapshotFrom } from "xstate";
import { createScriptedExecutors, matchesTrajectory, runAgent } from "@statelyai/agent";
import type { AgentRequestExecutors } from "@statelyai/agent";
import { emailDrafter, models } from "../email-drafter/agent-logic.js";

type DrafterEvent = EventFromLogic<typeof emailDrafter>;
type DrafterSnapshot = SnapshotFrom<typeof emailDrafter>;

/**
 * The states where the drafter waits for a human. Declared so idle detection is
 * deterministic instead of falling back to `runAgent`'s timing heuristic.
 */
/** One dataset row's input: the request, plus how the simulated user behaves. */
export interface DrafterCase {
  /** The initial drafting request. */
  prompt: string;
  /**
   * What the user answers when the machine asks for more detail. `null` = the
   * user declines and picks "draft anyway" instead.
   */
  details: string | null;
  /** Canned model answers for the keyless run, in call order. */
  script: {
    /** One assessment per `evaluatePrompt` call. */
    assessments: { satisfied: boolean; missing: string[]; questions: string[] }[];
    /** The draft the model returns. */
    draft: { to: string; subject: string; body: string };
    /** Tokens each scripted call reports, so the budget scorer has real numbers. */
    tokensPerCall: number;
  };
}

/** What a dataset row expects. */
export interface DrafterExpectation {
  /** States the run must pass through, in this order (gaps allowed). */
  statePath: string[];
  /** Event types the durable log must contain, in this order (gaps allowed). */
  eventTrajectory: string[];
  /**
   * The recipient the sent email must be addressed to, or `null` when the row
   * never supplies one (the model cannot be scored on a recipient it was never
   * told).
   */
  to: string | null;
  /** How many emails must have been sent. */
  sentCount: number;
  /** Total tokens the run may spend before the budget scorer starts docking. */
  maxTokens: number;
}

/** What the task function returns for a row — the eval's `output`. */
export interface DrafterOutcome {
  status: "done" | "idle" | "error";
  /** The machine's final output: every email the run sent. */
  sentEmails: { to: string; subject: string; body: string }[];
  /** Every state the run entered, in order (from `onTransition`). */
  statePath: string[];
  /** Event types observed on XState root transitions. */
  eventTrajectory: string[];
  modelCalls: number;
  totalTokens: number;
}

// ─── The task: drive the machine to done ───

/**
 * A simulated user: answers whatever interaction the machine is waiting on.
 * It reads the state, not a fixed transcript, so the same policy works when a
 * real model sends the run down a different branch.
 */
function nextUserEvent(
  snapshot: DrafterSnapshot,
  drafterCase: DrafterCase,
  detailsUsed: boolean,
): DrafterEvent | null {
  switch (snapshot.value) {
    case "prompting":
      return { type: "PROMPT_SUBMITTED", prompt: drafterCase.prompt } as DrafterEvent;
    case "needsMoreInfo":
      return drafterCase.details !== null && !detailsUsed
        ? ({ type: "MORE_INFO", details: drafterCase.details } as DrafterEvent)
        : ({ type: "DRAFT_ANYWAY" } as DrafterEvent);
    case "reviewing":
      return { type: "SEND" } as DrafterEvent;
    case "sent":
      return { type: "END" } as DrafterEvent;
    default:
      return null;
  }
}

/**
 * Runs one dataset row to completion and collects everything the scorers need.
 *
 * The machine pauses for the human, so a run is several `runAgent` legs chained
 * by native persisted snapshots and events. Usage is summed across legs.
 */
export async function runDrafterCase(
  drafterCase: DrafterCase,
  executors: Partial<AgentRequestExecutors>,
  maxLegs = 12,
): Promise<DrafterOutcome> {
  const statePath: string[] = [];
  const eventTrajectory: string[] = [];
  let snapshot: Snapshot<unknown> | undefined;
  let liveSnapshot: DrafterSnapshot | undefined;
  let detailsUsed = false;
  let modelCalls = 0;
  let totalTokens = 0;
  let status: DrafterOutcome["status"] = "idle";
  let sentEmails: DrafterOutcome["sentEmails"] = [];

  for (let leg = 0; leg < maxLegs; leg++) {
    const event = liveSnapshot
      ? nextUserEvent(liveSnapshot, drafterCase, detailsUsed)
      : ({ type: "PROMPT_SUBMITTED", prompt: drafterCase.prompt } as DrafterEvent);
    if (!event) break;
    if (event.type === "MORE_INFO") detailsUsed = true;

    const result = await runAgent(emailDrafter, {
      ...(snapshot ? { snapshot, event } : { event }),
      executors,
      onTransition: (next, causedBy) => {
        if (snapshot && (causedBy as { type: string }).type === "@xstate.init") return;
        statePath.push(String(next.value));
        eventTrajectory.push(causedBy.type);
      },
    });

    liveSnapshot = result.snapshot;
    snapshot = result.persist();
    modelCalls += result.usage.modelCalls ?? 0;
    totalTokens += result.usage.totalTokens ?? 0;

    if (result.status === "done") {
      status = "done";
      sentEmails = result.output.sentEmails;
      break;
    }
    if (result.status === "error") {
      status = "error";
      break;
    }
  }

  return {
    status,
    sentEmails,
    statePath,
    eventTrajectory,
    modelCalls,
    totalTokens,
  };
}

/** Scripted executors for one row: the canned answers, each reporting tokens. */
export function scriptedExecutorsFor(drafterCase: DrafterCase): Partial<AgentRequestExecutors> {
  const { assessments, draft, tokensPerCall } = drafterCase.script;
  const usage = {
    inputTokens: tokensPerCall,
    outputTokens: 0,
    totalTokens: tokensPerCall,
  };
  return createScriptedExecutors({
    text: [
      ...assessments.map((assessment) => ({ output: assessment, usage })),
      { output: draft, usage },
    ],
  });
}

// ─── Scorers ───

/** `result.output`: did the machine finish, and is the sent email well-formed and addressed correctly? */
export function scoreOutputStructure(
  output: DrafterOutcome,
  expected: DrafterExpectation,
): { name: string; score: number; metadata: Record<string, unknown> } {
  const checks = [
    output.status === "done",
    output.sentEmails.length === expected.sentCount,
    output.sentEmails.every((email) => email.subject.trim() !== "" && email.body.trim() !== ""),
    expected.to === null || output.sentEmails.every((email) => email.to.includes(expected.to!)),
  ];
  return {
    name: "output_structure",
    score: checks.filter(Boolean).length / checks.length,
    metadata: { status: output.status, sent: output.sentEmails.length },
  };
}

/**
 * The state path: did the machine actually go through the states this row
 * expects? `matchesTrajectory` scores it as an ordered subsequence — gaps are
 * fine, order is not — and reports where it diverged, which becomes the
 * scorer's metadata.
 */
export function scoreStatePath(
  output: DrafterOutcome,
  expected: DrafterExpectation,
): { name: string; score: number; metadata: Record<string, unknown> } {
  const match = matchesTrajectory(output.statePath, expected.statePath);
  return {
    name: "state_path",
    score: match.score,
    metadata: {
      statePath: output.statePath.join(" -> "),
      matched: `${match.matchedCount}/${match.expectedCount}`,
      ...(match.firstMiss ? { firstMiss: match.firstMiss } : {}),
    },
  };
}

/**
 * The transition trajectory is observed directly from XState. Scoring it
 * measures the agent's actual path, not a reconstruction of it.
 */
export function scoreEventTrajectory(
  output: DrafterOutcome,
  expected: DrafterExpectation,
): { name: string; score: number; metadata: Record<string, unknown> } {
  const match = matchesTrajectory(output.eventTrajectory, expected.eventTrajectory);
  return {
    name: "event_trajectory",
    score: match.score,
    metadata: {
      eventTrajectory: output.eventTrajectory.join(", "),
      matched: `${match.matchedCount}/${match.expectedCount}`,
      ...(match.firstMiss ? { firstMiss: match.firstMiss } : {}),
    },
  };
}

/** `result.usage`: 1 within budget, degrading linearly to 0 at twice the budget. */
export function scoreTokenBudget(
  output: DrafterOutcome,
  expected: DrafterExpectation,
): { name: string; score: number; metadata: Record<string, unknown> } {
  const over = output.totalTokens - expected.maxTokens;
  const score = over <= 0 ? 1 : Math.max(0, 1 - over / expected.maxTokens);
  return {
    name: "token_budget",
    score,
    metadata: {
      totalTokens: output.totalTokens,
      maxTokens: expected.maxTokens,
      modelCalls: output.modelCalls,
    },
  };
}

/** Every scorer, in the order the summary prints them. */
export const scorers = [
  scoreOutputStructure,
  scoreStatePath,
  scoreEventTrajectory,
  scoreTokenBudget,
];

// ─── Dataset ───

const DRAFT = {
  to: "team@example.com",
  subject: "Deploy pipeline is twice as fast",
  body: "Hi team, the deploy pipeline now runs in half the time. Details in the thread.",
};

/** Three rows, three branches through the machine. */
export const dataset: {
  input: DrafterCase;
  expected: DrafterExpectation;
  metadata: { case: string };
}[] = [
  {
    metadata: { case: "asks-for-missing-recipient" },
    input: {
      prompt: "Tell them the deploy pipeline is twice as fast now.",
      details: "Send it to team@example.com.",
      script: {
        assessments: [
          { satisfied: false, missing: ["recipient"], questions: ["Who should receive it?"] },
          { satisfied: true, missing: [], questions: [] },
        ],
        draft: DRAFT,
        tokensPerCall: 150,
      },
    },
    expected: {
      statePath: [
        "prompting",
        "evaluating",
        "needsMoreInfo",
        "evaluating",
        "drafting",
        "reviewing",
        "sending",
        "sent",
        "done",
      ],
      eventTrajectory: ["@xstate.init", "PROMPT_SUBMITTED", "MORE_INFO", "SEND", "END"],
      to: "team@example.com",
      sentCount: 1,
      maxTokens: 900,
    },
  },
  {
    metadata: { case: "complete-prompt-drafts-directly" },
    input: {
      prompt:
        "Email team@example.com with subject 'Deploy pipeline is twice as fast' telling them " +
        "the deploy pipeline now runs in half the time, and that details are in the thread.",
      details: null,
      script: {
        assessments: [{ satisfied: true, missing: [], questions: [] }],
        draft: DRAFT,
        tokensPerCall: 150,
      },
    },
    expected: {
      // No `needsMoreInfo`: a complete request must go straight to drafting.
      statePath: ["prompting", "evaluating", "drafting", "reviewing", "sending", "sent", "done"],
      eventTrajectory: ["@xstate.init", "PROMPT_SUBMITTED", "SEND", "END"],
      to: "team@example.com",
      sentCount: 1,
      maxTokens: 600,
    },
  },
  {
    metadata: { case: "user-declines-to-add-details" },
    input: {
      prompt: "Let the team know about the deploy.",
      details: null,
      script: {
        assessments: [
          { satisfied: false, missing: ["recipient"], questions: ["Who should receive it?"] },
        ],
        draft: DRAFT,
        tokensPerCall: 150,
      },
    },
    expected: {
      statePath: [
        "prompting",
        "evaluating",
        "needsMoreInfo",
        "drafting",
        "reviewing",
        "sending",
        "sent",
        "done",
      ],
      eventTrajectory: ["@xstate.init", "PROMPT_SUBMITTED", "DRAFT_ANYWAY", "SEND", "END"],
      // The user never named a recipient, so there is nothing to score here.
      // What matters on this row is the branch: it drafted anyway.
      to: null,
      sentCount: 1,
      maxTokens: 600,
    },
  },
];

// ─── Braintrust wiring ───

/**
 * Live executors, built only when `OPENAI_API_KEY` is set. Imported lazily so
 * the keyless path never loads a provider.
 */
async function liveExecutors(): Promise<Partial<AgentRequestExecutors>> {
  const { createAiSdkExecutors } = await import("@statelyai/agent/ai-sdk");
  return createAiSdkExecutors({ models });
}

export async function main() {
  const live = Boolean(process.env.OPENAI_API_KEY);
  const upload = Boolean(process.env.BRAINTRUST_API_KEY);
  const executors = live ? await liveExecutors() : null;

  console.log(
    `[braintrust-evals] model: ${live ? "real (OPENAI_API_KEY set)" : "scripted (keyless)"} | ` +
      `braintrust: ${upload ? "uploading experiment" : "local summary (noSendLogs)"}`,
  );

  const result = await Eval<DrafterCase, DrafterOutcome, DrafterExpectation, { case: string }>(
    "statelyai-agent email-drafter",
    {
      data: dataset,
      task: (input) => runDrafterCase(input, executors ?? scriptedExecutorsFor(input)),
      scores: scorers.map(
        (scorer) =>
          ({ output, expected }: { output: DrafterOutcome; expected: DrafterExpectation }) =>
            scorer(output, expected),
      ),
    },
    // No Braintrust account: run locally and print a summary instead of
    // creating an experiment.
    { noSendLogs: !upload },
  );

  for (const row of result.results) {
    console.log(
      `  ${row.metadata?.case ?? "?"}: ` +
        Object.entries(row.scores)
          .map(([name, score]) => `${name}=${score}`)
          .join(" ") +
        ` | ${row.output.modelCalls} calls, ${row.output.totalTokens} tokens` +
        ` | ${row.output.statePath.join(" -> ")}`,
    );
  }
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
