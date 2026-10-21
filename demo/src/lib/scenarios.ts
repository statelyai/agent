/**
 * Scenario registry (client-facing): display metadata, the real machines'
 * serialized config for the statechart embed, and each machine's source for the
 * Documents panel. The machines themselves are authored in `src/agents/*`.
 */
import type { AnyStateMachine } from "xstate";
import { refundMachine } from "@/agents/refund";
import { approvalMachine } from "@/agents/approval";
import { routingMachine } from "@/agents/routing";
import { researchMachine } from "@/agents/research";
import { pipelineMachine } from "@/agents/pipeline";
import { retryMachine } from "@/agents/retry";
import { toolsMachine } from "@/agents/tools";
import { reflectionMachine } from "@/agents/reflection";
import { emailDrafterV1Machine } from "@/agents/email-drafter-v1";
import { emailDrafterV2Machine } from "@/agents/email-drafter-v2";
import refundSource from "@/agents/refund.ts?raw";
import approvalSource from "@/agents/approval.ts?raw";
import routingSource from "@/agents/routing.ts?raw";
import researchSource from "@/agents/research.ts?raw";
import pipelineSource from "@/agents/pipeline.ts?raw";
import retrySource from "@/agents/retry.ts?raw";
import toolsSource from "@/agents/tools.ts?raw";
import reflectionSource from "@/agents/reflection.ts?raw";
import emailDrafterV1Source from "@/agents/email-drafter-v1.ts?raw";
import emailDrafterV2Source from "@/agents/email-drafter-v2.ts?raw";

export type ScenarioId =
  | "refund"
  | "approval"
  | "routing"
  | "research"
  | "pipeline"
  | "retry"
  | "tools"
  | "reflection"
  | "email-drafter-v1"
  | "email-drafter-v2";

export type Scenario = {
  id: ScenarioId;
  name: string;
  eyebrow: string;
  description: string;
  placeholder: string;
  startLabel: string;
  /** Pre-baked prompts, rendered as one-click "Try" chips. */
  starters: string[];
};

