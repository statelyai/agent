/**
 * The email drafter running under the Stately Inspector — a faithful port of
 * the standalone `ai-xstate-email-example` CLI. Instead of the `runAgent`
 * loop (which stops and resumes the actor per idle settle), this host keeps
 * one live `createActor` actor for the whole session and wires
 * `createInspector`'s `inspect` callback into it, so the full prompt →
 * evaluate → draft → review → send flow is visible as a single actor in the
 * inspector.
 *
 * Like the original, it works without OPENAI_API_KEY: heuristic fallbacks
 * assess and draft from the prompt text, and any failed AI call warns and
 * falls back the same way.
 *
 * `createInspector` from `@statelyai/sdk` connects to a Stately inspection
 * relay over WebSocket; once the relay connects, it opens the inspector
 * session in your browser (the Node process needs no Stately API key).
 *
 * Run: npx tsx examples/email-drafter-inspector/index.ts
 * Env: OPENAI_API_KEY (optional; enables real model calls),
 * STATELY_INSPECT_URL (WebSocket URL of the inspection relay, default
 * ws://localhost:4242), STATELY_INSPECT_NO_OPEN=1 to skip auto-opening the
 * browser.
 */
import { z } from "zod";
import { createActor, createAsyncLogic, waitFor } from "xstate";
import { createInspector } from "@statelyai/sdk";
import { confirm, input as textInput, select } from "@inquirer/prompts";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { getStateMeta, parseAgentEvent } from "@statelyai/agent";
import {
  draftEmail,
  emailDrafter,
  emailDrafterSchemas,
  evaluatePrompt,
  metaSchema,
  models,
  type Interaction,
  type DrafterEvent,
} from "../email-drafter/index.js";
import {
  assessPromptFallback,
  draftEmailFallback,
  formatError,
  type EmailDraft,
} from "./fallback.js";

// Bind implementations onto the machine's actor sources up front, so a plain
// `createActor` can run it. Each text logic tries the AI SDK executor when a
// key is present and falls back to the original example's heuristics
// otherwise (or on failure); `sendEmail` reproduces the original's 1200ms
// "Email sending..." pause (the original modeled it as `after: { 1200 }`).
const executors = createAiSdkExecutors({ models });

export const inspectedEmailDrafter = emailDrafter.provide({
  actors: {
    evaluatePrompt: evaluatePrompt.withExecutor(async ({ input }) => {
      if (process.env.OPENAI_API_KEY) {
        try {
          return { output: await evaluatePrompt.execute(input, executors) };
        } catch (error) {
          console.warn(`AI assessment failed; using fallback. ${formatError(error)}`);
        }
      }
      return { output: assessPromptFallback(input.prompt) };
    }),
    draftEmail: draftEmail.withExecutor(async ({ input }) => {
      if (process.env.OPENAI_API_KEY) {
        try {
          return { output: await draftEmail.execute(input, executors) };
        } catch (error) {
          console.warn(`AI draft failed; using fallback. ${formatError(error)}`);
        }
      }
      return { output: draftEmailFallback(input.prompt) };
    }),
    sendEmail: createAsyncLogic<{ sent: boolean }, { draft: EmailDraft }>({
      run: async ({ input }) => {
        void input.draft;
        console.log("\nEmail sending...");
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return { sent: true };
      },
    }),
  },
});

function printDraft(draft: EmailDraft) {
  console.log("\n--- Draft ---");
  console.log(`To: ${draft.to}`);
  console.log(`Subject: ${draft.subject}`);
  console.log("");
  console.log(draft.body);
  console.log("-------------\n");
}

/** Render one `meta.interaction` with @inquirer/prompts (as the original CLI
 * did) and return the event the human chose. */
async function promptInteraction(interaction: Interaction): Promise<DrafterEvent> {
  switch (interaction.type) {
    case "text": {
      const value = await textInput({
        message: `${interaction.label}:`,
        required: true,
      });
      return { type: interaction.eventType, [interaction.field]: value };
    }
    case "confirm": {
      const yes = await confirm({
        message: interaction.label,
        default: interaction.default ?? false,
      });
      return {
        type: yes ? interaction.trueEventType : interaction.falseEventType,
      };
    }
    case "select": {
      const choice = await select({
        message: `${interaction.label}:`,
        choices: interaction.choices.map((c) => ({ name: c.label, value: c })),
      });
      const event: DrafterEvent = { type: choice.eventType };
      if (choice.input) {
        event[choice.input.field] = await textInput({
          message: `${choice.input.label}:`,
          required: true,
        });
      }
      return event;
    }
  }
}

export async function main() {
  const inspector = createInspector({
    url: process.env.STATELY_INSPECT_URL, // default ws://localhost:4242
    name: "email-drafter",
    autoOpen: !process.env.STATELY_INSPECT_NO_OPEN,
  });

  const actor = createActor(inspectedEmailDrafter, {
    inspect: inspector.inspect,
  });
  actor.start();

  try {
    for (;;) {
      // Settle at the next interaction state (or a final state). Interaction
      // states have no invoke, so the actor idles there until we send the
      // event the human chose.
      const snapshot = await waitFor(
        actor,
        (s) => s.status !== "active" || getStateMeta(s).interaction != null,
        { timeout: Infinity },
      );
      if (snapshot.status !== "active") {
        break;
      }

      const meta = getStateMeta<typeof snapshot, z.infer<typeof metaSchema>>(snapshot);
      if (!meta.interaction) {
        break;
      }

      // Mirror the original CLI's state-specific output: the assessment gaps
      // before the needsMoreInfo choice, the draft before review.
      if (snapshot.matches("needsMoreInfo") && snapshot.context.assessment) {
        const { missing, questions } = snapshot.context.assessment;
        console.log(`Missing: ${missing.join(", ")}`);
        for (const question of questions) console.log(`- ${question}`);
      }
      if (snapshot.matches("reviewing") && snapshot.context.draft) {
        printDraft(snapshot.context.draft);
      }
      for (const line of meta.display ?? []) {
        console.log(line);
      }

      const event = await promptInteraction(meta.interaction);
      actor.send(parseAgentEvent(snapshot, event, { events: emailDrafterSchemas.events }));
    }

    if (actor.getSnapshot().status === "done") {
      console.log("Done.");
    } else if (actor.getSnapshot().status === "error") {
      console.error("Run failed:", actor.getSnapshot().error);
    }
  } finally {
    actor.stop();
    inspector.destroy();
    // The WebSocket keeps the event loop alive briefly; exit once flushed.
    setTimeout(() => process.exit(0), 0);
  }
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
