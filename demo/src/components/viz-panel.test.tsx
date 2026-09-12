import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VizPanel } from "./viz-panel";

function renderPanel(liveUrl: string | null, hasMachine = true, inspectionUnavailable = false) {
  return renderToStaticMarkup(
    <VizPanel
      title="Test machine"
      hasMachine={hasMachine}
      inspectionUnavailable={inspectionUnavailable}
      liveWs={null}
      liveUrl={liveUrl}
    />,
  );
}

describe("VizPanel", () => {
  it("renders the /inspect page when a run is live", () => {
    const html = renderPanel("https://editor.stately.ai/inspect?ws=wss%3A%2F%2Frelay&r=room");
    expect(html).toContain('src="https://editor.stately.ai/inspect?ws=wss%3A%2F%2Frelay&amp;r=room"');
    expect(html).toContain('allow="clipboard-read; clipboard-write"');
  });

  it("waits for a run before showing the statechart", () => {
    const html = renderPanel(null);
    expect(html).toContain("Start a run to inspect");
    expect(html).not.toContain("<iframe");
  });

  it("says so when a run started without an inspection relay", () => {
    const html = renderPanel(null, true, true);
    expect(html).toContain("Live inspection unavailable");
    expect(html).not.toContain("<iframe");
  });

  it("says so when the example exports no machine", () => {
    const html = renderPanel(null, false);
    expect(html).toContain("No machine to inspect");
  });
});
