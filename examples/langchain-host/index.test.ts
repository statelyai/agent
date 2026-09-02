import { describe, expect, test } from "vitest";
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { AgentIllegalResumeEventError } from "@statelyai/agent";
import {
  ScriptedChatModel,
  agentScript,
  createEmailHostAgent,
  createLangChainExecutors,
  jokeScript,
  machineScript,
  main,
  resumeDraft,
  runBridgeDemo,
  runJokeDemo,
  startDraft,
  toAgentUsage,
  toLangChainEventTools,
  toLangChainMessages,
  useModel,
  type ToolResult,
} from "./index.js";

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
  test("one scripted model drives streamText, structured generateText, and decide", async () => {
    const model = new ScriptedChatModel({ responses: jokeScript });
    const chunks: string[] = [];
    const output = await runJokeDemo(model, (chunk) => chunks.push(chunk));

    // Two jokes: the first attempt, then the improvement pass the machine
    // always takes before the decision.
    expect(output.jokes).toHaveLength(2);
    expect(output.firstJoke).toBe(output.jokes[0]);
    expect(output.joke).toBe(output.jokes[1]);
    expect(output.revisionNotice).toContain("First attempt scored 6/10");
    expect(output.lastRating).toBe(9);
    // Streaming really streamed: more than one chunk, reassembling to both jokes.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(output.jokes.join(""));
    // Five model calls: tell + rate twice, then decide (tool call).
    expect(model.calls).toBe(5);
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
    useModel(machineModel());
    const result = await startDraft("Tell the team the deploy pipeline is twice as fast.");

    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(result.handle).toMatch(/^draft-\d+$/);
    // The machine drove itself past the prompt and both model calls to the
    // human review pause; the host never named a state to get there.
    expect(result.draft?.subject).toBe("Deploy pipeline is faster");
    expect(result.interaction?.type).toBe("select");
  });

  test("the two tools run the machine to done and return JSON", async () => {
    const { started, finished } = await runBridgeDemo(machineModel());
    expect(started.status).toBe("pending");
    if (finished.status !== "done") throw new Error("expected done");
    expect(finished.sentEmails).toHaveLength(1);
    expect(finished.sentEmails[0]?.to).toBe("team@example.com");
  });

  test("revision text is routed to the field the interaction declared", async () => {
    useModel(new ScriptedChatModel({ responses: [...machineScript, machineScript[1]!] }));
    const started = await startDraft("Announce the faster deploys.");
    if (started.status !== "pending") throw new Error("expected pending");

    // REQUEST_CHANGES declares an input field (`changes`); the host derives that
    // from `meta.interaction` rather than hardcoding the event's payload shape.
    const revised = await resumeDraft(started.handle, "REQUEST_CHANGES", "Make it shorter.");
    expect(revised.status).toBe("pending");
    if (revised.status !== "pending") return;
    expect(revised.interaction?.type).toBe("select");
    expect(revised.draft).not.toBeNull();
  });

  test("the machine refuses an illegal resume", async () => {
    useModel(machineModel());
    const started = await startDraft("Announce the faster deploys.");
    if (started.status !== "pending") throw new Error("expected pending");

    // `SEND` is legal at `reviewing`, not after the email has already been sent.
    await resumeDraft(started.handle, "SEND");
    await expect(resumeDraft(started.handle, "SEND")).rejects.toBeInstanceOf(
      AgentIllegalResumeEventError,
    );
  });

  test("an unknown handle is rejected", async () => {
    useModel(machineModel());
    await expect(resumeDraft("draft-nope", "SEND")).rejects.toThrow(/Unknown handle/);
  });

  test("a real createAgent loop drives the machine through both tools", async () => {
    const agent = createEmailHostAgent(
      new ScriptedChatModel({ responses: agentScript }),
      machineModel(),
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

describe("langchain-host: demo", () => {
  test("the demo runs both directions end to end with no API key", async () => {
    await expect(main()).resolves.toBeUndefined();
  });
});
