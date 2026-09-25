/**
 * Scenario runner — the real host layer around `runAgent`.
 *
 * This is the "TanStack Start host" pattern (examples/tanstack-start-host) for
 * real: each scenario is a `setupAgent` machine that `runAgent` drives to a
 * settled result. The host stays stateless — an idle run returns a persisted
 * snapshot the client sends back to resume.
 *
 * Runs need a real model and Jev: `createAiSdkExecutors` with `OPENAI_API_KEY`
 * for text requests and decisions, and `TYPESAFE_API_KEY` for the System One
 * judgments (routing, reflection's scoring, the free-text review). Tests import
 * the `*Run` functions directly and inject their own executors and a
 * `TypeSafeClient` over a fake `fetch`.
 */
import { runAgent, type AgentRequestExecutors, type RunAgentResult } from "@statelyai/agent";
import { createSystemOneLogic } from "@statelyai/agent/typesafe";
import { choice, type TypeSafeClient } from "@typesafe-ai/sdk";
import {
  createActor,
  toPromise,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type Snapshot,
} from "xstate";
import { maybeCreateRunInspection } from "./inspection.server";
import {
  createTraceRecorder,
  describeIdle,
  missingApiKeys,
  type TraceEntry,
} from "./machine-chat.server";
import { missingKeyMessage, type ChatIdle } from "./machine-ui";
import { refundMachine } from "@/agents/refund";
import { approvalMachine } from "@/agents/approval";
import { createClassifyIntent, routingMachine } from "@/agents/routing";
import { researchMachine } from "@/agents/research";
import { pipelineMachine } from "@/agents/pipeline";
import { retryMachine } from "@/agents/retry";
import { toolsMachine } from "@/agents/tools";
import { createEvaluate, reflectionMachine } from "@/agents/reflection";
import { createEvaluatePrompt, emailDrafterV1Machine } from "@/agents/email-drafter-v1";
import { emailDrafterV2Machine } from "@/agents/email-drafter-v2";
import { scenarioSource, type ScenarioId } from "./scenarios";

/** JSON-safe value — server fns must return serializable data (TanStack validates it). */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type { TraceEntry };

export type IdlePayload = ChatIdle & {
  /** JSON-serializable persisted snapshot; the client sends it back to resume. */
  snapshot: Json;
};

export type ScenarioResult = {
  model?: string;
  status: "done" | "idle" | "error";
  trace: TraceEntry[];
  response: string;
  idle?: IdlePayload;
  output?: Json;
  /**
   * Set when the resumed state had no transition for the delivered event.
   * `runAgent` ignores it (see docs/persistence.md) — the run settles
   * unchanged, and the UI says nothing happened.
   */
  ignored?: { type: string };
};

export type ResumeEvent =
  | { type: string; [key: string]: unknown }
  | { kind: "interpret"; text: string };

/** The index signature on the typed-event variant defeats `in` narrowing, so guard explicitly. */
function isInterpretEvent(event: ResumeEvent): event is { kind: "interpret"; text: string } {
  return "kind" in event && (event as { kind?: unknown }).kind === "interpret";
}

const machines: Record<ScenarioId, AnyStateMachine> = {
  refund: refundMachine,
  approval: approvalMachine,
  routing: routingMachine,
  research: researchMachine,
  pipeline: pipelineMachine,
  retry: retryMachine,
  tools: toolsMachine,
  reflection: reflectionMachine,
  "email-drafter-v1": emailDrafterV1Machine,
  "email-drafter-v2": emailDrafterV2Machine,
};

export function machineFor(scenarioId: ScenarioId): AnyStateMachine {
  return machines[scenarioId];
}

/** Builds each machine's `input` from the single prompt string. */
function inputFor(scenarioId: ScenarioId, prompt: string): Record<string, string> {
  switch (scenarioId) {
    case "refund":
      return { request: prompt };
    case "approval":
    case "research":
    case "reflection":
      return { topic: prompt };
    case "routing":
      return { query: prompt };
    case "pipeline":
      return { task: prompt };
    case "retry":
      return { ticket: prompt };
    case "tools":
      return { question: prompt };
    case "email-drafter-v1":
    case "email-drafter-v2":
      return { prompt };
  }
}

// ─── executor resolution ───

