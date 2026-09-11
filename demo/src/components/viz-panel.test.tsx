import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VizPanel } from "./viz-panel";

const frame = {
  value: "idle",
  status: "active" as const,
  context: {},
  event: { type: "xstate.init" },
};

function renderPanel(liveUrl: string | null, vizConfig: unknown = { id: "test" }) {
  return renderToStaticMarkup(
    <VizPanel
      title="Test machine"
      machineKey="test"
      vizConfig={vizConfig}
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

describe("VizPanel embed lifetime", () => {
  it("keeps the embed mounted while there is no machine (detail still loading)", () => {
    // Unmounting would reload the whole editor on every example switch.
    const html = renderPanel(null, null);
    expect(html).toContain("No machine to inspect");
    expect(html).toContain("<iframe");
    expect(html).not.toContain("data-ready");
  });
});
