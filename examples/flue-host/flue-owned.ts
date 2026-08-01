/**
 * Way 2 — FLUE OWNS THE LOGIC; the machine is only the step graph.
 *
 * Flue 2's hooks pattern (https://flueframework.com/docs/guide/agent-hooks)
 * with one substitution: `usePersistentState('step', 'drafting')` becomes a
 * persisted machine state. Everything else stays Flue-shaped — the agent itself
 * drafts and reviews in conversation, and each step attaches its own model,
 * skill, and tools on re-render.
 *
 * What the ~10-line machine buys over the step string it replaces:
 *
 *   - Transitions are declared, not `setStep(...)` callable from anywhere.
 *     `sendStep` refuses events the current state doesn't handle.
 *   - The switch over the step is exhaustive: a typo'd or unhandled step is a
 *     compile error (`satisfies never`), not a silently tool-less agent.
 *   - Events are inferred from the machine (`EventFromLogic`), not hand-typed.
 *   - The step graph visualizes, diffs, and model-tests like any machine.
 *
 * Contrast ./machine-owned.ts, where the machine also owns the model calls,
 * branching, and pauses, and the Flue agent is just a conversational shell.
 *
 * Only the step VALUE is persisted, never a snapshot object: Flue's store is a
 * database, so the persisted shape has to be plain JSON. It is revived with
 * `steps.resolveState`, which validates against the machine — a step renamed in
 * a redeploy fails loudly instead of resurrecting a ghost state.
 */
import assert from "node:assert/strict";
import * as v from "valibot";
import { createMachine, initialTransition, transition, type EventFromLogic } from "xstate";
import { defineSkill, init, useModel, usePersistentState, useSkill, useTool } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type FauxResponseFactory,
  type Provider,
} from "@earendil-works/pi-ai";

// ─── The entire machine ───
//
// No context, no actors, no interactions: the steps and nothing else. The
// agent's conversation IS the workflow's content; only its shape lives here.

export const steps = createMachine({
  id: "email-steps",
  initial: "drafting",
  states: {
    drafting: { on: { DRAFT_READY: { target: "reviewing" } } },
    reviewing: {
      on: {
        APPROVED: { target: "sending" },
        CHANGES_REQUESTED: { target: "drafting" },
      },
    },
    sending: { on: { SENT: { target: "done" } } },
    done: { type: "final" },
  },
});

/**
 * The literal step union, inferred from the machine's own states (in this
 * xstate alpha, `machine.states` carries the config schema, hence the double
 * index).
 */
type StepValue = keyof (typeof steps)["states"]["states"];
/** Inferred from the machine — never hand-written. */
type StepEvent = EventFromLogic<typeof steps>;

export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
}

/**
 * The external mail system. Sending is a side effect on the world, not agent
 * state, so it lives outside Flue's store — which also gives the demo and its
 * tests something to assert on without reading the agent's database.
 */
export const outbox: EmailDraft[] = [];

// ─── Per-step guidance (real Flue skills, defined in code) ───
//
// `defineSkill` takes the SKILL.md body inline, so no build step is involved.
// The `SKILL.md` import form needs the Flue build and will not load under tsx
// or vitest.

const draftingGuide = defineSkill({
  name: "drafting-guide",
  description: "How to draft an email with the user. Use while the workflow is at the draft step.",
  instructions:
    "Draft the email yourself, in conversation with the user. When they are happy " +
    "with the text, call submit_draft with the final to/subject/body.",
});

const reviewChecklist = defineSkill({
  name: "review-checklist",
  description: "How to review a submitted draft. Use while the workflow is at the review step.",
  instructions:
    "Review the submitted draft against the user's intent: recipient right, " +
    "subject specific, body complete, tone appropriate. Then call approve, or " +
    "request_changes with concrete feedback.",
});

// ─── The Flue 2 agent ───
//
// In Flue 2 the agent IS the exported function: no `defineAgent` wrapper, and
// the instructions are its return value. Flue re-runs it before every model
// turn, so the hooks below re-attach whatever the current step calls for.