/** Resolves AI SDK executors for a scenario, plus the model label. Throws without a key. */
async function resolveExecutors(
  scenarioId: ScenarioId,
): Promise<{ model: string; executors: Partial<AgentRequestExecutors> }> {
  const missing = missingApiKeys();
  if (missing.length) throw new Error(missingKeyMessage(missing));
  // Lazy import: keeps @ai-sdk/openai out of the client bundle.
  const [{ createAiSdkExecutors }, { openai }] = await Promise.all([
    import("@statelyai/agent/ai-sdk"),
    import("@ai-sdk/openai"),
  ]);
  const primary = process.env.OPENAI_MODEL || "gpt-5.4-mini";
  const fallback = process.env.OPENAI_FALLBACK_MODEL || primary;
  const models = {
    fast: openai(primary),
    writer: openai(primary),
    analyst: openai(primary),
    planner: openai(primary),
    critic: openai(primary),
    reasoner: openai(primary),
    primary: openai(primary),
    fallback: openai(fallback),
  };
  const executors = createAiSdkExecutors({ models });
  // Deterministic outage demo for the retry scenario: a healthy primary never
  // fails live, so the advertised retry path would never show. Two markers, two
  // shapes of recovery:
  //   `[primary-outage]`      — the FIRST primary attempt throws, the retry
  //                             succeeds on the primary model.
  //   `[primary-outage-hard]` — EVERY primary attempt throws, so the retry
  //                             budget is spent and the fallback model answers.
  // The counter is per-run: `resolveExecutors` is called once per start/resume.
  if (scenarioId === "retry") {
    const inner = executors.generateText;
    if (inner) {
      let primaryAttempts = 0;
      executors.generateText = (request, ...rest) => {
        if (request.model === "primary") {
          const prompt = request.prompt ?? "";
          primaryAttempts += 1;
          const hard = prompt.includes("[primary-outage-hard]");
          const soft = prompt.includes("[primary-outage]");
          if (hard || (soft && primaryAttempts === 1)) {
            throw new Error("Simulated primary model outage");
          }
        }
        return inner(request, ...rest);
      };
    }
  }
  return { model: primary, executors };
}

/**
 * The scenario's Jev actors bound to an injected client. Without one, each
 * machine's registered default builds its client from `TYPESAFE_API_KEY`.
 */
function jevActors(
  scenarioId: ScenarioId,
  jevClient: TypeSafeClient | undefined,
): { actors?: Record<string, AnyActorLogic> } {
  if (!jevClient) return {};
  if (scenarioId === "routing")
    return { actors: { classifyIntent: createClassifyIntent(jevClient) } };
  if (scenarioId === "reflection") return { actors: { evaluate: createEvaluate(jevClient) } };
  if (scenarioId === "email-drafter-v1")
    return { actors: { evaluatePrompt: createEvaluatePrompt(jevClient) } };
  return {};
}

// ─── result shaping ───

function describeResult(scenarioId: ScenarioId, result: RunAgentResult<AnyStateMachine>): string {
  if (result.ignored) {
    return `"${result.ignored.type}" isn't an accepted event in this state, so nothing happened.`;
  }
  if (result.status === "done") {
    const output = result.output as Record<string, unknown>;
    switch (scenarioId) {
      case "refund": {
        const amount = output.amount == null ? "" : ` ($${Number(output.amount).toFixed(2)})`;
        return `Outcome: ${output.outcome}${amount}.`;
      }
      case "approval":
        return output.published ? `Published:\n${output.draft}` : `Not published:\n${output.draft}`;
      case "routing":
        return `Routed to the ${output.queue} queue: ${output.reason ?? "no reason given"}`;
      case "research":
        return String(output.synthesis || "Synthesis complete.");
      case "pipeline":
        return output.failedAt
          ? `Failed at ${output.failedAt}.`
          : `${output.draft}\n\nVerification: ${output.verification}`;
      case "retry":
        return output.category
          ? `${output.category}\n\n${output.outcome} (${output.attempts} retr${output.attempts === 1 ? "y" : "ies"})`
          : String(output.outcome || "All model attempts failed.");
      case "tools":
        return `${output.answer} (in ${output.steps} tool step${output.steps === 1 ? "" : "s"})`;
      case "reflection":
        return `**First draft**\n\n${output.firstDraft}\n\n**Final draft**\n\n${output.draft}\n\n${output.verdict}`;
      case "email-drafter-v1":
      case "email-drafter-v2":
        return describeEmailOutcome(output);
    }
  }
  if (result.status === "idle") {
    const context = result.snapshot.context as Record<string, unknown>;
    if (scenarioId === "approval") return String(context.draft ?? "Draft ready for review.");
    if (scenarioId === "refund") {
      return result.snapshot.value === "askingAmount"
        ? "No amount in the request. Asking the customer how much was charged."
        : "Amount exceeds the auto-refund limit. Awaiting approval.";
    }
    if (scenarioId === "email-drafter-v1" || scenarioId === "email-drafter-v2") {
      const draft = context.draft as { to: string; subject: string; body: string } | null;
      return draft
        ? formatDraft(draft, context.clarifications as string[] | undefined)
        : "Waiting for input.";
    }
    return "Waiting for input.";
  }
  return "The run ended with an error.";
}

