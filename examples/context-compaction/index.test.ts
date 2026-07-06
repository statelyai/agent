import { describe, expect, test } from "vitest";
import { runAgent } from "../../src/index.js";
import type { AgentMessage, AgentRequestExecutor, AgentUserInput } from "../../src/index.js";
import { contextCompactionMachine } from "./index.js";

function textContent(message: AgentMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

/**
 * Scripts the human side: answers each `agent.userInput` from a queue, then
 * types "exit" once the queue is drained to end the loop.
 */
function scriptedUserInput(answers: string[]): (input: AgentUserInput) => Promise<string> {
  let i = 0;
  return async () => answers[i++] ?? "exit";
}

/**
 * Mock model. `respond` returns a canned reply and records the messages it was
 * rendered with (so a test can assert the summary was injected). `summarize`
 * returns a fixed summary object.
 */
function createModel() {
  const respondCalls: AgentMessage[][] = [];
  const generateText: AgentRequestExecutor = async (request) => {
    // Requests carry their setupAgent({ requests }) key as `name`.
    if (request.name === "summarize") {
      // summarize request → structured { summary }
      return { output: { summary: "SUMMARY: prior facts folded in." } };
    }
    // respond request → plain text reply
    respondCalls.push(request.messages ?? []);
    return { output: `reply ${respondCalls.length}` };
  };
  return { generateText, respondCalls };
}

describe("context-compaction", () => {
  test("caps history at keepRecent and sets the summary once the window overflows", async () => {
    const { generateText } = createModel();

    // maxMessages=4, keepRecent=2. Each turn adds 2 messages (user + assistant),
    // so after turn 3 (6 messages) the window overflows and compaction runs.
    const result = await runAgent(contextCompactionMachine, {
      input: { maxMessages: 4, keepRecent: 2 },
      generateText,
      userInput: scriptedUserInput(["q1", "q2", "q3"]),
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;

    // Compaction kept only the last keepRecent (2) messages...
    expect(result.output.messages).toHaveLength(2);
    // ...which are the most recent user turn + its reply.
    expect(textContent(result.output.messages[0])).toBe("q3");
    expect(textContent(result.output.messages[1])).toBe("reply 3");
    // ...and the summary came from the summarize request.
    expect(result.output.summary).toBe("SUMMARY: prior facts folded in.");
    expect(result.output.turns).toBe(3);
  });

  test("respond after compaction receives the summary as a system message", async () => {
    const { generateText, respondCalls } = createModel();

    // Same overflow-then-one-more-turn script: turn 4 runs after compaction.
    await runAgent(contextCompactionMachine, {
      input: { maxMessages: 4, keepRecent: 2 },
      generateText,
      userInput: scriptedUserInput(["q1", "q2", "q3", "q4"]),
    });

    // Turns 1–3 ran before any summary existed; turn 4 ran after compaction.
    const postCompactionMessages = respondCalls[3] ?? [];
    const systemMsg = postCompactionMessages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(textContent(systemMsg)).toContain("SUMMARY: prior facts folded in.");

    // Earlier turns had no summary injected.
    expect((respondCalls[0] ?? []).some((m) => m.role === "system")).toBe(false);
  });

  test("'exit' ends with output containing turns and summary", async () => {
    const { generateText } = createModel();

    const result = await runAgent(contextCompactionMachine, {
      input: { maxMessages: 8, keepRecent: 4 },
      generateText,
      // One real turn, then exit immediately.
      userInput: scriptedUserInput(["hello", "exit"]),
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;

    expect(result.output.turns).toBe(1);
    // No overflow with maxMessages=8, so no compaction ran: summary stays null.
    expect(result.output.summary).toBeNull();
    expect(result.output).toHaveProperty("messages");
  });
});
