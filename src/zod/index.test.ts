import { describe, expect, test } from "vitest";
import { z } from "zod";
import { zodAgentMessages } from "./index.js";
import type { AgentMessage } from "../types.js";

describe("zodAgentMessages", () => {
  test("validates an array of messages and rejects a non-array", () => {
    const schema = zodAgentMessages();
    const messages: AgentMessage[] = [{ role: "user", content: "hi" }];
    expect(schema.parse(messages)).toEqual(messages);
    expect(() => schema.parse("nope")).toThrow();
  });

  test("composes inside a z.object context schema", () => {
    const context = z.object({ messages: zodAgentMessages() });
    expect(context.parse({ messages: [] })).toEqual({ messages: [] });
    // Type-level: `messages` infers as AgentMessage[].
    const parsed = context.parse({ messages: [{ role: "assistant", content: "ok" }] });
    const first: AgentMessage | undefined = parsed.messages[0];
    expect(first).toEqual({ role: "assistant", content: "ok" });
  });
});
