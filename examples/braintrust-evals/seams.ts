/**
 * Seam evals: score ONE transition of the email drafter in isolation, while
 * still running the whole machine end to end.
 *
 * A machine agent is a chain of model calls. Scoring only the final output
 * tells you a run got worse; it does not tell you which call got worse. A seam
 * eval fixes that without mocks: run the real machine, route every model call
 * except one to a scripted answer, and let the seam under test hit the real
 * model (or a candidate prompt). Everything after the seam is a real
 * consequence of it — the branch it took, the states it reached, the events the
 * user then sent — so the slice of the run after the seam is the score.
 *
 * `runSeam` from the library owns all of that: the routing, the reactive
 * simulated user, and the slicing. What stays here is the vendor's business —
 * the datasets, the scorers, and the `Eval()` wiring.
 *
 * The drafter has three seams:
 * - `clarify` — prompt → assessment (`evaluatePrompt`). Does it notice a
 *   missing recipient, i.e. does the machine go to `needsMoreInfo`?
 * - `draft` — prompt + clarifications → draft (`draftEmail`, first call).
 * - `revise` — draft + revision request → new draft (`draftEmail`, second call).
 *
 * Each is its own `Eval()`/experiment, so a vendor tracks per-seam scores over
 * time instead of one blended number.
 *
 * Run: npx tsx examples/braintrust-evals/seams.ts
 */
import { Eval } from "braintrust";
import type { EventFromLogic } from "xstate";
import { matchesTrajectory, runSeam } from "@statelyai/agent";
import type {
  AgentRequestExecutors,
  ScriptedTextEntry,
  SeamRef,
  SeamTurn,
  TrajectoryMatch,
} from "@statelyai/agent";
import { emailDrafter, models } from "../email-drafter/agent-logic.js";

type DrafterEvent = EventFromLogic<typeof emailDrafter>;

interface EmailDraft {
  to: string;
  subject: string;
  body: string;
}

interface Assessment {
  satisfied: boolean;
  missing: string[];
  questions: string[];
}

const WAITING_STATES = new Set(["prompting", "needsMoreInfo", "reviewing", "sent"]);

// ─── The driver ───

/** How the simulated user behaves for one row. */
export interface SeamCaseInput {
  prompt: string;
  /** Answer at `needsMoreInfo`; `null` picks "draft anyway". */
  details: string | null;
  /** Revision request at `reviewing`, used once; `null` sends immediately. */
  changes: string | null;
  /** The call plan: canned answers per model key, in call order. */
  scripts: Record<string, ScriptedTextEntry[]>;
  seam: SeamRef;
}

/** Everything a seam scorer needs: the seam's own answer, plus the run it caused. */
export interface SeamOutcome {
  status: "done" | "idle" | "error";
  /** What the seam call returned. */
  seamOutput: unknown;
  /** State values entered from the seam onward. */
  seamStatePath: unknown[];
  /** Event types from the seam's completion onward. */
  seamEvents: string[];
  /** The whole run, for context in the eval UI. */
  statePath: unknown[];
  sentEmails: EmailDraft[];
}

/**
 * The reactive simulated user: answers off the machine's current state, not a
 * fixed transcript, so a live seam that branches differently is scored rather
 * than crashing the run.
 */
function respondFor(input: SeamCaseInput) {
  const used = { details: false, changes: false };
  return ({ state }: SeamTurn<typeof emailDrafter>): DrafterEvent | null => {
    switch (state) {
      case "prompting":
        return { type: "PROMPT_SUBMITTED", prompt: input.prompt } as DrafterEvent;
      case "needsMoreInfo":
        if (input.details !== null && !used.details) {
          used.details = true;
          return { type: "MORE_INFO", details: input.details } as DrafterEvent;
        }
        return { type: "DRAFT_ANYWAY" } as DrafterEvent;
      case "reviewing":
        if (input.changes !== null && !used.changes) {
          used.changes = true;
          return { type: "REQUEST_CHANGES", changes: input.changes } as DrafterEvent;
        }
        return { type: "SEND" } as DrafterEvent;
      case "sent":
        return { type: "END" } as DrafterEvent;
      default:
        return null;
    }
  };
}

/** Runs one row through `runSeam` and flattens it into JSON an eval row can carry. */
export async function runSeamCase(
  input: SeamCaseInput,
  candidate: AgentRequestExecutors["generateText"] | null,
): Promise<SeamOutcome> {
  const run = await runSeam(emailDrafter, {
    scripts: input.scripts,
    seam: input.seam,
    ...(candidate ? { candidate } : {}),
    respond: respondFor(input),
    isSuspended: (snapshot) =>
      typeof snapshot.value === "string" && WAITING_STATES.has(snapshot.value),
  });

  return {
    status: run.result.status,
    seamOutput: run.seamOutput,
    seamStatePath: run.after.statePath,
    seamEvents: run.after.events.map((entry) => entry.event.type),
    statePath: [...run.before.statePath, ...run.after.statePath],
    sentEmails: run.result.status === "done" ? run.result.output.sentEmails : [],
  };
}

