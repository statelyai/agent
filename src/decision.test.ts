import { describe, expect, test } from "vitest";
import { createDecisionRequest, renderDecisionAttempts, resolveDecision } from "./decision.js";

describe("renderDecisionAttempts", () => {
  const events = [
    { type: "ASK", toolName: "send_event_ASK" },
    { type: "GUESS", toolName: "send_event_GUESS" },
  ];

  test("returns [] when there are no attempts", () => {
    expect(renderDecisionAttempts({ events, attempts: [] })).toEqual([]);
  });

  test("renders one user message per attempt naming the reason and candidate types", () => {
    const messages = renderDecisionAttempts({
      events,
      attempts: [
        { failure: "unknown-event", reason: "'FOO' is not allowed." },
        { failure: "invalid-payload", reason: "bad payload" },
      ],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages[0]!.content).toContain("'FOO' is not allowed.");
    expect(messages[0]!.content).toContain("ASK, GUESS");
    expect(messages[1]!.content).toContain("bad payload");
  });

  test("uses (none) when there are no candidate events", () => {
    const [message] = renderDecisionAttempts({
      events: [],
      attempts: [{ failure: "unknown-event", reason: "nothing legal" }],
    });
    expect(message!.content).toContain("(none)");
  });
});

describe("createDecisionRequest", () => {
  test("keeps colliding sanitized tool names distinct", () => {
    const request = createDecisionRequest({
      model: "picker",
      prompt: "Pick one.",
      events: ["foo.bar", "foo/bar", "foo bar"],
    });
    const toolNames = request.events.map((event) => event.toolName);
    expect(new Set(toolNames).size).toBe(3);
    expect(toolNames[0]).toBe("send_event_foo_bar");
    expect(toolNames[1]).toBe("send_event_foo_bar_2");
    expect(toolNames[2]).toBe("send_event_foo_bar_3");
  });

  test("fills in kind, id, attempts, and tool names", () => {
    expect(
      createDecisionRequest({
        model: "reviewer",
        prompt: "Judge this draft.",
        events: ["APPROVE", "REVISE"],
      }),
    ).toEqual({
      kind: "decision",
      id: "decision",
      model: "reviewer",
      prompt: "Judge this draft.",
      events: [
        { type: "APPROVE", toolName: "send_event_APPROVE" },
        { type: "REVISE", toolName: "send_event_REVISE" },
      ],
      attempts: [],
    });
  });

  test("defaults the id to the name and passes descriptors through", () => {
    const request = createDecisionRequest({
      name: "judge",
      model: "reviewer",
      events: [{ type: "APPROVE", toolName: "approve_it" }],
      metadata: { round: 1 },
    });
    expect(request).toMatchObject({
      id: "judge",
      name: "judge",
      events: [{ type: "APPROVE", toolName: "approve_it" }],
      metadata: { round: 1 },
    });
  });

  test("keeps an explicit id and prior attempts", () => {
    const attempts = [{ failure: "rejected-by-guard" as const, reason: "over budget" }];
    expect(
      createDecisionRequest({ id: "d1", name: "judge", model: "m", events: [], attempts }),
    ).toMatchObject({ id: "d1", attempts });
  });

  test("resolves through resolveDecision without a hand-written literal", async () => {
    const chosen = await resolveDecision(
      createDecisionRequest({ name: "judge", model: "m", events: ["APPROVE", "REVISE"] }),
      { decide: async () => ({ event: { type: "REVISE" } }) },
    );
    expect(chosen).toEqual({ type: "REVISE" });
  });
});
