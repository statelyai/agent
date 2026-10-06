import { describe, expect, test } from "vitest";
import type { AgentMessage, AgentRequestExecutor } from "@statelyai/agent";
import { getInteraction, createAgentRuntime, runToQuiescence } from "@statelyai/agent";
import {
  contextCompactionMachine,
  idlePrompt,
  latestReply,
  runContextCompactionExample,
} from "./index.js";

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
      return { result: { summary: "SUMMARY: prior facts folded in." } };
    }
    // respond request → plain text reply
    respondCalls.push(request.messages ?? []);
    return { result: `reply ${respondCalls.length}` };
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

  test("summarize sees the kept tail, so a follow-up to an old offer is not lost", async () => {
    // The offer lands in the stale slice; the turn that takes it up is kept
    // verbatim. The summarizer must see both to know the offer was taken.
    const summarizePrompts: string[] = [];
    const generateText: AgentRequestExecutor = async (request) => {
      if (request.name === "summarize") {
        summarizePrompts.push(request.prompt ?? "");
        return { result: { summary: "S" } };
      }
      const last = request.messages?.at(-1);
      return {
        result: last?.content === "q1" ? "Want a code example?" : "Here: const m = createMachine()",
      };
    };

    await runContextCompactionExample({
      input: { maxMessages: 4, keepRecent: 2 },
      generateText,
      userMessages: ["q1", "q2", "yes, show the code"],
    });

    expect(summarizePrompts).toHaveLength(1);
    const [old, recent] = summarizePrompts[0]!.split("RECENT MESSAGES");
    expect(old).toContain("assistant: Want a code example?");
    expect(recent).toContain("user: yes, show the code");
    expect(recent).toContain("assistant: Here: const m = createMachine()");
  });

  test("the summarizer is told to write in plain English", async () => {
    const systems: string[] = [];
    const generateText: AgentRequestExecutor = async (request) => {
      if (request.name === "summarize") {
        systems.push(request.system ?? "");
        return { result: { summary: "S" } };
      }
      return { result: "ok" };
    };
    await runContextCompactionExample({
      input: { maxMessages: 4, keepRecent: 2 },
      generateText,
      userMessages: ["q1", "q2", "q3"],
    });
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain("in English and plain words");
  });

  test("output includes a readable transcript string", async () => {
    const { generateText } = createModel();
    const result = await runContextCompactionExample({
      input: { maxMessages: 4, keepRecent: 2 },
      generateText,
      userMessages: ["q1", "q2", "q3"],
    });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output.transcript).toBe(
      "Summary of earlier conversation:\n\nSUMMARY: prior facts folded in.\n\n" +
        "Recent messages:\n\nuser: q3\n\nassistant: reply 3",
    );

    // Before any compaction the transcript is just the turns.
    const short = await runContextCompactionExample({
      generateText: createModel().generateText,
      userMessages: ["hello"],
    });
    if (short.status !== "done") return;
    expect(short.output.transcript).toBe("user: hello\n\nassistant: reply 1");
  });

  test("keepRecent: 0 is rejected — it would never shrink the window", async () => {
    const { generateText } = createModel();

    await expect(
      runToQuiescence(
        createAgentRuntime(contextCompactionMachine, {
          executors: { generateText },
        }),
        {
          input: { maxMessages: 4, keepRecent: 0 },
        },
      ),
    ).rejects.toThrow();
  });

  test("settles idle in awaitingUser with interaction meta a host can drive", async () => {
    const { generateText } = createModel();

    const first = await runToQuiescence(
      createAgentRuntime(contextCompactionMachine, {
        executors: { generateText },
      }),
      {
        input: { maxMessages: 4, keepRecent: 2 },
      },
    );

    // No invoke on `awaitingUser`, so the run settles idle there.
    expect(first.status).toBe("idle");
    if (first.status !== "idle") return;

    const interaction = getInteraction(first.snapshot);
    expect(interaction?.textEvent).toBe("USER_MESSAGE");
    expect(interaction?.events.map((choice) => choice.type)).toEqual(["USER_MESSAGE"]);
    // The label is a function of the context, rendered by `getInteraction`.
    expect(idlePrompt(first.snapshot)).toContain("turn 0");

    // Resuming from `result.persist()` with the text event advances one turn.
    const second = await runToQuiescence(
      createAgentRuntime(contextCompactionMachine, {
        executors: { generateText },
      }),
      {
        snapshot: first.persist(),
        event: { type: "USER_MESSAGE", text: "hello" },
      },
    );

    expect(second.status).toBe("idle");
    if (second.status !== "idle") return;
    expect(second.snapshot.context.turns).toBe(1);
    expect(textContent(second.snapshot.context.messages.at(-1))).toBe("reply 1");
    // A host reads the latest reply off `messages`; it is not mirrored in context.
    expect(latestReply(second.snapshot)).toBe("reply 1");
  });

  test("the latest reply is readable from messages, including across compaction", async () => {
    const { generateText } = createModel();

    // maxMessages=4, keepRecent=2: turn 3 overflows the window and compacts.
    const start = await runToQuiescence(
      createAgentRuntime(contextCompactionMachine, {
        executors: { generateText },
      }),
      {
        input: { maxMessages: 4, keepRecent: 2 },
      },
    );
    expect(start.status).toBe("idle");
    if (start.status !== "idle") return;
    let snapshot = start.persist();

    for (const turn of [1, 2, 3]) {
      const result = await runToQuiescence(
        createAgentRuntime(contextCompactionMachine, {
          executors: { generateText },
        }),
        {
          snapshot,
          event: { type: "USER_MESSAGE", text: `q${turn}` },
        },
      );
      expect(result.status).toBe("idle");
      if (result.status !== "idle") return;
      expect(latestReply(result.snapshot)).toBe(`reply ${turn}`);
      snapshot = result.persist();
    }

    // Turn 3 compacted (history capped at keepRecent) yet the reply survives.
    const final = await runToQuiescence(
      createAgentRuntime(contextCompactionMachine, {
        executors: { generateText },
      }),
      {
        snapshot,
        event: { type: "USER_MESSAGE", text: "exit" },
      },
    );
    expect(final.status).toBe("done");
    if (final.status !== "done") return;
    expect(final.output.summary).toBe("SUMMARY: prior facts folded in.");
  });
});