// ─── Scorers ───

interface Score {
  name: string;
  score: number;
  metadata: Record<string, unknown>;
}

/** What the run must look like after the seam. */
export interface SeamExpectation {
  /** States the machine must enter after the seam, in order (gaps allowed). */
  statePath: string[];
  /** Event types the log must carry after the seam, in order (gaps allowed). */
  events: string[];
  /** Substrings the seam's own answer must contain, lowercased. */
  mentions?: string[];
  /** For the `clarify` seam: whether the prompt should have been judged complete. */
  satisfied?: boolean;
  /** For draft seams: the recipient the draft must be addressed to. */
  to?: string;
}

const detail = (match: TrajectoryMatch): Record<string, unknown> => ({
  matched: `${match.matchedCount}/${match.expectedCount}`,
  ...(match.firstMiss ? { firstMiss: match.firstMiss } : {}),
});

/** The branch the seam caused, scored as an ordered subsequence of states. */
export function scoreSeamStatePath(output: SeamOutcome, expected: SeamExpectation): Score {
  const match = matchesTrajectory(output.seamStatePath, expected.statePath);
  return {
    name: "seam_state_path",
    score: match.score,
    metadata: { path: output.seamStatePath.join(" -> "), ...detail(match) },
  };
}

/** The same question against the durable log: which events followed the seam. */
export function scoreSeamEvents(output: SeamOutcome, expected: SeamExpectation): Score {
  const match = matchesTrajectory(output.seamEvents, expected.events);
  return {
    name: "seam_events",
    score: match.score,
    metadata: { events: output.seamEvents.join(", "), ...detail(match) },
  };
}

/** The seam's own answer: did `evaluatePrompt` judge the prompt correctly? */
export function scoreAssessment(output: SeamOutcome, expected: SeamExpectation): Score {
  const assessment = output.seamOutput as Assessment | undefined;
  const text = JSON.stringify(assessment ?? {}).toLowerCase();
  const checks = [
    typeof assessment?.satisfied === "boolean",
    assessment?.satisfied === expected.satisfied,
    (expected.mentions ?? []).every((term) => text.includes(term)),
    assessment?.satisfied === true || (assessment?.questions.length ?? 0) > 0,
  ];
  return {
    name: "assessment",
    score: checks.filter(Boolean).length / checks.length,
    metadata: { satisfied: assessment?.satisfied, missing: assessment?.missing },
  };
}

/** The seam's own answer: is the draft well-formed, addressed, and on topic? */
export function scoreDraft(output: SeamOutcome, expected: SeamExpectation): Score {
  const draft = output.seamOutput as EmailDraft | undefined;
  const text = `${draft?.subject ?? ""}\n${draft?.body ?? ""}`.toLowerCase();
  const checks = [
    Boolean(draft?.subject?.trim()) && Boolean(draft?.body?.trim()),
    expected.to === undefined || Boolean(draft?.to?.includes(expected.to)),
    (expected.mentions ?? []).every((term) => text.includes(term)),
  ];
  return {
    name: "draft_quality",
    score: checks.filter(Boolean).length / checks.length,
    metadata: { to: draft?.to, subject: draft?.subject },
  };
}

// ─── Datasets, one per seam ───

export interface SeamRow {
  input: SeamCaseInput;
  expected: SeamExpectation;
  metadata: { case: string };
}

const VAGUE_ASSESSMENT: Assessment = {
  satisfied: false,
  missing: ["recipient"],
  questions: ["Who should receive it?"],
};
const COMPLETE_ASSESSMENT: Assessment = { satisfied: true, missing: [], questions: [] };
const DRAFT: EmailDraft = {
  to: "team@example.com",
  subject: "Deploy pipeline is twice as fast",
  body: "Hi team, the deploy pipeline now runs in half the time. Details in the thread.",
};
const REVISED_DRAFT: EmailDraft = {
  ...DRAFT,
  body: "Hi team, the deploy pipeline now runs in half the time. We ship the change on Friday.",
};

const COMPLETE_PROMPT =
  "Email team@example.com with subject 'Deploy pipeline is twice as fast' telling them the " +
  "deploy pipeline now runs in half the time, and that details are in the thread.";

/** Seam 1: prompt → clarifications. The seam is the only `promptEvaluator` call. */
export const clarifySeam: SeamRow[] = [
  {
    metadata: { case: "vague-prompt-must-ask" },
    input: {
      prompt: "Tell them the deploy pipeline is twice as fast now.",
      details: "Send it to team@example.com.",
      changes: null,
      scripts: {
        promptEvaluator: [VAGUE_ASSESSMENT, COMPLETE_ASSESSMENT],
        emailDrafter: [DRAFT],
      },
      seam: { model: "promptEvaluator", occurrence: 0 },
    },
    expected: {
      // A prompt with no recipient must send the machine to `needsMoreInfo`.
      statePath: ["needsMoreInfo", "evaluating", "drafting", "reviewing"],
      events: ["MORE_INFO", "SEND", "END"],
      satisfied: false,
      mentions: ["recipient"],
    },
  },
  {
    metadata: { case: "complete-prompt-must-not-ask" },
    input: {
      prompt: COMPLETE_PROMPT,
      details: null,
      changes: null,
      scripts: {
        promptEvaluator: [COMPLETE_ASSESSMENT],
        emailDrafter: [DRAFT],
      },
      seam: { model: "promptEvaluator", occurrence: 0 },
    },
    expected: {
      // Straight to drafting: no clarification round.
      statePath: ["drafting", "reviewing", "sending", "sent"],
      events: ["SEND", "END"],
      satisfied: true,
    },
  },
];

