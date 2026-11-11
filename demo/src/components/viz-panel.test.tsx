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
  it("renders the /inspect page as soon as the room has the machine", () => {
    const html = renderPanel("https://editor.stately.ai/inspect?ws=wss%3A%2F%2Frelay&r=room");
    expect(html).toContain(
      'src="https://editor.stately.ai/inspect?ws=wss%3A%2F%2Frelay&amp;r=room"',
    );
    expect(html).toContain('allow="clipboard-read; clipboard-write"');
    expect(html).toContain('aria-label="Open full statechart for Test machine"');
  });

  it("waits on the machine reaching the room, not on a run", () => {
    const html = renderPanel(null);
    expect(html).toContain("Loading the statechart");
    expect(html).not.toContain("Start a run");
    expect(html).not.toContain("<iframe");
  });

  it("draws the outline immediately when the relay is unreachable", () => {
    const html = renderToStaticMarkup(
      <VizPanel
        title="Test machine"
        hasMachine
        inspectionUnavailable
        machineKey="scenario:test"
        machineConfig={{ id: "test", initial: "a", states: { a: {} } }}
        outlineConfig={{ id: "test", initial: "a", states: { a: {} } }}
        liveWs={null}
        liveUrl={null}
      />,
    );
    expect(html).toContain('aria-label="Statechart outline for Test machine"');
    expect(html).toContain('data-active="true"');
    expect(html).not.toContain("<iframe");
  });

  it("says so when the relay is unreachable and there is nothing to draw", () => {
    const html = renderPanel(null, true, true);
    expect(html).toContain("Live inspection unavailable");
    expect(html).not.toContain("<iframe");
  });

  it("says so when the example exports no machine", () => {
    const html = renderPanel(null, false);
    expect(html).toContain("No machine to inspect");
  });

  it("drops a previous selection's chart when the next example has no machine", () => {
    // A live URL alone must not keep an unrelated statechart on screen.
    const html = renderPanel(
      "https://editor.stately.ai/inspect?ws=wss%3A%2F%2Frelay&r=room",
      false,
    );
    expect(html).toContain("No machine to inspect");
    expect(html).not.toContain("<iframe");
  });
});
