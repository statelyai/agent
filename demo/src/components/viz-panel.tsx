import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCcw } from "lucide-react";
import type { Scenario } from "@/lib/scenarios";
import { scenarioVizConfig } from "@/lib/scenarios";
import { getTargetOrigin, isTrustedVizMessage } from "@/lib/viz-transport";
import { Button } from "@/components/ui/button";
import type { VizFrame } from "@/hooks/use-trace-player";

const defaultVizUrl = "https://editor.stately.ai/embed?auth=message";

type VizPanelProps = {
  scenario: Scenario;
  frame: VizFrame;
};

export function VizPanel({ scenario, frame }: VizPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const latestRef = useRef({ scenario, frame });
  const [ready, setReady] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const vizUrl = import.meta.env.VITE_VIZ_URL || defaultVizUrl;
  const targetOrigin = useMemo(() => getTargetOrigin(vizUrl), [vizUrl]);

  latestRef.current = { scenario, frame };

  const post = useCallback(
    (message: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage(message, targetOrigin);
    },
    [targetOrigin],
  );

  // The `@statelyai.init` machine is the REAL machine's config, serialized.
  const initMessage = useCallback(
    (id: Scenario["id"]) => ({
      type: "@statelyai.init",
      machine: scenarioVizConfig[id],
      mode: "inspecting",
      theme: "light",
      readOnly: true,
      capabilities: {
        edit: false,
        export: false,
        ai: false,
        simulate: false,
        inspect: true,
        navigateHierarchy: false,
        maxDepth: 2,
        panels: [],
      },
      leftPanels: [],
      rightPanels: [],
      activePanels: [],
    }),
    [],
  );

  const initialize = useCallback(() => {
    const latest = latestRef.current;
    post(initMessage(latest.scenario.id));
    post({
      type: "@statelyai.inspectSnapshot",
      snapshot: { value: latest.frame.value, status: latest.frame.status, context: latest.frame.context },
      event: latest.frame.event,
    });
  }, [initMessage, post]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isTrustedVizMessage(event, iframeRef.current?.contentWindow ?? null, targetOrigin)) return;
      if (event.data?.type === "@statelyai.ready") {
        setReady(true);
        setTimedOut(false);
        initialize();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [initialize, targetOrigin, frameKey]);

  // Re-init when the scenario changes.
  useEffect(() => {
    if (!ready) return;
    post(initMessage(scenario.id));
  }, [initMessage, post, ready, scenario.id]);

  // Replay each frame as an inspected snapshot.
  useEffect(() => {
    if (!ready) return;
    post({
      type: "@statelyai.inspectSnapshot",
      snapshot: { value: frame.value, status: frame.status, context: frame.context },
      event: frame.event,
    });
  }, [frame, post, ready]);

  useEffect(() => {
    setReady(false);
    setTimedOut(false);
    const timeout = window.setTimeout(() => setTimedOut(true), 9000);
    return () => window.clearTimeout(timeout);
  }, [frameKey, vizUrl]);

  const retry = () => {
    setReady(false);
    setTimedOut(false);
    setFrameKey((current) => current + 1);
  };

  return (
    <section className="work-panel viz-panel" aria-labelledby="viz-panel-title">
      <div className="panel-heading viz-heading">
        <div>
          <span className="panel-kicker">Live machine</span>
          <h2 id="viz-panel-title">Statechart</h2>
        </div>
        <div className="live-status" data-ready={ready || undefined}>
          <span aria-hidden="true" />
          {ready ? (frame.event ? `event · ${frame.event.type}` : "connected") : "connecting"}
        </div>
      </div>

      <div className="viz-frame-wrap">
        {!ready && !timedOut && (
          <div className="viz-loading" aria-label="Connecting to Stately Viz">
            <span className="viz-loading__mark" />
            <span>Connecting to Viz…</span>
          </div>
        )}
        {timedOut && !ready && (
          <div className="viz-error">
            <span className="offline-mark" aria-hidden="true" />
            <strong>Viz did not connect</strong>
            <p>Check the embed URL or run the local Viz app.</p>
            <div>
              <Button size="sm" onClick={retry}>
                <RefreshCcw size={14} /> Retry
              </Button>
              <a href={vizUrl} target="_blank" rel="noreferrer">
                Open Viz <ExternalLink size={13} />
              </a>
            </div>
          </div>
        )}
        <iframe
          key={frameKey}
          ref={iframeRef}
          className="viz-frame"
          data-ready={ready || undefined}
          title={`Live statechart for ${scenario.name}`}
          src={vizUrl}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="strict-origin"
        />
      </div>
    </section>
  );
}