/** Seam 2: prompt + clarifications → draft. The seam is the first `emailDrafter` call. */
export const draftSeam: SeamRow[] = [
  {
    metadata: { case: "drafts-from-a-complete-prompt" },
    input: {
      prompt: COMPLETE_PROMPT,
      details: null,
      changes: null,
      scripts: {
        promptEvaluator: [COMPLETE_ASSESSMENT],
        emailDrafter: [DRAFT],
      },
      seam: { model: "emailDrafter", occurrence: 0 },
    },
    expected: {
      statePath: ["reviewing", "sending", "sent"],
      events: ["SEND", "END"],
      to: "team@example.com",
      mentions: ["deploy"],
    },
  },
  {
    metadata: { case: "drafts-after-a-clarification-round" },
    input: {
      prompt: "Tell them the deploy pipeline is twice as fast now.",
      details: "Send it to team@example.com.",
      changes: null,
      scripts: {
        promptEvaluator: [VAGUE_ASSESSMENT, COMPLETE_ASSESSMENT],
        emailDrafter: [DRAFT],
      },
      seam: { model: "emailDrafter", occurrence: 0 },
    },
    expected: {
      statePath: ["reviewing", "sending", "sent"],
      events: ["SEND", "END"],
      to: "team@example.com",
      mentions: ["deploy"],
    },
  },
];

/** Seam 3: draft + revisions → new draft. The seam is the SECOND `emailDrafter` call. */
export const reviseSeam: SeamRow[] = [
  {
    metadata: { case: "applies-the-requested-change" },
    input: {
      prompt: COMPLETE_PROMPT,
      details: null,
      changes: "Add that we ship the change on Friday.",
      scripts: {
        promptEvaluator: [COMPLETE_ASSESSMENT],
        emailDrafter: [DRAFT, REVISED_DRAFT],
      },
      seam: { model: "emailDrafter", occurrence: 1 },
    },
    expected: {
      statePath: ["reviewing", "sending", "sent"],
      events: ["SEND", "END"],
      to: "team@example.com",
      mentions: ["friday"],
    },
  },
];

/** The three seams, each with its own dataset, scorers, and experiment name. */
export const seams = [
  {
    id: "clarify",
    title: "prompt -> clarifications",
    rows: clarifySeam,
    scorers: [scoreSeamStatePath, scoreSeamEvents, scoreAssessment],
  },
  {
    id: "draft",
    title: "prompt + clarifications -> draft",
    rows: draftSeam,
    scorers: [scoreSeamStatePath, scoreSeamEvents, scoreDraft],
  },
  {
    id: "revise",
    title: "draft + revisions -> new draft",
    rows: reviseSeam,
    scorers: [scoreSeamStatePath, scoreSeamEvents, scoreDraft],
  },
] as const;

// ─── Braintrust wiring: one experiment per seam ───

async function liveGenerateText(): Promise<AgentRequestExecutors["generateText"]> {
  const { createAiSdkExecutors } = await import("@statelyai/agent/ai-sdk");
  return createAiSdkExecutors({ models }).generateText;
}

export async function main() {
  const live = Boolean(process.env.OPENAI_API_KEY);
  const upload = Boolean(process.env.BRAINTRUST_API_KEY);
  const candidate = live ? await liveGenerateText() : null;

  console.log(
    `[seam-evals] seam model: ${live ? "real (OPENAI_API_KEY set)" : "scripted (keyless)"} | ` +
      `braintrust: ${upload ? "uploading experiments" : "local summaries (noSendLogs)"}`,
  );

  for (const seam of seams) {
    const result = await Eval<SeamCaseInput, SeamOutcome, SeamExpectation, { case: string }>(
      `statelyai-agent email-drafter seam: ${seam.id}`,
      {
        data: seam.rows as unknown as SeamRow[],
        task: (input) => runSeamCase(input, candidate),
        scores: seam.scorers.map(
          (scorer) =>
            ({ output, expected }: { output: SeamOutcome; expected: SeamExpectation }) =>
              scorer(output, expected),
        ),
      },
      { noSendLogs: !upload },
    );

    console.log(`  ${seam.id} (${seam.title}):`);
    for (const row of result.results) {
      console.log(
        `    ${row.metadata?.case ?? "?"}: ` +
          Object.entries(row.scores)
            .map(([name, score]) => `${name}=${score}`)
            .join(" ") +
          ` | ${row.output.seamStatePath.join(" -> ")}`,
      );
    }
  }
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
