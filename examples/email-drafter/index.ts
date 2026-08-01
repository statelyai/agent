/**
 * The flagship: an interactive email drafter that dogfoods the interaction
 * protocol. All agent logic (schemas, requests, actors, setup, machine) lives
 * in `./agent-logic.ts` — this file is just one host for it: an interactive CLI.
 *
 * The dogfood: a generic renderer for the schema-typed interaction protocol.
 * It reads `getStateMeta(snapshot).interaction` and drives the terminal purely
 * from that meta — no state name is ever hardcoded. Swap this loop for a web
 * form or Slack modal and the same machine drives it unchanged.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/email-drafter/index.ts
 */
import type { z } from "zod";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { getStateMeta, parseAgentEvent, runAgent } from "@statelyai/agent";
import {
  type DrafterEvent,
  type Interaction,
  emailDrafter,
  emailDrafterSchemas,
  metaSchema,
  models,
} from "./agent-logic.js";

// Re-exported so existing importers of this module keep working; hosts should
// import from './agent-logic.js' directly.
export * from "./agent-logic.js";

async function ask(
  rl: {
    question: (q: string) => Promise<string>;
  },
  q: string,
): Promise<string> {
  return (await rl.question(q)).trim();
}

/** Render one interaction and return the event the human chose. */
export async function promptInteraction(
  rl: { question: (q: string) => Promise<string> },
  interaction: Interaction,
  display: string[] | undefined,
): Promise<DrafterEvent> {
  for (const line of display ?? []) {
    console.log(line);
  }

  switch (interaction.type) {
    case "text": {
      const value = await ask(rl, `${interaction.label}: `);
      return { type: interaction.eventType, [interaction.field]: value };
    }
    case "confirm": {
      const answer = await ask(rl, `${interaction.label} [y/N]: `);
      const yes = /^y(es)?$/i.test(answer);
      return {
        type: yes ? interaction.trueEventType : interaction.falseEventType,
      };
    }
    case "select": {
      console.log(interaction.label);
      interaction.choices.forEach((choice, index) => {
        console.log(`  ${index + 1}. ${choice.label}`);
      });
      let choice = interaction.choices[0]!;
      for (;;) {
        const raw = await ask(rl, `Choose 1-${interaction.choices.length}: `);
        const picked = interaction.choices[Number(raw) - 1];
        if (picked) {
          choice = picked;
          break;
        }
        console.log("Please enter a valid number.");
      }
      const event: DrafterEvent = { type: choice.eventType };
      if (choice.input) {
        event[choice.input.field] = await ask(rl, `${choice.input.label}: `);
      }
      return event;
    }
  }
}

export async function main() {
  const executors = createAiSdkExecutors({ models });

  await withReadline(async (rl) => {
    // Start the machine; it settles idle at the first interaction state.
    let result = await runAgent(emailDrafter, {
      input: undefined,
      executors,
    });

    while (result.status === "idle") {
      const meta = getStateMeta<typeof result.snapshot, z.infer<typeof metaSchema>>(
        result.snapshot,
      );
      if (!meta.interaction) {
        // Idle with no interaction to render: nothing the human can do.
        console.error("Machine is idle with no interaction. Stopping.");
        break;
      }

      // Show the current draft whenever one exists, before the prompt.
      const draft = result.snapshot.context.draft;
      if (draft && meta.interaction.type !== "text") {
        console.log(
          `\n--- Draft ---\nTo: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}\n-------------`,
        );
      }

      const event = await promptInteraction(rl, meta.interaction, meta.display);
      result = await runAgent(emailDrafter, {
        snapshot: result.snapshot,
        event: parseAgentEvent(result.snapshot, event, {
          events: emailDrafterSchemas.events,
        }),
        executors,
      });
    }

    if (result.status === "done") {
      console.log(`\nSent ${result.output.sentEmails.length} email(s).`);
    } else if (result.status === "error") {
      console.error("Run failed:", result.error);
    }
  });
}

/** Open a readline interface, run `fn` with it, and always close it. */
async function withReadline<T>(
  fn: (rl: { question: (query: string) => Promise<string> }) => Promise<T>,
): Promise<T> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
