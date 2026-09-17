/**
 * Runs the same email requests through email drafter v1 and v2 with the same
 * executors and a rule-based simulated user, then reports what each workflow
 * cost to reach an accepted, sent email.
 *
 * Three views of the same runs, so the numbers can be put back on the graph:
 * - operation: did drafting produce an acceptable draft (accepted on send)?
 * - path: clarification turns, revisions, model calls, edge traversals
 * - outcome: sent, and did the send rule (a real recipient) ever break?
 *
 * The simulated user is deliberately dumb and deterministic: it answers
 * clarification questions with the details it has, accepts a draft when it
 * mentions every required fact, and otherwise asks for the missing one. It
 * never judges tone, so a "worse" draft here means a draft missing facts.
 *
 * Live, from `demo/`: OPENAI_API_KEY=... pnpm exec tsx src/lib/email-drafter-compare.ts
 * Writes demo/results/email-drafter/comparison.json.
 */
import type { AnyStateMachine, SnapshotFrom } from "xstate";
import {
  type AgentRequestExecutors,
  type AgentTraceEvent,
  getAcceptedEvents,
  getStatePath,
  runAgent,
} from "@statelyai/agent";
import { emailDrafterV1Machine } from "@/agents/email-drafter-v1";
import { emailDrafterV2Machine } from "@/agents/email-drafter-v2";
import { hasRecipient } from "@/agents/email-draft";

export type CaseCategory = "complete" | "missing-optional" | "missing-recipient";

export interface EmailCase {
  id: string;
  category: CaseCategory;
  /** What the user types first. */
  prompt: string;
  /** What the user knows and will supply when asked. */
  details: { to: string; subject?: string; facts: string[] };
  /** Substrings (case-insensitive) the body must contain to be accepted. */
  mustInclude: string[];
}

export const cases: EmailCase[] = [
  {
    id: "complete-1",
    category: "complete",
    prompt:
      "Email priya@example.com, subject 'Design review moved', telling her Thursday's design review is now Friday at 10am.",
    details: { to: "priya@example.com", subject: "Design review moved", facts: ["Friday at 10am"] },
    mustInclude: ["Friday", "10"],
  },
  {
    id: "complete-2",
    category: "complete",
    prompt:
      "Write to team@example.com with subject 'API migration done': the API migration finished last night and the old endpoints shut off on Monday.",
    details: {
      to: "team@example.com",
      subject: "API migration done",
      facts: ["migration finished last night", "old endpoints shut off Monday"],
    },
    mustInclude: ["migration", "Monday"],
  },
  {
    id: "complete-3",
    category: "complete",
    prompt:
      "Send sam@example.com a note, subject 'Invoice #4821', saying invoice 4821 was paid today and the receipt is attached.",
    details: {
      to: "sam@example.com",
      subject: "Invoice #4821",
      facts: ["paid today", "receipt attached"],
    },
    mustInclude: ["4821", "receipt"],
  },
  {
    id: "optional-1",
    category: "missing-optional",
    prompt: "Email alex@example.com to invite them for coffee after my talk on Thursday.",
    details: { to: "alex@example.com", facts: ["coffee after the talk on Thursday"] },
    mustInclude: ["coffee", "Thursday"],
  },
  {
    id: "optional-2",
    category: "missing-optional",
    prompt: "Tell jordan@example.com the demo is at 3pm in room B.",
    details: { to: "jordan@example.com", facts: ["demo at 3pm", "room B"] },
    mustInclude: ["3", "room B"],
  },
  {
    id: "optional-3",
    category: "missing-optional",
    prompt: "Let ops@example.com know the deploy is postponed to tomorrow morning.",
    details: { to: "ops@example.com", facts: ["deploy postponed to tomorrow morning"] },
    mustInclude: ["deploy", "tomorrow"],
  },
  {
    id: "recipient-1",
    category: "missing-recipient",
    prompt: "Email Alex to invite them for coffee after my talk on Thursday.",
    details: { to: "alex@example.com", facts: ["coffee after the talk on Thursday"] },
    mustInclude: ["coffee", "Thursday"],
  },
  {
    id: "recipient-2",
    category: "missing-recipient",
    prompt:
      "Write to the finance team: the Q3 numbers are in the shared folder as of this morning.",
    details: { to: "finance@example.com", facts: ["Q3 numbers in the shared folder"] },
    mustInclude: ["Q3", "folder"],
  },
];

