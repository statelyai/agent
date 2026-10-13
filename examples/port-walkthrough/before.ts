/**
 * BEFORE: the hand-rolled loop from docs/from-a-loop.md, runnable.
 *
 * The loop is the page's "Starting point" with three edits so it runs and
 * so `index.ts` can be checked against it:
 *   - `export` on the schema, the tool, and the function.
 *   - A declared return type, `SupportResult`, which `index.test.ts` compares
 *     with the machine's output type.
 *   - The page's `// push the tool result onto messages` placeholder is the
 *     one line that does it, `messages.push(...response.messages)`.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/port-walkthrough/before.ts
 */
import { generateText, tool, type Tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

export const emailSchema = z.object({ to: z.string(), subject: z.string(), body: z.string() });

export const search: Tool<{ query: string }, { results: string[] }> = tool({
  description: "Search the support knowledge base.",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => ({ results: [`top doc for ${query}`] }),
});

const sendEmail = tool({
  description: "Send an email to the customer.",
  inputSchema: emailSchema,
  execute: async ({ to }) => ({ sent: true, id: `msg_${to}` }),
});

/** Every way the loop returns. */
export type SupportResult =
  | { sent: boolean; stopped: "step-limit" }
  | { sent: boolean; reply: string }
  | { sent: boolean; pending: true };

export async function runSupportAgent(
  request: string,
  approve: (draft: unknown) => Promise<boolean>,
): Promise<SupportResult> {
  const messages: any[] = [{ role: "user", content: request }];
  let sent = false;
  let steps = 0;

  while (true) {
    if (steps++ >= 8) return { sent, stopped: "step-limit" };

    const { toolCalls, text, response } = await generateText({
      // Model IDs here are illustrative; substitute your provider's current models.
      model: openai("gpt-5.4-mini"),
      messages,
      tools: { search, sendEmail },
    });
    if (!toolCalls?.length) return { sent, reply: text };

    for (const call of toolCalls) {
      if (call.toolName === "sendEmail") {
        if (!(await approve(call.input))) return { sent, pending: true }; // loop state is lost here
        sent = true;
      }
    }
    messages.push(...response.messages);
  }
}

// Run directly (`tsx before.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const approve = async (draft: unknown) => {
      console.log("Draft:", draft);
      return (await rl.question("Send it? (y/n) > ")).trim().toLowerCase() === "y";
    };
    try {
      console.log(await runSupportAgent("Refund my duplicate charge", approve));
    } finally {
      rl.close();
    }
  })();
}
