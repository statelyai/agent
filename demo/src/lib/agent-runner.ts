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
  runAgent,
  type AgentRequestExecutors,
  type RunAgentResult,
} from "@statelyai/agent";
import type { AnyMachineSnapshot, AnyStateMachine, Snapshot } from "xstate";
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
import { scenarioSource, type ScenarioId } from "./scenarios";

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
  return { mode: "live", model: primary, executors };
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
    }
  }
  if (result.status === "idle") {
    const context = result.snapshot.context as Record<string, unknown>;
    if (scenarioId === "approval") return String(context.draft ?? "Draft ready for review.");
    if (scenarioId === "refund") return "Amount exceeds the auto-refund limit. Awaiting approval.";
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
  mode: RunMode,
  model: string | undefined,
  executors: Partial<AgentRequestExecutors>,
  signal?: AbortSignal,
): Promise<ScenarioResult> {
  const { trace, onTransition } = createTraceRecorder();
  const machine = machineFor(scenarioId);
  const result = await runAgent(machine, {
    input: inputFor(scenarioId, prompt),
    executors,
    ...(signal ? { signal } : {}),
    onTransition,
    inspect: maybeCreateRunInspection(machine, scenarioSource[scenarioId]),
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
  signal?: AbortSignal,
): Promise<ScenarioResult> {
  const { trace, onTransition } = createTraceRecorder();
  const machine = machineFor(scenarioId);
  // runAgent rejects an event the restored state cannot accept — the
  // snapshot-level validation the task requires.
  const result = await runAgent(machine, {
    snapshot,
    event,
    executors,
    ...(signal ? { signal } : {}),
    onTransition,
    inspect: maybeCreateRunInspection(machine, scenarioSource[scenarioId]),
  });
  return toResult(scenarioId, mode, model, result as RunAgentResult<AnyStateMachine>, trace);
}

// ─── env-resolving wrappers (used by the server functions) ───

export async function startScenario(
  scenarioId: ScenarioId,
  prompt: string,
  signal?: AbortSignal,
): Promise<ScenarioResult> {
  const { mode, model, executors } = await resolveExecutors(scenarioId);
  return startScenarioRun(scenarioId, prompt, mode, model, executors, signal);
}

export async function resumeScenario(
  scenarioId: ScenarioId,
  snapshot: Snapshot<unknown>,
  event: ResumeEvent,
  signal?: AbortSignal,
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
    return resumeScenarioRun(scenarioId, snapshot, typed, mode, model, executors, signal);
  }

  return resumeScenarioRun(scenarioId, snapshot, event, mode, model, executors, signal);
}

/** Interprets a free-text review as a typed verdict (scripted or live). */
async function interpretReview(
  text: string,
  mode: RunMode,
): Promise<"APPROVE" | "REJECT" | "UNCLEAR"> {
  if (mode === "script") return scriptedReviewVerdict(text);
  try {
    const [{ generateText }, { openai }] = await Promise.all([
      import("ai"),
      import("@ai-sdk/openai"),
    ]);
    const { text: out } = await generateText({
      model: openai(process.env.OPENAI_MODEL || "gpt-5.4-mini"),
      system:
        "Interpret the human's review of a draft as exactly one word: APPROVE, REJECT, or UNCLEAR. Negative feedback means REJECT.",
      prompt: text,
    });
    const verdict = out.trim().toUpperCase();
    return verdict.includes("APPROVE")
      ? "APPROVE"
      : verdict.includes("REJECT")
        ? "REJECT"
        : "UNCLEAR";
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
  const machine = machineFor(scenarioId);
  // Describe the RESTORED snapshot, so the echoed idle carries the same event
  // schemas (REJECT's required `reason`), labels, and hints as the original.
  const restored = machine.resolveState(
    snapshot as never as Parameters<AnyStateMachine["resolveState"]>[0],
  );
  return {
    mode,
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