export interface RunMetrics {
  caseId: string;
  category: CaseCategory;
  /** Times the workflow paused to ask the user something before it could send. */
  clarificationTurns: number;
  /** Every question the workflow raised, blocking (v1) or alongside the draft (v2). */
  clarifications: string[];
  revisions: number;
  modelCalls: number;
  /** Sum over every model call, or `null` if any call did not report usage. */
  totalTokens: number | null;
  /** The draft mentioned every required fact when the user sent it. */
  acceptedDraft: boolean;
  sent: boolean;
  /** Times `sending` was entered without a valid recipient. Must stay 0. */
  sendRuleViolations: number;
  /** `from --EVENT--> to` traversal counts for this run. */
  edges: Record<string, number>;
  /** Machine path, for reading a single run on a slide. */
  path: string[];
  failure: string | null;
}

export interface MachineSummary {
  machine: string;
  runs: RunMetrics[];
  totals: {
    runs: number;
    clarificationTurns: number;
    /** Questions raised across runs, whether or not they blocked. */
    clarificationsRaised: number;
    revisions: number;
    modelCalls: number;
    totalTokens: number | null;
    accepted: number;
    sent: number;
    sendRuleViolations: number;
  };
  /** Only the categories `selectedCases` covered; a filtered run omits the rest. */
  byCategory: Partial<
    Record<
      CaseCategory,
      {
        runs: number;
        clarificationTurns: number;
        revisions: number;
        modelCalls: number;
        accepted: number;
      }
    >
  >;
  /** Traversal counts summed over every run: the weighted graph. */
  edges: Record<string, number>;
}

const MAX_CLARIFICATIONS = 2;

type Draft = { to: string; subject: string; body: string } | null;

function draftMeetsCase(draft: Draft, emailCase: EmailCase): boolean {
  if (!draft) return false;
  const body = draft.body.toLowerCase();
  return emailCase.mustInclude.every((fact) => body.includes(fact.toLowerCase()));
}

/** What the simulated user says when the workflow asks for more details. */
function clarificationReply(emailCase: EmailCase): string {
  const { to, subject, facts } = emailCase.details;
  return [
    `Recipient: ${to}.`,
    subject ? `Subject: ${subject}.` : "No particular subject, you pick one.",
    `Details: ${facts.join("; ")}.`,
  ].join(" ");
}

/**
 * Drives one machine through one case with a rule-based user. The policy is
 * keyed on state names because this harness owns both machines; hosts should
 * keep reading the idle interaction instead.
 */
