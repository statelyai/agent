import { describe, expect, test } from "vitest";
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  createEmailHostAgent,
  createLangChainExecutors,
  resumeDraft,
  runAgentLoopDemo,
  runBridgeDemo,
  runJokeDemo,
  startDraft,
  toAgentUsage,
  toLangChainEventTools,
  toLangChainMessages,
  useModel,
  type ToolResult,
} from "./index.js";
import { createMockJudge } from "../mock-judge.js";
import { ScriptedChatModel, type ScriptedEntry, type ScriptedResponse } from "./scripted-model.js";

/**
 * A scripted LangChain model for a full run of the joke machine. The queue is
 * consumed in the order the *machine* asks, not in prompt order — the machine
 * owns the sequence, including the improvement pass it always takes before any
 * decision is requested.
 */
const jokeScript: ScriptedResponse[] = [
  // 1. `telling` streams the first joke.
  { text: "A state machine walks into a bar. It refuses the transition." },
  // 2. `telling` again: the machine always takes one improvement pass, so the
  //    writer gets the first joke plus the critique and rewrites it.
  { text: "A state machine walks into a bar. Illegal transition." },
  // 3. `deciding` forces one event tool. Event tools are named
  //    `send_event_<EVENT_TYPE>`, so ending the loop is `send_event_END`.
  { toolCall: { name: "send_event_END" } },
];

/**
 * The joke's rating is a Jev `score`, not a LangChain call: level 2 (6/10) for
 * the first joke, level 3 (8/10) for the rewrite.
 */
const jokeRatings = () => createMockJudge({ rating: [2, 3] }).model;

/** The drafter's prompt check is a Jev judgment: every request judged complete. */
const completeJudgment = () => createMockJudge({ "*": true }).model;

/** The handle from the most recent tool result — what a live model would read. */
function lastHandle(messages: BaseMessage[]): string {
  const toolMessage = [...messages].reverse().find((message) => message.getType() === "tool");
  return (JSON.parse(toolMessage?.text ?? "{}") as { handle?: string }).handle ?? "";
}

/** A scripted LangChain model for the *agent loop* (tool calls, then a summary). */
const agentScript: ScriptedEntry[] = [
  { toolCall: { name: "start_workflow", args: { prompt: "Tell the team deploys are faster." } } },
  (messages) => ({
    toolCall: {
      name: "resume_workflow",
      args: { handle: lastHandle(messages), eventType: "SEND", text: null },
    },
  }),
  (messages) => ({
    toolCall: {
      name: "resume_workflow",
      args: { handle: lastHandle(messages), eventType: "END", text: null },
    },
  }),
  { text: "Sent one email to team@example.com about the faster deploy pipeline." },
];

/**
 * A scripted LangChain model for the machine *inside* the tools. `evaluating`
 * is a Jev judgment (`completeJudgment`), so the only LangChain call per round
 * is the draft.
 */
const machineScript: ScriptedResponse[] = [
  // `drafting` — the draft itself.
  {
    structured: {
      result: {
        to: "team@example.com",
        subject: "Deploy pipeline is faster",
        body: "Hi team,\n\nThe deploy pipeline is now roughly twice as fast.\n\nThanks!",
      },
    },
  },
];

const machineModel = () => new ScriptedChatModel({ responses: machineScript });

describe("langchain-host: request mapping", () => {
  test("system + prompt become a SystemMessage and a HumanMessage", () => {
    const messages = toLangChainMessages({ system: "Be terse.", prompt: "Hi" });
    expect(messages.map((message) => message.getType())).toEqual(["system", "human"]);
    expect(SystemMessage.isInstance(messages[0]!)).toBe(true);
    expect(messages[1]!.text).toBe("Hi");
  });

  test("an AgentMessage list maps role-for-role, tool parts one message each", () => {
    const messages = toLangChainMessages({
      messages: [
        { role: "user", content: "draft it" },
        { role: "assistant", content: "ok" },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "t",
              output: { type: "text", value: "done" },
            },
          ],
        },
      ],
    });
    expect(messages.map((message) => message.getType())).toEqual(["human", "ai", "tool"]);
    expect(ToolMessage.isInstance(messages[2]!)).toBe(true);
    expect(messages[2]!.text).toBe("done");
  });

  test("each candidate event becomes one tool spec", () => {
    const tools = toLangChainEventTools([
      { type: "END", toolName: "send_event_END" },
      { type: "TELL_ANOTHER", toolName: "send_event_TELL_ANOTHER" },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["send_event_END", "send_event_TELL_ANOTHER"]);
    expect(tools[0]!.description).toContain("END");
  });

  test("LangChain usage_metadata maps onto AgentUsage field names", () => {
    expect(
      toAgentUsage({ usage_metadata: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } }),
    ).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    expect(toAgentUsage({})).toBeUndefined();
  });
});

