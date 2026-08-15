/**
 * Seam scoring — regression-test ONE model call of a machine agent, with the
 * whole machine running around it.
 *
 * A machine agent is a chain of model calls. Swapping the prompt behind one of
 * them and re-running the whole agent scores everything at once: the run got
 * better or worse, and you cannot say which call moved. `runSeam` addresses one
 * call, scripts every other one, and hands back what that call answered plus
 * the branch it caused.
 *
 * This example reuses the email drafter (`../email-drafter/agent-logic.ts`)
 * unmodified — no test double of the machine, no eval-only copy of the flow:
 *   - The seam is the FIRST `draftEmail` call (`{ request: 'draftEmail' }`):
 *     prompt + clarifications -> draft. The drafter's requests declare no
 *     `name`, so each takes its `actors:` registration key as its name — the
 *     seam and the scripts address requests by that key.
 *   - Every other call (the prompt evaluator, and any revision draft the run
 *     goes on to need) is served from `scripts`, so a candidate comparison
 *     burns one call instead of the whole chain. The run's `calls` ledger is
 *     the receipt: which answers the script served, and which one was the
 *     candidate's.
 *   - A reactive `respond` plays the human at every `awaiting-user` state, and
 *     asks for changes when the draft it is shown misses the point — so a weak
 *     candidate is charged for the extra round trip it caused.
 *   - Three plain scorers (length bound, required-field coverage, tone) grade
 *     the seam's own answer, and `seamUsage` prices the one live call.
 *     Scorers stay yours: no framework, no dependency.
 *
 * Keyless and offline by default: both candidates are scripted functions. Set
 * `OPENAI_API_KEY` to add a third row where the seam is a real model call and
 * everything else stays scripted.
 *
 * Run: npx tsx examples/seam-scoring/index.ts
 */
import type { EventFromLogic } from "xstate";
import { runSeam } from "@statelyai/agent";
import type { AgentRequestExecutor, ScriptedTextEntry, SeamTurn } from "@statelyai/agent";
import { emailDrafter, models } from "../email-drafter/agent-logic.js";

type DrafterEvent = EventFromLogic<typeof emailDrafter>;

/** The seam's declared output shape, from the drafter's own schema. */
export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
}

// ─── The call plan ───

const PROMPT =
  "Email team@example.com with subject 'Deploy pipeline is twice as fast' telling them the " +
  "deploy pipeline now runs in half the time.";

/** The prompt evaluator waves this complete prompt through: no clarification round. */
const COMPLETE_ASSESSMENT = { satisfied: true, missing: [], questions: [] };

/** Consumed and discarded by the seam — the candidate replaces this answer. */
const SEAM_SLOT: EmailDraft = { to: "", subject: "", body: "" };

/** The revision draft, only reached when a candidate's draft gets sent back. */
const REVISION: EmailDraft = {
  to: "team@example.com",
  subject: "Deploy pipeline is twice as fast",
  body:
    "Hi team, the deploy pipeline now runs in half the time. Thanks for the reviews that got " +
    "us there. Details are in the thread.",
};

/**
 * The call plan, keyed by request name — the `actors:` registration key, which
 * an unnamed `createTextLogic` request takes as its `name` at run time. Plain
 * values: the run's own `calls` ledger reports which entries were served, so
 * nothing here needs to record anything.
 *
 * The seam consumes its slot too (the candidate REPLACES that answer rather
 * than skipping it), so the later entries stay lined up with the plan.
 */
const SCRIPTS: Record<string, ScriptedTextEntry[]> = {
  evaluatePrompt: [COMPLETE_ASSESSMENT],
  draftEmail: [SEAM_SLOT, REVISION],
};

// ─── Scorers: plain functions, no dependencies ───

/** One scorer's verdict on the seam's own answer. */
export interface Score {
  name: string;
  score: number;
  note: string;
}

const MIN_WORDS = 12;
const MAX_WORDS = 90;

/** A draft nobody reads is as bad as a draft nobody understands. */
export function scoreLength(draft: EmailDraft | undefined): Score {
  const words = (draft?.body ?? "").trim().split(/\s+/).filter(Boolean).length;
  const ok = words >= MIN_WORDS && words <= MAX_WORDS;
  return { name: "length", score: ok ? 1 : 0, note: `${words} words` };
}

const REQUIRED_TERMS = ["deploy", "pipeline", "half"];