export async function runCase(
  machine: AnyStateMachine,
  emailCase: EmailCase,
  executors: Partial<AgentRequestExecutors>,
): Promise<RunMetrics> {
  const metrics: RunMetrics = {
    caseId: emailCase.id,
    category: emailCase.category,
    clarificationTurns: 0,
    clarifications: [],
    revisions: 0,
    modelCalls: 0,
    totalTokens: null,
    acceptedDraft: false,
    sent: false,
    sendRuleViolations: 0,
    edges: {},
    path: [],
    failure: null,
  };

  let previous: string | null = null;
  let tokens = 0;
  let callsWithUsage = 0;
  const onTrace = (event: AgentTraceEvent) => {
    // A call that errors still hit the model, so count starts, not ends.
    if (event.type === "request.start") metrics.modelCalls += 1;
    if (event.type === "request.end") {
      if (event.usage?.totalTokens !== undefined) {
        tokens += event.usage.totalTokens;
        callsWithUsage += 1;
      }
    }
    if (event.type === "machine.transition") {
      const current = getStatePath(event.snapshot);
      if (previous !== null && previous !== current) {
        const key = `${previous} --${event.event.type}--> ${current}`;
        metrics.edges[key] = (metrics.edges[key] ?? 0) + 1;
      }
      if (previous !== current) metrics.path.push(current);
      if (current === "sending") {
        const draft = (event.snapshot as SnapshotFrom<typeof emailDrafterV2Machine>).context.draft;
        if (!hasRecipient(draft)) metrics.sendRuleViolations += 1;
      }
      previous = current;
    }
  };

  let result = await runAgent(machine, { input: { prompt: emailCase.prompt }, executors, onTrace });

  let guard = 0;
  while (result.status === "idle" && guard++ < 30) {
    const snapshot = result.snapshot;
    const state = getStatePath(snapshot);
    const draft = (snapshot as SnapshotFrom<typeof emailDrafterV2Machine>).context.draft;
    const accepted = new Set(getAcceptedEvents(snapshot).map((descriptor) => descriptor.type));

    let event: { type: string; text?: string };
    switch (state) {
      case "needsMoreInfo":
        metrics.clarificationTurns += 1;
        event =
          metrics.clarificationTurns > MAX_CLARIFICATIONS
            ? { type: "DRAFT_ANYWAY" }
            : { type: "MORE_INFO", text: clarificationReply(emailCase) };
        break;
      case "needsRecipient":
        metrics.clarificationTurns += 1;
        event = { type: "RECIPIENT_PROVIDED", text: emailCase.details.to };
        break;
      case "reviewing": {
        if (draftMeetsCase(draft, emailCase)) {
          metrics.acceptedDraft = true;
          event = { type: "SEND" };
        } else {
          metrics.revisions += 1;
          const missing = emailCase.mustInclude.filter(
            (fact) => !draft?.body.toLowerCase().includes(fact.toLowerCase()),
          );
          event = { type: "REQUEST_CHANGES", text: `Please mention: ${missing.join(", ")}.` };
        }
        break;
      }
      case "finalReview":
        metrics.acceptedDraft = draftMeetsCase(draft, emailCase);
        event = { type: "SEND" };
        break;
      default:
        throw new Error(`Simulated user has no policy for state "${state}"`);
    }
    if (!accepted.has(event.type)) {
      throw new Error(`"${event.type}" is not accepted in "${state}" (accepted: ${[...accepted].join(", ")})`);
    }

    result = await runAgent(machine, { snapshot, event: event as never, executors, onTrace });
  }

  // A partial sum would read as a total, so any call without usage voids it.
  metrics.totalTokens =
    metrics.modelCalls > 0 && callsWithUsage === metrics.modelCalls ? tokens : null;
  if (result.status === "done") {
    const output = result.output as {
      sentEmails: unknown[];
      clarifications: string[];
      failure: string | null;
    };
    metrics.failure = output.failure;
    metrics.clarifications = output.clarifications;
    metrics.sent = output.sentEmails.length > 0;
  } else if (result.status === "error") {
    metrics.failure = String(result.error);
  }
  return metrics;
}

export async function runComparison(
  executors: Partial<AgentRequestExecutors>,
  selectedCases: EmailCase[] = cases,
): Promise<MachineSummary[]> {
  const machines = [
    { name: "v1", machine: emailDrafterV1Machine },
    { name: "v2", machine: emailDrafterV2Machine },
  ] as const;

  const summaries: MachineSummary[] = [];
  for (const { name, machine } of machines) {
    const runs: RunMetrics[] = [];
    for (const emailCase of selectedCases) {
      runs.push(await runCase(machine, emailCase, executors));
    }
    summaries.push(summarize(name, runs));
  }
  return summaries;
}

function summarize(machine: string, runs: RunMetrics[]): MachineSummary {
  const edges: Record<string, number> = {};
  const byCategory = {} as MachineSummary["byCategory"];
  const totals: MachineSummary["totals"] = {
    runs: runs.length,
    clarificationTurns: 0,
    clarificationsRaised: 0,
    revisions: 0,
    modelCalls: 0,
    totalTokens: null,
    accepted: 0,
    sent: 0,
    sendRuleViolations: 0,
  };
  for (const run of runs) {
    totals.clarificationTurns += run.clarificationTurns;
    totals.clarificationsRaised += run.clarifications.length;
    totals.revisions += run.revisions;
    totals.modelCalls += run.modelCalls;
    totals.accepted += run.acceptedDraft ? 1 : 0;
    totals.sent += run.sent ? 1 : 0;
    totals.sendRuleViolations += run.sendRuleViolations;
    for (const [edge, count] of Object.entries(run.edges)) edges[edge] = (edges[edge] ?? 0) + count;
    const bucket = (byCategory[run.category] ??= {
      runs: 0,
      clarificationTurns: 0,
      revisions: 0,
      modelCalls: 0,
      accepted: 0,
    });
    bucket.runs += 1;
    bucket.clarificationTurns += run.clarificationTurns;
    bucket.revisions += run.revisions;
    bucket.modelCalls += run.modelCalls;
    bucket.accepted += run.acceptedDraft ? 1 : 0;
  }
  // Same rule as per run: a partial sum must not read as a total.
  totals.totalTokens =
    runs.length > 0 && runs.every((run) => run.totalTokens !== null)
      ? runs.reduce((sum, run) => sum + (run.totalTokens ?? 0), 0)
      : null;
  return { machine, runs, totals, byCategory, edges };
}

