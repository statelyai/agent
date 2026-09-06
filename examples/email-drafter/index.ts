/**
 * The flagship: an interactive email drafter that dogfoods the interaction
 * protocol. All agent logic (schemas, requests, actors, setup, machine) lives
 * in `./agent-logic.ts` — this file is just one host for it: an interactive CLI.
 *
 * The dogfood: a generic renderer over the library's interaction protocol. It
 * reads `getInteraction(snapshot)` and drives the terminal purely from the
 * returned `label` / `events` / `textEvent` — no state name is ever hardcoded,
 * and choices the machine currently refuses (a spent revision budget) never
 * render, because `getInteraction` filters them through `snapshot.can`.
 * Swap this loop for a web form or Slack modal and the same machine drives it.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/email-drafter/index.ts
 */
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { eventFromInteraction, getInteraction, runAgent } from "@statelyai/agent";
import { type DrafterEvent, type Interaction, emailDrafter, models } from "./agent-logic.js";

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

/**
 * Render one interaction and return the choice the human made: either a
 * `{ type }` for a listed choice, or `{ text }` for the state's `textEvent`.
 * `eventFromInteraction` turns either into a validated machine event.
 */
export async function promptInteraction(
  rl: { question: (q: string) => Promise<string> },
  interaction: Interaction,
): Promise<{ type: DrafterEvent["type"] } | { text: string }> {
  console.log(interaction.label);
  interaction.events.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice.label}`);
  });

  const textHint = interaction.textEvent ? ", or type a reply" : "";
  for (;;) {
    const raw = await ask(rl, `Choose 1-${interaction.events.length}${textHint}: `);
    const picked = interaction.events[Number(raw) - 1];
    if (picked && /^\d+$/.test(raw)) {
      return { type: picked.type };
    }
    if (interaction.textEvent && raw.length > 0) {
      return { text: raw };
    }
    console.log("Please enter a valid number.");
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
      const interaction = getInteraction(result.snapshot);
      if (!interaction) {
        // Idle with no interaction to render: nothing the human can do.
        console.error("Machine is idle with no interaction. Stopping.");
        break;
      }

      // Show the current draft whenever one exists, before the prompt.
      const draft = result.snapshot.context.draft;
      if (draft) {
        console.log(
          `\n--- Draft ---\nTo: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}\n-------------`,
        );
      }

      const choice = await promptInteraction(rl, interaction);
      result = await runAgent(emailDrafter, {
        snapshot: result.snapshot,
        // Typed off the snapshot: the machine's own event union, no cast.
        event: eventFromInteraction(result.snapshot, choice),
        executors,
      });
    }

    if (result.status === "done") {
      const { sentEmails, failure } = result.output;
      console.log(`\nSent ${sentEmails.length} email(s).`);
      if (failure) console.error("Run ended in failure:", failure);
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
