/**
 * Scenario runner — the real host layer around `runAgent`.
 *
 * This is the "TanStack Start host" pattern (examples/tanstack-start-host) for
 * real: each scenario is a `setupAgent` machine that `runAgent` drives to a
 * settled result. The host stays stateless — an idle run returns a persisted
 * snapshot the client sends back to resume.
 *
 * The same code path runs with real models (`createAiSdkExecutors`, when
 * `OPENAI_API_KEY` is set) or with keyless scripted executors. Tests import the
 * `*Run` functions directly and inject scripted executors — no API key, no
 * network.
 */
import {
  persistSnapshot,
  runAgent,
  type AgentRequestExecutors,
  type RunAgentResult,
} from "@statelyai/agent";
import type { AnyStateMachine, Snapshot } from "xstate";
import { maybeCreateRunInspection } from "./inspection.server";
import { createTraceRecorder, describeIdle, type TraceEntry } from "./machine-chat.server";
import type { ChatIdle } from "./machine-ui";
import { refundMachine } from "@/agents/refund";
import { approvalMachine } from "@/agents/approval";
import { routingMachine } from "@/agents/routing";
import { researchMachine } from "@/agents/research";
import { pipelineMachine } from "@/agents/pipeline";
import { retryMachine } from "@/agents/retry";
import { toolsMachine } from "@/agents/tools";
import { reflectionMachine } from "@/agents/reflection";
import { scriptedExecutorsFor, scriptedReviewVerdict } from "./scripted-executors";
import type { ScenarioId } from "./scenarios";

export type RunMode = "live" | "script";

/** JSON-safe value — server fns must return serializable data (TanStack validates it). */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type { TraceEntry };

export type IdlePayload = ChatIdle & {
  /** JSON-serializable persisted snapshot; the client sends it back to resume. */
  snapshot: Json;
};

export type ScenarioResult = {
  mode: RunMode;
  model?: string;
  status: "done" | "idle" | "error";
  trace: TraceEntry[];
  response: string;
  idle?: IdlePayload;
  output?: Json;
};

export type ResumeEvent = { type: string; [key: string]: unknown } | { kind: "interpret"; text: string };

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
  }
}

// ─── executor resolution ───

/** Resolves live (AI SDK) or scripted executors for a scenario, plus a label. */
async function resolveExecutors(
  scenarioId: ScenarioId,
): Promise<{ mode: RunMode; model?: string; executors: Partial<AgentRequestExecutors> }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { mode: "script", executors: scriptedExecutorsFor(scenarioId) };
  }
  // Lazy import: keeps @ai-sdk/openai out of any bundle that only needs scripts.
  const [{ createAiSdkExecutors, defineModels }, { openai }] = await Promise.all([
    import("@statelyai/agent/ai-sdk"),
    import("@ai-sdk/openai"),
  ]);
  const primary = process.env.OPENAI_MODEL || "gpt-5.4-mini";
  const fallback = process.env.OPENAI_FALLBACK_MODEL || primary;
  const models = defineModels({
    fast: openai(primary),
    writer: openai(primary),
    router: openai(primary),
    analyst: openai(primary),
    planner: openai(primary),
    critic: openai(primary),
    reasoner: openai(primary),
    primary: openai(primary),
    fallback: openai(fallback),
  });
  return { mode: "live", model: primary, executors: createAiSdkExecutors({ models }) };
}

// ─── result shaping ───

function describeResult(scenarioId: ScenarioId, result: RunAgentResult<AnyStateMachine>): string {
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
        return `Routed to the ${output.queue} queue.`;
      case "research":
        return String(output.synthesis || "Synthesis complete.");
      case "pipeline":
        return output.failedAt
          ? `Failed at ${output.failedAt}.`
          : `${output.draft}\n\nVerification: ${output.verification}`;
      case "retry":
        return output.category
          ? `${output.category} (${output.usedFallback ? "fallback model" : "primary model"}, ${output.attempts} retr${output.attempts === 1 ? "y" : "ies"})`
          : "All model attempts failed.";
      case "tools":
        return `${output.answer} (in ${output.steps} tool step${output.steps === 1 ? "" : "s"})`;
      case "reflection":
        return `${output.draft}\n\nScore ${output.score}/10 after ${output.revisions} revision${output.revisions === 1 ? "" : "s"}${output.accepted ? "" : " (revision budget spent)"}.`;
    }
  }
  if (result.status === "idle") {
    const context = result.snapshot.context as Record<string, unknown>;
    if (scenarioId === "approval") return String(context.draft ?? "Draft ready for review.");
    if (scenarioId === "refund") return "Amount exceeds the auto-refund limit — awaiting approval.";
    return "Waiting for input.";
  }
  return "The run ended with an error.";
}

