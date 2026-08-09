import { describe, expect, test } from "vitest";
import type { AgentMessage, AgentRequestExecutor } from "@statelyai/agent";
import { getStateMeta, runAgent } from "@statelyai/agent";
import { contextCompactionMachine, idlePrompt, runContextCompactionExample } from "./index.js";

function textContent(message: AgentMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
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
    const result = await runContextCompactionExample({
      input: { maxMessages: 4, keepRecent: 2 },
      generateText,
      userMessages: ["q1", "q2", "q3"],
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
    await runContextCompactionExample({
      input: { maxMessages: 4, keepRecent: 2 },
      generateText,
      userMessages: ["q1", "q2", "q3", "q4"],
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

    const result = await runContextCompactionExample({
      input: { maxMessages: 8, keepRecent: 4 },
      generateText,
      // One real turn, then exit immediately.
      userMessages: ["hello", "exit"],
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;

    expect(result.output.turns).toBe(1);
    // No overflow with maxMessages=8, so no compaction ran: summary stays null.
    expect(result.output.summary).toBeNull();
    expect(result.output).toHaveProperty("messages");
  });

  test("settles idle in awaitingUser with interaction meta a host can drive", async () => {
    const { generateText } = createModel();

    const first = await runAgent(contextCompactionMachine, {
      input: { maxMessages: 4, keepRecent: 2 },
      executors: { generateText },
    });

    // No invoke on `awaitingUser`, so the run settles idle there.
    expect(first.status).toBe("idle");
    if (first.status !== "idle") return;

    const interaction = getStateMeta(first.snapshot).interaction;
    expect(interaction?.textEvent).toBe("USER_MESSAGE");
    expect(interaction?.events?.USER_MESSAGE).toBeDefined();
    // Labels interpolate `{contextKey}` against the snapshot context.
    expect(idlePrompt(first.snapshot)).toContain("turn 0");

    // Resuming from `persistedSnapshot` with the text event advances one turn.
    const second = await runAgent(contextCompactionMachine, {
      snapshot: first.persistedSnapshot,
      event: { type: "USER_MESSAGE", text: "hello" },
      executors: { generateText },
    });

    expect(second.status).toBe("idle");
    if (second.status !== "idle") return;
    expect(second.snapshot.context.turns).toBe(1);
    expect(textContent(second.snapshot.context.messages.at(-1))).toBe("reply 1");
    // Mirrored out of `messages` so a context-rendering host can show it.
    expect(second.snapshot.context.reply).toBe("reply 1");
  });

  test("context.reply tracks the latest answer, including across compaction", async () => {
    const { generateText } = createModel();

    // maxMessages=4, keepRecent=2: turn 3 overflows the window and compacts.
    const start = await runAgent(contextCompactionMachine, {
      input: { maxMessages: 4, keepRecent: 2 },
      executors: { generateText },
    });
    expect(start.status).toBe("idle");
    if (start.status !== "idle") return;
    let snapshot = start.persistedSnapshot;

    for (const turn of [1, 2, 3]) {
      const result = await runAgent(contextCompactionMachine, {
        snapshot,
        event: { type: "USER_MESSAGE", text: `q${turn}` },
        executors: { generateText },
      });
      expect(result.status).toBe("idle");
      if (result.status !== "idle") return;
      expect(result.snapshot.context.reply).toBe(`reply ${turn}`);
      snapshot = result.persistedSnapshot;
    }

    // Turn 3 compacted (history capped at keepRecent) yet the reply survives.
    const final = await runAgent(contextCompactionMachine, {
      snapshot,
      event: { type: "USER_MESSAGE", text: "exit" },
      executors: { generateText },
    });
    expect(final.status).toBe("done");
    if (final.status !== "done") return;
    expect(final.output.summary).toBe("SUMMARY: prior facts folded in.");
  });
});