/** Markdown table for the terminal and the slide. */
export function renderComparison(summaries: MachineSummary[]): string {
  const lines = [
    "| metric | " + summaries.map((s) => s.machine).join(" | ") + " |",
    "|---|" + summaries.map(() => "---:").join("|") + "|",
  ];
  const row = (label: string, pick: (s: MachineSummary) => string | number) =>
    lines.push(`| ${label} | ${summaries.map((s) => String(pick(s))).join(" | ")} |`);
  row("runs", (s) => s.totals.runs);
  row("clarification turns (blocking)", (s) => s.totals.clarificationTurns);
  row("clarifications raised", (s) => s.totals.clarificationsRaised);
  row("revisions", (s) => s.totals.revisions);
  row("model calls", (s) => s.totals.modelCalls);
  row("total tokens", (s) => s.totals.totalTokens ?? "n/a");
  row("accepted drafts", (s) => `${s.totals.accepted}/${s.totals.runs}`);
  row("sent", (s) => `${s.totals.sent}/${s.totals.runs}`);
  row("send-rule violations", (s) => s.totals.sendRuleViolations);
  lines.push("", "Edge traversals (summed over runs):");
  for (const summary of summaries) {
    lines.push("", `${summary.machine}:`);
    for (const [edge, count] of Object.entries(summary.edges).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${String(count).padStart(3)}  ${edge}`);
    }
  }
  return lines.join("\n");
}

/** The evidence a proposer sees for one machine: totals, categories, edges, per-run paths. */
export function renderEvidence(summary: MachineSummary): string {
  const lines = [`Machine: ${summary.machine}`, "", "Totals:"];
  for (const [key, value] of Object.entries(summary.totals)) lines.push(`- ${key}: ${String(value)}`);
  lines.push("", "By category:");
  for (const [category, bucket] of Object.entries(summary.byCategory)) {
    lines.push(
      `- ${category}: runs=${bucket.runs} clarificationTurns=${bucket.clarificationTurns} revisions=${bucket.revisions} modelCalls=${bucket.modelCalls} accepted=${bucket.accepted}`,
    );
  }
  lines.push("", "Edge traversals (from --EVENT--> to: count):");
  for (const [edge, count] of Object.entries(summary.edges).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${edge}: ${count}`);
  }
  lines.push("", "Per-run paths:");
  for (const run of summary.runs) {
    lines.push(
      `- ${run.caseId} (${run.category}): ${run.path.join(" > ")} | clarificationTurns=${run.clarificationTurns} revisions=${run.revisions} modelCalls=${run.modelCalls} accepted=${run.acceptedDraft}`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const [{ createAiSdkExecutors, defineModels }, { openai }] = await Promise.all([
    import("@statelyai/agent/ai-sdk"),
    import("@ai-sdk/openai"),
  ]);
  const model = process.env.OPENAI_MODEL || "gpt-5.4-mini";
  const executors = createAiSdkExecutors({
    models: defineModels({ fast: openai(model), writer: openai(model) }),
  });
  const summaries = await runComparison(executors);
  console.log(renderComparison(summaries));

  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = new URL("../../results/email-drafter/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const file = new URL("comparison.json", dir);
  await writeFile(
    file,
    JSON.stringify({ generatedAt: new Date().toISOString(), model, summaries }, null, 2),
  );
  console.log(`\nWrote ${file.pathname}`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run the comparison.");
    process.exit(1);
  }
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