describe("langchain-host: Direction A (LangChain model as executor)", () => {
  test("one scripted model drives streamText and decide while Jev rates", async () => {
    const model = new ScriptedChatModel({ responses: jokeScript });
    const chunks: string[] = [];
    const output = await runJokeDemo(model, (chunk) => chunks.push(chunk), jokeRatings());

    // Two jokes: the first attempt, then the improvement pass the machine
    // always takes before the decision.
    expect(output.jokes).toHaveLength(2);
    expect(output.firstJoke).toBe(output.jokes[0]);
    expect(output.joke).toBe(output.jokes[1]);
    expect(output.revisionNotice).toContain("First attempt scored 6/10");
    expect(output.lastRating).toBe(8);
    // Streaming really streamed: more than one chunk, reassembling to both jokes.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(output.jokes.join(""));
    // Three LangChain calls: tell twice, then decide (tool call).
    expect(model.calls).toBe(3);
  });

  test("the machine, not the model, ends the loop — decide returns the chosen event", async () => {
    const { decide } = createLangChainExecutors({
      model: new ScriptedChatModel({ responses: [{ toolCall: { name: "send_event_END" } }] }),
    });
    await expect(
      decide({
        kind: "decision",
        id: "d1",
        name: "chooseNext",
        model: "critic",
        prompt: "stop or go",
        events: [
          { type: "END", toolName: "send_event_END" },
          { type: "TELL_ANOTHER", toolName: "send_event_TELL_ANOTHER" },
        ],
        attempts: [],
      }),
    ).resolves.toEqual({ event: { type: "END" } });
  });

  test("decide rejects a tool the machine never offered", async () => {
    const { decide } = createLangChainExecutors({
      model: new ScriptedChatModel({ responses: [{ toolCall: { name: "send_event_NOPE" } }] }),
    });
    await expect(
      decide({
        kind: "decision",
        id: "d1",
        name: "chooseNext",
        model: "critic",
        prompt: "stop or go",
        events: [{ type: "END", toolName: "send_event_END" }],
        attempts: [],
      }),
    ).rejects.toThrow(/unknown tool 'send_event_NOPE'/);
  });
});

describe("langchain-host: Direction B (machine as a LangChain tool)", () => {
  test("start_workflow drafts and pauses for review", async () => {
    useModel(machineModel(), completeJudgment());
    const result = await startDraft("Tell the team the deploy pipeline is twice as fast.");

    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(result.handle).toMatch(/^draft-\d+$/);
    // The machine drove itself past the prompt and both model calls to the
    // human review pause; the host never named a state to get there.
    expect(result.draft?.subject).toBe("Deploy pipeline is faster");
    expect(result.interaction?.events.map(({ type }) => type)).toEqual(["SEND", "REQUEST_CHANGES"]);
    expect(result.interaction?.textEvent).toBe("REQUEST_CHANGES");
  });

  test("the two tools run the machine to done and return JSON", async () => {
    const { started, finished } = await runBridgeDemo(machineModel(), completeJudgment());
    expect(started.status).toBe("pending");
    if (finished.status !== "done") throw new Error("expected done");
    expect(finished.sentEmails).toHaveLength(1);
    expect(finished.sentEmails[0]?.to).toBe("team@example.com");
  });

  test("revision text is delivered through the interaction's declared textEvent", async () => {
    useModel(
      new ScriptedChatModel({ responses: [...machineScript, machineScript[0]!] }),
      completeJudgment(),
    );
    const started = await startDraft("Announce the faster deploys.");
    if (started.status !== "pending") throw new Error("expected pending");

    // REQUEST_CHANGES is the reviewing pause's `textEvent`, so the host attaches
    // the text to it without hardcoding the event's payload shape.
    const revised = await resumeDraft(started.handle, "REQUEST_CHANGES", "Make it shorter.");
    expect(revised.status).toBe("pending");
    if (revised.status !== "pending") return;
    expect(revised.interaction?.textEvent).toBe("REQUEST_CHANGES");
    expect(revised.draft).not.toBeNull();
  });

  test("an event the state does not handle is ignored", async () => {
    useModel(machineModel(), completeJudgment());
    const started = await startDraft("Announce the faster deploys.");
    if (started.status !== "pending") throw new Error("expected pending");

    // `SEND` is handled at `reviewing`, not after the email has already been
    // sent: the machine ignores the second one and the bridge reports it.
    await resumeDraft(started.handle, "SEND");
    await expect(resumeDraft(started.handle, "SEND")).rejects.toThrow(/'SEND' does not apply/);
  });

  test("an unknown handle is rejected", async () => {
    useModel(machineModel(), completeJudgment());
    await expect(resumeDraft("draft-nope", "SEND")).rejects.toThrow(/Unknown handle/);
  });

  test("a real createAgent loop drives the machine through both tools", async () => {
    const agent = createEmailHostAgent(
      new ScriptedChatModel({ responses: agentScript }),
      machineModel(),
      completeJudgment(),
    );
    const result = await agent.invoke({
      messages: [new HumanMessage("Tell the team deploys are faster, send it, then we're done.")],
    });

    const toolResults = result.messages
      .filter((message) => message.getType() === "tool")
      .map((message) => JSON.parse(message.text) as ToolResult);
    expect(toolResults).toHaveLength(3);
    expect(toolResults[0]?.status).toBe("pending");
    const last = toolResults.at(-1)!;
    if (last.status !== "done") throw new Error("expected the machine to finish");
    expect(last.sentEmails).toHaveLength(1);
    expect(result.messages.at(-1)?.text).toContain("team@example.com");
  });
});

describe("langchain-host: playthrough", () => {
  test("both directions run end to end against scripted LangChain models and Jev", async () => {
    const jokeOutput = await runJokeDemo(
      new ScriptedChatModel({ responses: jokeScript }),
      undefined,
      jokeRatings(),
    );
    expect(jokeOutput.lastRating).toBe(8);

    const reply = await runAgentLoopDemo(
      new ScriptedChatModel({ responses: agentScript }),
      machineModel(),
      "Tell the team deploys are faster, send it, then we're done.",
      completeJudgment(),
    );
    expect(reply).toContain("team@example.com");
  });
});
