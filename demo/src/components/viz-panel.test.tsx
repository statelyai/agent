import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VizPanel } from "./viz-panel";

const frame = {
  value: "idle",
  status: "active" as const,
  context: {},
  event: { type: "xstate.init" },
};

function renderPanel(liveUrl: string | null) {
  return renderToStaticMarkup(
    <VizPanel
      title="Test machine"
      machineKey="test"
      vizConfig={{ id: "test" }}
      frame={frame}
      liveWs={null}
      liveUrl={liveUrl}
      theme="light"
      documents={[]}
    />,
  );
}

describe("VizPanel iframe permissions", () => {
  it.each([
    ["embedded Viz", null],
    ["live inspection", "https://editor.stately.ai/inspect"],
  ])("allows clipboard access for %s", (_mode, liveUrl) => {
    expect(renderPanel(liveUrl)).toContain('allow="clipboard-read; clipboard-write"');
  });
});
