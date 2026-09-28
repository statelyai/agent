import { describe, expect, test } from "vitest";
import { renderIdleWork, renderOutput } from "./render-value";

describe("readable rendering of common shapes", () => {
  test("multi-line strings keep their lines instead of collapsing", () => {
    expect(renderOutput("To: Priya\nSubject: Friday\n\nHi Priya,\nSee you then.")).toBe(
      "To: Priya  \nSubject: Friday\n\nHi Priya,  \nSee you then.",
    );
    // Text that carries its own code fence is already markdown.
    expect(renderOutput("Run:\n```sh\nnpm test\n```")).toBe("Run:\n```sh\nnpm test\n```");
  });

  test("a flat object reads as labeled lines, long text as its own paragraph", () => {
    const text = renderIdleWork(
      {
        draft: { to: "Priya", subject: "Moving the review", body: "Hi Priya,\nCan we do Friday?" },
      },
      ["draft"],
    );
    expect(text).toBe(
      "**Draft**\n\n**To**: Priya  \n**Subject**: Moving the review\n\n**Body**\n\nHi Priya,  \nCan we do Friday?",
    );
  });

  test("arrays of strings are bullets; arrays of numbers one line", () => {
    const text = renderOutput({
      selectedModules: ["Break the problem down", "List the key assumptions"],
      pages: [1, 4, 7],
    });
    expect(text).toContain(
      "**Selected modules**\n\n- Break the problem down\n- List the key assumptions",
    );
    expect(text).toContain("**Pages**\n\n1, 4, 7");
  });

  test("records sharing a few short fields become a compact table", () => {
    const text = renderIdleWork(
      {
        results: [
          { page: 1, correct: true, answer: "A | B" },
          { page: 4, correct: false, answer: "C" },
        ],
      },
      ["results"],
    );
    expect(text).toBe(
      [
        "**Results**",
        "",
        "| Page | Correct | Answer |",
        "| --- | --- | --- |",
        "| 1 | true | A \\| B |",
        "| 4 | false | C |",
      ].join("\n"),
    );
  });

  test("records with long fields become one bullet each, long values continued below", () => {
    const content =
      "A state machine is in exactly one of a finite set of states at a time. ".repeat(2);
    const text = renderIdleWork(
      {
        chunks: [
          { documentId: "statecharts", pageNumber: 1, content },
          { documentId: "statecharts", pageNumber: 4, content },
        ],
      },
      ["chunks"],
    )!;
    expect(text.startsWith("**Chunks**\n\n- Document id: statecharts · Page number: 1  \n")).toBe(
      true,
    );
    expect(text).toContain(`\n  Content: ${content.trim()}\n- Document id`);
    expect(text).not.toContain("```");
  });

  test("chat message arrays read as a transcript without SDK internals", () => {
    const text = renderOutput({
      turns: 2,
      messages: [
        { role: "user", content: "Refund order #8891" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Issuing it now.", providerOptions: { openai: { id: "x" } } },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "refund",
              input: { orderId: "8891" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "refund",
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
      ],
    });
    expect(text).toBe(
      [
        "- Turns: 2",
        "**Messages**",
        "**User:** Refund order #8891",
        '**Assistant:** Issuing it now.  \n→ refund({"orderId":"8891"})',
        '**Tool:** ← refund: {"ok":true}',
      ].join("\n\n"),
    );
    expect(text).not.toContain("providerOptions");
    expect(text).not.toContain("call_1");
  });

  test("JSON text reads as the structure it holds", () => {
    const text = renderOutput({
      answer: "A kite.",
      reasoningStructure: '{"step 1": "count the vertices", "step 2": "compare sides"}',
    });
    expect(text).toBe(
      "A kite.\n\n**Reasoning structure**\n\n**Step 1**: count the vertices  \n**Step 2**: compare sides",
    );
  });

  test("structure deeper than the renderer reads falls back to fenced JSON", () => {
    const text = renderOutput({
      persisted: { context: { order: { id: "ORD-1", lines: { first: 1 } } } },
    });
    expect(text).toContain("**Persisted**");
    expect(text).toContain("```json");
    expect(text).toContain('"first": 1');
  });

  test("long lists are capped and counted", () => {
    const text = renderIdleWork(
      { items: Array.from({ length: 25 }, (_, index) => `item ${index}`) },
      ["items"],
    )!;
    // The section title, a blank line, 20 items, and the count of the rest.
    expect(text.split("\n")).toHaveLength(23);
    expect(text.endsWith("- … 5 more")).toBe(true);
  });
});