function formatDraft(
  draft: { to: string; subject: string; body: string },
  clarifications: string[] = [],
): string {
  const text = `**To:** ${draft.to || "(no recipient yet)"}\n**Subject:** ${draft.subject || "(no subject yet)"}\n\n${draft.body}`;
  if (!clarifications.length) return text;
  return `${text}\n\n**Open questions**\n${clarifications.map((question) => `- ${question}`).join("\n")}`;
}

function describeEmailOutcome(output: Record<string, unknown>): string {
  if (output.failure) return `Not sent: ${String(output.failure)}`;
  const sent =
    (output.sentEmails as { to: string; subject: string; body: string }[] | undefined) ?? [];
  // Open questions belong with a draft the human can still act on. Once the
  // email is out, listing what it drafted around only reads as regret.
  return sent.length ? `Sent (simulated outbox).\n\n${formatDraft(sent[0]!)}` : "Nothing was sent.";
}

function toResult(
  scenarioId: ScenarioId,
  model: string | undefined,
  result: RunAgentResult<AnyStateMachine>,
  trace: TraceEntry[],
): ScenarioResult {
  const base: ScenarioResult = {
    model,
    status: result.status === "done" ? "done" : result.status === "idle" ? "idle" : "error",
    trace,
    response: describeResult(scenarioId, result),
  };
  if (result.ignored) base.ignored = { type: result.ignored.type };
  if (result.status === "done") base.output = result.output as Json;
  if (result.status === "idle") {
    base.idle = {
      ...describeIdle(machineFor(scenarioId), result.snapshot),
      snapshot: result.persist() as unknown as Json,
    };
  }
  return base;
}

// ─── start / resume ───

/** Runs a scenario from a prompt with the given executors. Pure — used by tests. */
export async function startScenarioRun(
  scenarioId: ScenarioId,
  prompt: string,
  model: string | undefined,
  executors: Partial<AgentRequestExecutors>,
  signal?: AbortSignal,
  jevClient?: TypeSafeClient,
): Promise<ScenarioResult> {
  const { trace, onTransition, onEmitted, onTrace } = createTraceRecorder();
  const machine = machineFor(scenarioId);
  const result = await runAgent(machine, {
    input: inputFor(scenarioId, prompt),
    executors,
    ...jevActors(scenarioId, jevClient),
    ...(signal ? { signal } : {}),
    onTransition,
    on: { "*": onEmitted },
    onTrace,
    inspect: maybeCreateRunInspection(machine, scenarioSource[scenarioId], "start"),
  });
  return toResult(scenarioId, model, result as RunAgentResult<AnyStateMachine>, trace);
}

/** Resumes a persisted idle snapshot with a typed event. Pure — used by tests. */
export async function resumeScenarioRun(
  scenarioId: ScenarioId,
  snapshot: Snapshot<unknown>,
  event: { type: string; [key: string]: unknown },
  model: string | undefined,
  executors: Partial<AgentRequestExecutors>,
  signal?: AbortSignal,
  jevClient?: TypeSafeClient,
): Promise<ScenarioResult> {
  const { trace, onTransition, onEmitted, onTrace } = createTraceRecorder();
  const machine = machineFor(scenarioId);
  // An event the restored state has no transition for is ignored, not an
  // error: the run settles unchanged and reports `result.ignored`.
  const result = await runAgent(machine, {
    snapshot,
    event,
    executors,
    ...jevActors(scenarioId, jevClient),
    ...(signal ? { signal } : {}),
    onTransition,
    on: { "*": onEmitted },
    onTrace,
    inspect: maybeCreateRunInspection(machine, scenarioSource[scenarioId], "resume"),
  });
  return toResult(scenarioId, model, result as RunAgentResult<AnyStateMachine>, trace);
}

