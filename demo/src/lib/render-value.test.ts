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
        "| 1 | yes | A \\| B |",
        "| 4 | no | C |",
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

describe("nothing said twice", () => {
  const draft = {
    to: "priya@example.com",
    subject: "Moving the review",
    body: "Hi Priya,\nCould we move the review to Friday?\n\nBest,\nSam",
  };
  const draftMessages = [
    { role: "user", content: "Email Priya to move the review to Friday" },
    {
      role: "assistant",
      content: `To: ${draft.to}\n\nSubject: ${draft.subject}\n\n${draft.body}`,
    },
  ];

  test("a message log next to a readable field is not rendered (email-drafter)", () => {
    const text = renderIdleWork({ draft, messages: draftMessages, revisions: 0 }, [
      "messages",
      "draft",
    ])!;
    expect(text).toContain("**Draft**");
    expect(text).not.toContain("**Messages**");
    expect(text.match(/Could we move the review/g)).toHaveLength(1);
  });

  test("a reply field and a role-line transcript show the reply once (long-term-memory)", () => {
    const reply = "Nice to meet you, Ada. I'll remember you prefer tea.";
    const text = renderIdleWork(
      {
        reply,
        transcript: ["User: I'm Ada and I prefer tea.", `Assistant: ${reply}`],
        memories: ["Ada prefers tea"],
      },
      ["transcript", "reply", "memories"],
    )!;
    expect(text).not.toContain("**Transcript**");
    expect(text.split(reply)).toHaveLength(2);
  });

  test("an answer and the history holding it render once (review-tool-calls)", () => {
    const messages = [
      { role: "user", content: "What is 6 times 7?" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "calculate", input: {} }],
      },
      { role: "assistant", content: [{ type: "text", text: "42" }] },
    ];
    expect(renderIdleWork({ answer: "42", messages, turns: 1 }, ["answer", "messages"])).toBe("42");
    // Output: the same rule — the answer leads, no transcript under it.
    const output = renderOutput({ answer: "6 × 7 is 42.", messages });
    expect(output).toBe("6 × 7 is 42.");
  });

  test("a message log that is the only content still renders", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello! How can I help?" },
    ];
    expect(renderIdleWork({ messages }, ["messages"])).toBe("Hello! How can I help?");
    expect(renderOutput({ messages, turns: 1 })).toContain("**Assistant:** Hello! How can I help?");
  });

  test("identical strings render once", () => {
    const text = renderOutput({ reply: "Thanks, we reset it.", draft: "Thanks, we reset it." });
    expect(text).toBe("Thanks, we reset it.");
    const work = renderIdleWork({ draft: "Thanks, we reset it.", final: "Thanks, we reset it." }, [
      "draft",
      "final",
    ]);
    expect(work).toBe("Thanks, we reset it.");
  });

  test("text the idle prompt already says is not repeated as work", () => {
    const prompt = "Approve this reply? We have reset your password.";
    expect(
      renderIdleWork({ reply: "We have reset your password." }, ["reply"], [], prompt),
    ).toBeNull();
    expect(renderIdleWork({ reply: "Something new." }, ["reply"], [], prompt)).toBe(
      "Something new.",
    );
  });

  test("an output string an earlier turn showed is left out, unless it is all there is", () => {
    const reply = "Hi, try resetting your password from the login page.";
    expect(renderOutput({ resolution: "replied", reply }, [reply])).toBe("- Resolution: replied");
    expect(renderOutput({ reply }, [reply])).toBe(reply);
  });
});

describe("list layout", () => {
  test("multi-line strings in list items keep their line breaks (sent emails)", () => {
    const text = renderOutput({
      sentEmails: [
        {
          to: "priya@example.com",
          subject: "Moving the review",
          body: "Hi Priya,\nWould Friday work?\n\nBest,\nSam",
        },
      ],
    });
    expect(text).toBe(
      [
        "**Sent emails**",
        "",
        "- To: priya@example.com · Subject: Moving the review  ",
        "  Body:  ",
        "  Hi Priya,  ",
        "  Would Friday work?",
        "",
        "  Best,  ",
        "  Sam",
      ].join("\n"),
    );
  });

  test("multi-line strings in a string list keep their line breaks", () => {
    expect(renderOutput({ notes: ["First line\nsecond line", "Short"] })).toBe(
      "**Notes**\n\n- First line  \n  second line\n- Short",
    );
  });

  test("a field long in any item is a continuation line in every item (checkpoints)", () => {
    const text = renderIdleWork(
      {
        checkpoints: [
          { title: "States", keyIdea: "One state at a time." },
          {
            title: "Transitions",
            keyIdea:
              "An event moves the machine from one state to another only when a transition for it exists.",
          },
          {
            title: "Guards",
            keyIdea:
              "A guard is a condition that must hold for its transition to be taken, checked on each event.",
          },
        ],
      },
      ["checkpoints"],
    )!;
    const bullets = text.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets).toEqual(["- Title: States  ", "- Title: Transitions  ", "- Title: Guards  "]);
    expect(text).toContain("- Title: States  \n  Key idea: One state at a time.");
  });

  test("a trailing newline does not push a field onto its own line (jokes)", () => {
    const text = renderIdleWork(
      {
        jokes: [
          { branch: 0, subject: "cats", joke: "Cats rule." },
          { branch: 1, subject: "dogs", joke: "Dogs drool.\n" },
          { branch: 2, subject: "owls", joke: "Owls hoot." },
          { branch: 3, subject: "bees", joke: "Bees buzz.", rating: 5, extra: "x", more: 1 },
        ],
      },
      ["jokes"],
    )!;
    expect(text).toContain("- Branch: 1 · Subject: dogs · Joke: Dogs drool.\n");
  });

  test("records of short values stay one compact line each", () => {
    const text = renderOutput({
      scores: [
        { name: "a", score: 1 },
        { name: "b", score: 2, bonus: 3 },
      ],
    });
    expect(text).toBe("**Scores**\n\n- Name: a · Score: 1\n- Name: b · Score: 2 · Bonus: 3");
  });
});

describe("booleans read as yes/no", () => {
  test("in tables, bullets, fields and output lines", () => {
    const table = renderIdleWork(
      {
        clues: [
          { player: "Ana", clue: "fruit", struck: false },
          { player: "Ben", clue: "apple", struck: true },
        ],
      },
      ["clues"],
    )!;
    expect(table).toContain("| Ana | fruit | no |");
    expect(table).toContain("| Ben | apple | yes |");
    expect(renderOutput({ sent: true, flags: [true, false] })).toBe(
      "- Sent: yes\n\n**Flags**\n\nyes, no",
    );
    expect(renderIdleWork({ result: { approved: false } }, ["result"])).toBe(
      "**Result**\n\n**Approved**: no",
    );
  });
});