/**
 * Whole-word containment. A substring check would score "Ship it" as a warm
 * greeting because it contains "hi" — the kind of scorer bug that quietly
 * flatters every candidate.
 */
function mentions(text: string, term: string): boolean {
  return /^\w[\w ]*\w$|^\w$/.test(term)
    ? new RegExp(`\\b${term}\\b`).test(text)
    : text.includes(term);
}

/** Addressed, subject-lined, and actually about the thing that was asked for. */
export function scoreCoverage(draft: EmailDraft | undefined): Score {
  const text = `${draft?.subject ?? ""} ${draft?.body ?? ""}`.toLowerCase();
  const addressed = Boolean(draft?.to?.includes("@"));
  const titled = Boolean(draft?.subject?.trim());
  const checks = [addressed, titled, ...REQUIRED_TERMS.map((term) => mentions(text, term))];
  const missing = [
    ...(addressed ? [] : ["recipient"]),
    ...(titled ? [] : ["subject"]),
    ...REQUIRED_TERMS.filter((term) => !mentions(text, term)),
  ];
  return {
    name: "coverage",
    score: checks.filter(Boolean).length / checks.length,
    note: missing.length ? `missing ${missing.join(", ")}` : (draft?.to ?? ""),
  };
}

const WARM_TERMS = ["hi", "hello", "thanks", "thank you", "please"];
const HARSH_TERMS = ["asap", "obviously", "just do", "whatever", "!!"];

/** House tone: greet somebody, do not shout at them. */
export function scoreTone(draft: EmailDraft | undefined): Score {
  const body = (draft?.body ?? "").toLowerCase();
  const warm = WARM_TERMS.some((term) => mentions(body, term));
  const harsh = HARSH_TERMS.some((term) => mentions(body, term));
  const shouting = /\b[A-Z]{4,}\b/.test(draft?.body ?? "");
  const checks = [warm, !harsh, !shouting];
  return {
    name: "tone",
    score: checks.filter(Boolean).length / checks.length,
    note: [warm ? "warm" : "cold", harsh ? "harsh" : null, shouting ? "shouting" : null]
      .filter(Boolean)
      .join(" "),
  };
}

/** The three scorers, in table order. */
export const scorers = [scoreLength, scoreCoverage, scoreTone];

// ─── Candidates: what the seam answers ───

/** A scripted candidate: whatever the seam is asked, it answers this draft. */
const makeCandidate =
  (draft: EmailDraft): AgentRequestExecutor =>
  async () => ({ output: draft });

/** The candidate under test today: on topic, addressed, polite. */
export const GOOD_DRAFT: EmailDraft = {
  to: "team@example.com",
  subject: "Deploy pipeline is twice as fast",
  body:
    "Hi team, the deploy pipeline now runs in half the time. Thanks to everyone who reviewed " +
    "the change. Details are in the thread.",
};

/** The regression: terse, unaddressed, and shouty. */
export const BAD_DRAFT: EmailDraft = {
  to: "",
  subject: "",
  body: "DEPLOY IS FASTER NOW. Ship it, obviously.",
};

// ─── One seam run ───

/** Everything the comparison table needs from one candidate's run. */
export interface SeamRun {
  label: string;
  status: string;
  /** What the seam call answered. */
  draft: EmailDraft | undefined;
  /** Model calls made before the seam. */
  callsBeforeSeam: number;
  /** Which calls the script served, in order. With a candidate at the seam,
   * the seam's slot is consumed but replaced, so it is not listed here. */
  scriptedCalls: string[];
  /** Request names the candidate was actually asked for: exactly one. */
  candidateCalls: string[];
  /** The seam call's own token cost, when its answer reported usage. */
  seamTokens: number | undefined;
  /** States entered from the seam onward — the branch the seam caused. */
  statesAfterSeam: string[];
  scores: Score[];
  total: number;
}

/**
 * The simulated user. It answers off the machine's current state, and reads the
 * draft it is shown: a draft that misses a required term gets sent back once,
 * which is a real consequence of the seam rather than a scripted one.
 */