// ─── env-resolving wrappers (used by the server functions) ───

export async function startScenario(
  scenarioId: ScenarioId,
  prompt: string,
  signal?: AbortSignal,
): Promise<ScenarioResult> {
  const { model, executors } = await resolveExecutors(scenarioId);
  return startScenarioRun(scenarioId, prompt, model, executors, signal);
}

export async function resumeScenario(
  scenarioId: ScenarioId,
  snapshot: Snapshot<unknown>,
  event: ResumeEvent,
  signal?: AbortSignal,
  /** Injected by tests; omitted, Jev's client reads `TYPESAFE_API_KEY`. */
  jevClient?: TypeSafeClient,
): Promise<ScenarioResult> {
  const { model, executors } = await resolveExecutors(scenarioId);

  // Free-text review ("looks good") → map to a typed event before delivering.
  if (isInterpretEvent(event)) {
    const verdict = await interpretReview(event.text, jevClient);
    if (verdict === "UNCLEAR") {
      // Re-settle idle without delivering an event: still awaiting a clear verdict.
      return startResumeIdleEcho(scenarioId, snapshot, model);
    }
    const typed =
      verdict === "REJECT" ? { type: "REJECT", reason: event.text } : { type: "APPROVE" };
    return resumeScenarioRun(scenarioId, snapshot, typed, model, executors, signal, jevClient);
  }

  return resumeScenarioRun(scenarioId, snapshot, event, model, executors, signal, jevClient);
}

/** Below this confidence, a review reads as unclear and the run asks again. */
export const REVIEW_CONFIDENCE = 0.6;

/**
 * Reading a review as approve / reject is a typed judgment over the person's
 * words, so it is one Jev `choice`, not a text generation to parse.
 */
export function createInterpretReview(client?: TypeSafeClient) {
  return createSystemOneLogic({
    client,
    state: (input: { review: string }) => ({ review: input.review }),
    questions: () => ({
      verdict: choice("What does `review`, a person's reply to a draft, decide?", {
        approve: "Accepts the draft as it is.",
        reject: "Asks for changes or criticizes the draft. Negative feedback counts as reject.",
        unclear: "Neither accepts the draft nor asks for changes.",
      }),
    }),
  });
}

/** Interprets a free-text review as a typed verdict; a failed or unsure call reads as UNCLEAR. */
async function interpretReview(
  text: string,
  jevClient?: TypeSafeClient,
): Promise<"APPROVE" | "REJECT" | "UNCLEAR"> {
  try {
    const actor = createActor(createInterpretReview(jevClient), { input: { review: text } });
    actor.start();
    const { verdict } = (await toPromise(actor)).answers;
    if (verdict.confidence < REVIEW_CONFIDENCE) return "UNCLEAR";
    return verdict.choice === "approve"
      ? "APPROVE"
      : verdict.choice === "reject"
        ? "REJECT"
        : "UNCLEAR";
  } catch {
    return "UNCLEAR";
  }
}

/** Returns the still-idle snapshot unchanged (UNCLEAR interpretation). */
function startResumeIdleEcho(
  scenarioId: ScenarioId,
  snapshot: Snapshot<unknown>,
  model: string | undefined,
): ScenarioResult {
  const machine = machineFor(scenarioId);
  // Describe the RESTORED snapshot, so the echoed idle carries the same event
  // schemas (REJECT's required `reason`), labels, and hints as the original.
  const restored = machine.resolveState(
    snapshot as never as Parameters<AnyStateMachine["resolveState"]>[0],
  );
  return {
    model,
    status: "idle",
    trace: [],
    response: "Could not confidently interpret that review. Approve or reject explicitly.",
    idle: {
      ...describeIdle(machine, restored as AnyMachineSnapshot),
      snapshot: snapshot as unknown as Json,
    },
  };
}