function toResult(
  scenarioId: ScenarioId,
  mode: RunMode,
  model: string | undefined,
  result: RunAgentResult<AnyStateMachine>,
  trace: TraceEntry[],
): ScenarioResult {
  const base: ScenarioResult = {
    mode,
    model,
    status: result.status === "done" ? "done" : result.status === "idle" ? "idle" : "error",
    trace,
    response: describeResult(scenarioId, result),
  };
  if (result.status === "done") base.output = result.output as Json;
  if (result.status === "idle") {
    base.idle = {
      ...describeIdle(machineFor(scenarioId), result.snapshot),
      snapshot: persistSnapshot(result.snapshot) as unknown as Json,
    };
  }
  return base;
}

// ─── start / resume ───

/** Runs a scenario from a prompt with the given executors. Pure — used by tests. */
export async function startScenarioRun(
  scenarioId: ScenarioId,
  prompt: string,
  mode: RunMode,
  model: string | undefined,
  executors: Partial<AgentRequestExecutors>,
): Promise<ScenarioResult> {
  const { trace, onTransition } = createTraceRecorder();
  const result = await runAgent(machineFor(scenarioId), {
    input: inputFor(scenarioId, prompt),
    executors,
    onTransition,
    inspect: maybeCreateRunInspection(),
  });
  return toResult(scenarioId, mode, model, result as RunAgentResult<AnyStateMachine>, trace);
}

/** Resumes a persisted idle snapshot with a typed event. Pure — used by tests. */
export async function resumeScenarioRun(
  scenarioId: ScenarioId,
  snapshot: Snapshot<unknown>,
  event: { type: string; [key: string]: unknown },
  mode: RunMode,
  model: string | undefined,
  executors: Partial<AgentRequestExecutors>,
): Promise<ScenarioResult> {
  const { trace, onTransition } = createTraceRecorder();
  // `onIllegalResumeEvent: "throw"` (the default) rejects an event the restored
  // state cannot accept — the snapshot-level validation the task requires.
  const result = await runAgent(machineFor(scenarioId), {
    snapshot,
    event,
    executors,
    onTransition,
    inspect: maybeCreateRunInspection(),
  });
  return toResult(scenarioId, mode, model, result as RunAgentResult<AnyStateMachine>, trace);
}

// ─── env-resolving wrappers (used by the server functions) ───

export async function startScenario(scenarioId: ScenarioId, prompt: string): Promise<ScenarioResult> {
  const { mode, model, executors } = await resolveExecutors(scenarioId);
  return startScenarioRun(scenarioId, prompt, mode, model, executors);
}

export async function resumeScenario(
  scenarioId: ScenarioId,
  snapshot: Snapshot<unknown>,
  event: ResumeEvent,
): Promise<ScenarioResult> {
  const { mode, model, executors } = await resolveExecutors(scenarioId);

  // Free-text review ("looks good") → map to a typed event before delivering.
  if (isInterpretEvent(event)) {
    const verdict = await interpretReview(event.text, mode);
    if (verdict === "UNCLEAR") {
      // Re-settle idle without delivering an event: still awaiting a clear verdict.
      return startResumeIdleEcho(scenarioId, snapshot, mode, model);
    }
    const typed =
      verdict === "REJECT" ? { type: "REJECT", reason: event.text } : { type: "APPROVE" };
    return resumeScenarioRun(scenarioId, snapshot, typed, mode, model, executors);
  }

  return resumeScenarioRun(scenarioId, snapshot, event, mode, model, executors);
}

/** Interprets a free-text review as a typed verdict (scripted or live). */
async function interpretReview(text: string, mode: RunMode): Promise<"APPROVE" | "REJECT" | "UNCLEAR"> {
  if (mode === "script") return scriptedReviewVerdict(text);
  try {
    const [{ generateText }, { openai }] = await Promise.all([import("ai"), import("@ai-sdk/openai")]);
    const { text: out } = await generateText({
      model: openai(process.env.OPENAI_MODEL || "gpt-5.4-mini"),
      system:
        "Interpret the human's review of a draft as exactly one word: APPROVE, REJECT, or UNCLEAR. Negative feedback means REJECT.",
      prompt: text,
    });
    const verdict = out.trim().toUpperCase();
    return verdict.includes("APPROVE") ? "APPROVE" : verdict.includes("REJECT") ? "REJECT" : "UNCLEAR";
  } catch {
    return scriptedReviewVerdict(text);
  }
}

/** Returns the still-idle snapshot unchanged (UNCLEAR interpretation). */
function startResumeIdleEcho(
  scenarioId: ScenarioId,
  snapshot: Snapshot<unknown>,
  mode: RunMode,
  model: string | undefined,
): ScenarioResult {
  return {
    mode,
    model,
    status: "idle",
    trace: [],
    response: "Could not confidently interpret that review — approve or reject explicitly.",
    idle: {
      snapshot: snapshot as unknown as Json,
      prompt: "Review the draft: approve to publish, or reject with a reason.",
      events:
        scenarioId === "approval"
          ? [
              { type: "APPROVE", label: "Approve", style: "primary", jsonSchema: null, needsPayload: false },
              { type: "REJECT", label: "Reject", style: "danger", jsonSchema: null, needsPayload: false },
            ]
          : [],
      textEvent: null,
      component: null,
    },
  };
}