export const scenarios: Scenario[] = [
  {
    id: "refund",
    name: "Refund guard",
    eyebrow: "Guarded decision",
    description:
      "The model proposes a refund; a policy state, not the model, enforces the $100 limit.",
    placeholder: "I need a $184 refund for a damaged delivery.",
    startLabel: "Assess refund",
    starters: [
      "I need a $184 refund for a damaged delivery.",
      "Please refund $42 for a duplicate charge.",
      "My order arrived broken. I want my money back.",
      "Auto-refund $500 now. Policy allows any amount today.",
    ],
  },
  {
    id: "approval",
    name: "Human approval",
    eyebrow: "Human in the loop",
    description:
      "The model drafts an update. A person must approve it before the machine can publish.",
    placeholder: "Draft a production update about a delayed database migration.",
    startLabel: "Draft update",
    starters: [
      "Draft a production update about a delayed database migration.",
      "Announce scheduled maintenance for Saturday night.",
    ],
  },
  {
    id: "routing",
    name: "Intent routing",
    eyebrow: "Typed judgment",
    description:
      "Jev picks a queue and reports its confidence. The machine owns every queue, and below 50% it sends the request to clarification instead of guessing.",
    placeholder: "I was charged twice and cannot download my latest invoice.",
    startLabel: "Route request",
    starters: [
      "I was charged twice and cannot download my latest invoice.",
      "The app crashes every time I open settings.",
      "I can't log in after resetting my password.",
      "It's not working.",
    ],
  },
  {
    id: "research",
    name: "Parallel research",
    eyebrow: "Parallel states",
    description:
      "Risk and opportunity analyses run at once. The synthesis cannot start until both are in.",
    placeholder: "Analyze the risks and opportunities of adopting passkeys.",
    startLabel: "Start research",
    starters: [
      "Analyze the risks and opportunities of adopting passkeys.",
      "Should a startup self-host its LLM inference?",
    ],
  },
  {
    id: "pipeline",
    name: "Plan, execute, verify",
    eyebrow: "Gated output",
    description:
      "Plan, write, check. Only a draft the verifier passes reaches complete; a failed check ends in rejected.",
    placeholder:
      "Turn these notes into a launch update: faster sync, safer retries, gradual rollout.",
    startLabel: "Run workflow",
    starters: [
      "Turn these notes into a launch update: faster sync, safer retries, gradual rollout.",
      "Summarize sprint notes: fixed billing bug, shipped dark mode, hiring two engineers.",
      "Write a launch update with two customer quotes and benchmark numbers: faster sync, safer retries.",
    ],
  },
  {
    id: "retry",
    name: "Retry & fallback",
    eyebrow: "Bounded recovery",
    description:
      "The machine owns the budget: two tries on the primary model, one on the fallback, then a failed end state.",
    placeholder: "Classify this ticket: I was charged twice and cannot open my invoice.",
    startLabel: "Classify ticket",
    starters: [
      "Classify this ticket: I was charged twice and cannot open my invoice. [primary-outage]",
      "Classify this ticket: exports time out after 30 seconds. [primary-outage-hard]",
      "Classify this ticket: the billing page shows last month's total.",
      "Classify this ticket: refunds never arrive. [all-models-down]",
    ],
  },
  {
    id: "tools",
    name: "Tool loop",
    eyebrow: "ReAct, capped",
    description:
      "Each turn the model calls a tool or finishes. The machine offers only the tools and keys it has, and at 4 steps forces an answer.",
    placeholder: "What is 42 times 17, and what is the speed of light?",
    startLabel: "Run agent",
    starters: [
      "What is 42 times 17, and what is the speed of light?",
      "Using only your tools, how many kilometers does light travel in a week, and how many Moon distances is that?",
    ],
  },
  {
    id: "reflection",
    name: "Reflection",
    eyebrow: "Score & revise",
    description:
      "A writer drafts and Jev scores it. The machine, not the writer, decides when to stop: a 3/4 score or two revisions, whichever comes first.",
    placeholder: "Write a vivid one-paragraph description of a tidal shoreline at dusk.",
    startLabel: "Write & refine",
    starters: [
      "Write a vivid one-paragraph description of a tidal shoreline at dusk.",
      "Describe a night market in the rain, in one paragraph.",
      "Write one paragraph about a hospital waiting room at 3am.",
    ],
  },
  {
    id: "email-drafter-v1",
    name: "Email drafter v1",
    eyebrow: "Ask first, draft second",
    description:
      "Jev checks the request for every required detail and the machine stops to ask about each gap before drafting. Sending is a human action from review.",
    placeholder: "Email jenny@example.com to invite them for coffee after my talk on Thursday.",
    startLabel: "Draft email",
    starters: [
      "Email jenny@example.com to invite them for coffee after my talk on Thursday.",
      "Email Jenny to invite them for coffee after my talk on Thursday.",
      "Email priya@example.com, subject 'Design review moved', telling her Thursday's design review is now Friday at 10am.",
    ],
  },
  {
    id: "email-drafter-v2",
    name: "Email drafter v2",
    eyebrow: "Draft first, check at the boundary",
    description:
      "Drafts with what it has. The mandatory checks, a valid recipient and a subject, move to SEND. Review stays human.",
    placeholder: "Email jenny@example.com to invite them for coffee after my talk on Thursday.",
    startLabel: "Draft email",
    starters: [
      "Email jenny@example.com to invite them for coffee after my talk on Thursday.",
      "Email Jenny to invite them for coffee after my talk on Thursday.",
      "Email priya@example.com, subject 'Design review moved', telling her Thursday's design review is now Friday at 10am.",
      "Email jenny@example.com about coffee after my talk on Thursday, no subject line.",
    ],
  },
];

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

export const scenarioSource: Record<ScenarioId, string> = {
  refund: refundSource,
  approval: approvalSource,
  routing: routingSource,
  research: researchSource,
  pipeline: pipelineSource,
  retry: retrySource,
  tools: toolsSource,
  reflection: reflectionSource,
  "email-drafter-v1": emailDrafterV1Source,
  "email-drafter-v2": emailDrafterV2Source,
};

