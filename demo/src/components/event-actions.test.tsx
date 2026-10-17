import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatIdle } from "@/lib/machine-ui";
import { EventActions } from "./event-actions";

describe("EventActions payload choices", () => {
  const idle: ChatIdle = {
    prompt: "Who is it?",
    events: [
      {
        type: "ACCUSE",
        label: "Accuse",
        style: "default",
        jsonSchema: null,
        needsPayload: true,
        coveredByChoices: true,
      },
      { type: "PASS", label: "Pass", style: "default", jsonSchema: null, needsPayload: false },
    ],
    choices: [
      { label: "Seat 1", style: "danger", event: { type: "ACCUSE", seat: 1 } },
      { label: "Seat 2", style: "default", event: { type: "ACCUSE", seat: 2 } },
    ],
    textEvent: null,
    component: null,
  };

  it("renders one button per choice and hides the event types they cover", () => {
    const html = renderToStaticMarkup(<EventActions idle={idle} onSendEvent={() => {}} />);
    expect(html).toContain('data-kind="danger">Seat 1</button>');
    expect(html).toContain(">Seat 2</button>");
    expect(html).toContain(">Pass</button>");
    expect(html).not.toContain("Accuse");
  });
});