function respond() {
  const used = { changes: false };
  return ({ snapshot, state }: SeamTurn<typeof emailDrafter>): DrafterEvent | null => {
    switch (state) {
      case "prompting":
        return { type: "PROMPT_SUBMITTED", prompt: PROMPT } as DrafterEvent;
      case "needsMoreInfo":
        return { type: "DRAFT_ANYWAY" } as DrafterEvent;
      case "reviewing": {
        const shown = snapshot.context.draft as EmailDraft | null;
        if (!used.changes && scoreCoverage(shown ?? undefined).score < 1) {
          used.changes = true;
          return {
            type: "REQUEST_CHANGES",
            changes: "Address it to team@example.com and keep the tone friendly.",
          } as DrafterEvent;
        }
        return { type: "SEND" } as DrafterEvent;
      }
      case "sent":
        return { type: "END" } as DrafterEvent;
      default:
        return null;
    }
  };
}

/** Runs the machine end to end with `candidate` at the seam, and scores it. */
export async function runCandidate(
  label: string,
  candidate: AgentRequestExecutor,
): Promise<SeamRun> {
  const run = await runSeam(emailDrafter, {
    scripts: SCRIPTS,
    // The first `draftEmail` call: prompt + clarifications -> draft. The
    // request's `name` is its `actors:` key, so no model-key addressing.
    seam: { request: "draftEmail" },
    candidate,
    respond: respond(),
  });

  const draft = run.seamOutput as EmailDraft | undefined;
  const scores = scorers.map((scorer) => scorer(draft));

  return {
    label,
    status: run.result.status,
    draft,
    callsBeforeSeam: run.callsBeforeSeam,
    // The ledger is the receipt: everything else stayed scripted.
    scriptedCalls: run.calls
      .filter((call) => call.source === "script")
      .map((call) => (call.seam ? `${call.key} (seam)` : call.key)),
    candidateCalls: run.calls
      .filter((call) => call.source === "candidate")
      .map((call) => call.name ?? call.model),
    seamTokens: run.seamUsage?.totalTokens,
    statesAfterSeam: run.after.statePath.map(String),
    scores,
    total: scores.reduce((sum, entry) => sum + entry.score, 0) / scores.length,
  };
}

/** The scripted candidates, always available and always keyless. */
export function scriptedCandidates(): Array<{
  label: string;
  candidate: AgentRequestExecutor;
}> {
  return [
    { label: "good", candidate: makeCandidate(GOOD_DRAFT) },
    { label: "bad", candidate: makeCandidate(BAD_DRAFT) },
  ];
}

// ─── Reporting ───

const pad = (value: string, width: number) => value.padEnd(width);

/** The comparison table: one row per candidate, one column per scorer. */
export function renderTable(runs: SeamRun[]): string {
  const names = scorers.map((_, index) => runs[0]?.scores[index]?.name ?? "?");
  const header = ["candidate", ...names, "mean", "states after seam"];
  const rows = runs.map((run) => [
    run.label,
    ...run.scores.map((score) => score.score.toFixed(2)),
    run.total.toFixed(2),
    run.statesAfterSeam.join(" -> "),
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]!.length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => pad(cell, widths[index]!))
      .join("  ")
      .trimEnd();

  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}

async function liveCandidate(): Promise<AgentRequestExecutor> {
  const { createAiSdkExecutors } = await import("@statelyai/agent/ai-sdk");
  return createAiSdkExecutors({ models }).generateText;
}

export async function main() {
  const live = Boolean(process.env.OPENAI_API_KEY);
  const candidates = scriptedCandidates();
  if (live) {
    candidates.push({ label: "live", candidate: await liveCandidate() });
  }

  console.log(
    "[seam-scoring] seam: draftEmail call #0 (prompt + clarifications -> draft) | " +
      `candidates: ${candidates.map((entry) => entry.label).join(", ")}` +
      (live ? "" : " (keyless: set OPENAI_API_KEY to add a real-model row)"),
  );

  const runs: SeamRun[] = [];
  for (const { label, candidate } of candidates) {
    runs.push(await runCandidate(label, candidate));
  }

  console.log(`\n${renderTable(runs)}\n`);

  for (const run of runs) {
    console.log(
      `${run.label}: ${run.status} | ${run.candidateCalls.length} candidate call, ` +
        `${run.scriptedCalls.length} scripted (${run.scriptedCalls.join(", ")})` +
        (run.seamTokens !== undefined ? ` | seam cost: ${run.seamTokens} tokens` : ""),
    );
    for (const score of run.scores) {
      console.log(`  ${pad(score.name, 9)} ${score.score.toFixed(2)}  ${score.note}`);
    }
  }
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