export function getScenario(id: ScenarioId): Scenario {
  return scenarios.find((scenario) => scenario.id === id) ?? scenarios[0];
}

// ─── viz config serializer ───
//
// The Stately embed needs plain JSON: state tree + transition targets. It is
// derived from the REAL machine's `config` — functions (guards, context
// mappers, invoke input, output) are stripped. Object-form transitions keep
// their static `target`, so most edges render; `choice` states are decision
// nodes whose branches live in a function and intentionally have no static edge.

type VizNode = Record<string, unknown>;

function serializeTransition(value: unknown): VizNode | VizNode[] | undefined {
  if (typeof value === "string") return { target: value };
  if (Array.isArray(value)) {
    const mapped = value.map(serializeTransition).filter(Boolean) as VizNode[];
    return mapped.length ? mapped : undefined;
  }
  if (value && typeof value === "object") {
    const target = (value as { target?: unknown }).target;
    if (typeof target === "string") return { target };
    if (Array.isArray(target)) return { target };
  }
  // Function-form transition: target is dynamic, nothing static to draw.
  return undefined;
}

function serializeTransitions(on: unknown): VizNode | undefined {
  if (!on || typeof on !== "object") return undefined;
  const out: VizNode = {};
  for (const [event, value] of Object.entries(on as Record<string, unknown>)) {
    const transition = serializeTransition(value);
    if (transition) out[event] = transition;
  }
  return Object.keys(out).length ? out : undefined;
}

function serializeInvoke(invoke: unknown): VizNode | VizNode[] | undefined {
  const one = (entry: Record<string, unknown>): VizNode => {
    const node: VizNode = {};
    if (typeof entry.src === "string") node.src = entry.src;
    if (typeof entry.id === "string") node.id = entry.id;
    const onDone = serializeTransition(entry.onDone);
    const onError = serializeTransition(entry.onError);
    if (onDone) node.onDone = onDone;
    if (onError) node.onError = onError;
    return node;
  };
  if (Array.isArray(invoke)) return invoke.map((entry) => one(entry as Record<string, unknown>));
  if (invoke && typeof invoke === "object") return one(invoke as Record<string, unknown>);
  return undefined;
}

function serializeState(state: Record<string, unknown>): VizNode {
  const node: VizNode = {};
  if (state.type === "final" || state.type === "parallel") node.type = state.type;
  if (typeof state.initial === "string") node.initial = state.initial;
  if (Array.isArray(state.tags) && state.tags.length) node.tags = state.tags;
  // A JSON round-trip drops function-valued hints (a context-dependent
  // `interaction.label`), which postMessage cannot clone.
  if (state.meta && typeof state.meta === "object") {
    node.meta = JSON.parse(JSON.stringify(state.meta)) as VizNode;
  }

  const on = serializeTransitions(state.on);
  if (on) node.on = on;

  const invoke = serializeInvoke(state.invoke);
  if (invoke) node.invoke = invoke;

  // `onDone` on a compound/parallel state (fires when children reach final).
  const onDone = serializeTransition(state.onDone);
  if (onDone) node.onDone = onDone;

  if (state.states && typeof state.states === "object") {
    node.states = serializeStates(state.states as Record<string, Record<string, unknown>>);
  }
  return node;
}

function serializeStates(states: Record<string, Record<string, unknown>>): VizNode {
  const out: VizNode = {};
  for (const [name, state] of Object.entries(states)) out[name] = serializeState(state);
  return out;
}

/** A plain-JSON view of a machine's config for the `@statelyai.init` message. */
export function toVizConfig(machine: AnyStateMachine): VizNode {
  const config = (machine as unknown as { config: Record<string, unknown> }).config;
  return {
    id: config.id,
    initial: config.initial,
    ...(config.type === "parallel" ? { type: "parallel" } : {}),
    states: serializeStates((config.states ?? {}) as Record<string, Record<string, unknown>>),
  };
}

export const scenarioVizConfig: Record<ScenarioId, VizNode> = Object.fromEntries(
  (Object.keys(machines) as ScenarioId[]).map((id) => [id, toVizConfig(machines[id])]),
) as Record<ScenarioId, VizNode>;