export function FlueOwnedAgent() {
  // Flue's `usePersistentState('step', 'drafting')`, upgraded: the persisted
  // value is a machine state, so the step can only change along a declared
  // transition.
  const [step, setStep] = usePersistentState<StepValue>(
    "step",
    initialTransition(steps)[0].value as StepValue,
  );
  const [draft, setDraft] = usePersistentState<EmailDraft | null>("draft", null);

  /**
   * The one way the step changes. `transition` is pure; an event the current
   * state doesn't handle leaves the state where it was, which this turns into
   * an error. Tool availability below already makes that unreachable through
   * the model — this is the backstop for a buggy tool sending the wrong event.
   */
  const sendStep = (event: StepEvent) => {
    const [next] = transition(steps, steps.resolveState({ value: step }), event);
    if (next.value === step) {
      throw new Error(`Illegal event ${event.type} in step ${step}`);
    }
    setStep(next.value as StepValue);
  };

  // The docs' if-blocks, made exhaustive: `satisfies never` turns a missed or
  // typo'd step into a compile error instead of a tool-less bricked agent.
  switch (step) {
    case "drafting":
      useModel("openai/gpt-5.4-mini");
      useSkill(draftingGuide);
      useTool({
        name: "submit_draft",
        description: "Submit the agreed draft for review. Moves the workflow to reviewing.",
        input: v.object({
          to: v.string(),
          subject: v.string(),
          body: v.string(),
        }),
        output: v.object({ step: v.string() }),
        run({ data }) {
          setDraft(data);
          sendStep({ type: "DRAFT_READY" });
          return { output: { step: "reviewing" } };
        },
      });
      break;

    case "reviewing":
      // The review step gets a stronger model — the docs' per-step useModel,
      // but the step it keys on is a validated machine state.
      useModel("anthropic/claude-sonnet-5");
      useSkill(reviewChecklist);
      useTool({
        name: "approve",
        description: "Approve the draft and move the workflow to sending.",
        input: v.object({}),
        output: v.object({ step: v.string() }),
        run() {
          sendStep({ type: "APPROVED" });
          return { output: { step: "sending" } };
        },
      });
      useTool({
        name: "request_changes",
        description: "Send the draft back to drafting with concrete feedback.",
        input: v.object({
          feedback: v.pipe(v.string(), v.description("What to change, concretely")),
        }),
        output: v.object({ step: v.string() }),
        run() {
          sendStep({ type: "CHANGES_REQUESTED" });
          return { output: { step: "drafting" } };
        },
      });
      break;

    case "sending":
      useModel("openai/gpt-5.4-mini");
      useTool({
        name: "send_email",
        description: "Send the approved draft. Moves the workflow to done.",
        input: v.object({}),
        output: v.object({ sentCount: v.number() }),
        run() {
          if (!draft) throw new Error("No draft to send");
          outbox.push(draft);
          sendStep({ type: "SENT" });
          return { output: { sentCount: outbox.length } };
        },
      });
      break;

    case "done":
      useModel("openai/gpt-5.4-mini");
      useSkill(
        defineSkill({
          name: "wrap-up",
          description: "How to close out a finished workflow.",
          instructions: "The workflow is complete. Summarize what was sent.",
        }),
      );
      break;

    default:
      step satisfies never;
  }

  return (
    "You help people write and send email. Follow the guidance for the current " +
    "step; your tools change as the workflow advances."
  );
}

// ─── Keyless model: pi's faux provider, driven by what each render offers ───
//
// The demo has no API key, so it plays the model's part — but through the real
// Flue runtime, not a stand-in for it. A faux response factory sees the very
// `Context` the runtime built for the turn, so it can react to the tools this
// step rendered instead of replaying a fixed script.

/** Canned arguments for each workflow tool the agent might offer. */
const CANNED_CALLS: Record<string, Record<string, unknown>> = {
  submit_draft: {
    to: "team@example.com",
    subject: "Deploy pipeline is faster",
    body: "Hi team,\n\nThe deploy pipeline is now roughly twice as fast.\n\nThanks!",
  },
  approve: {},
  send_email: {},
};

/** Enough queued turns for the workflow to reach `done` and stop. */
const MAX_TURNS = 12;

/**
 * Faux providers for both models the agent uses, plus the trace of workflow
 * tools each render offered — which is the whole point of the pattern, so the
 * demo prints it and the test asserts on it.
 */
export function scriptedModel(): { providers: Provider[]; trace: string[][] } {
  const trace: string[][] = [];

  const respond: FauxResponseFactory = (context: Context) => {
    const offered = (context.tools ?? [])
      .map((tool) => tool.name)
      .filter((name) => name in CANNED_CALLS);
    trace.push(offered);

    const next = offered[0];
    if (!next) return fauxAssistantMessage("The workflow is complete; the email was sent.");
    return fauxAssistantMessage([fauxToolCall(next, CANNED_CALLS[next]!)], {
      stopReason: "toolUse",
    });
  };

  // One faux provider per provider id the agent names, so `useModel` resolves
  // the same specifiers it would in production.
  const providers = [
    fauxProvider({ provider: "openai", models: [{ id: "gpt-5.4-mini" }] }),
    fauxProvider({ provider: "anthropic", models: [{ id: "claude-sonnet-5" }] }),
  ].map((faux) => {
    faux.setResponses(Array.from({ length: MAX_TURNS }, () => respond));
    return faux.provider;
  });

  return { providers, trace };
}

// ─── Demo ───

export async function main({ live = false } = {}) {
  outbox.length = 0;
  const scripted = live ? null : scriptedModel();

  const flue = await start({
    agents: [FlueOwnedAgent],
    providers: scripted?.providers,
  });
  try {
    const agent = init(FlueOwnedAgent, { id: `flue-owned-${Date.now()}` });
    const reply = await agent.read(
      await agent.dispatch(
        "Tell the team the deploy pipeline is twice as fast, then review and send it.",
      ),
    );

    for (const offered of scripted?.trace ?? []) {
      console.log(`[render] workflow tools: ${offered.join(", ") || "(none)"}`);
    }
    console.log(`\n${reply.text}`);
    console.log(`\nSent ${outbox.length} email(s):`, outbox[0]?.subject);

    assert.equal(outbox.length, 1);
  } finally {
    await flue.stop();
  }
}
