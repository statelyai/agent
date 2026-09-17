import { useEffect, useState } from "react";
import { createWebSocketTransport } from "@statelyai/sdk";
import { StateOutline } from "@/components/state-outline";

export type LiveWs = { relayUrl: string; roomId: string };

/** A message from the inspection relay's `@statelyai.system.*` stream. */
export type SystemMessage = Record<string, unknown> & {
  type: string;
  actors?: Array<{
    sessionId: string;
    actorId: string;
    parentSessionId: string | null;
    machine?: unknown;
    snapshot?: unknown;
  }>;
  actorId?: string;
  sessionId?: string;
  parentSessionId?: string | null;
  machine?: unknown;
  snapshot?: unknown;
  event?: unknown;
};

type VizPanelProps = {
  /** Display name of the machine being inspected. */
  title: string;
  /** Whether the selected example exports a machine at all. */
  hasMachine: boolean;
  /** The inspection relay was reached for and never became available. */
  inspectionUnavailable?: boolean;
  /**
   * Plain-JSON machine config for the static outline shown when the relay is
   * unavailable. Null when the selected machine has no JSON view.
   */
  outlineConfig?: Record<string, unknown> | null;
  /** The latest snapshot `value` of the run, for the outline's active state. */
  outlineValue?: unknown;
  /**
   * Live inspection relay. The panel joins the room as a viewer purely to
   * mirror the stream to `onSystemMessage` — the /inspect page connects to the
   * relay itself for rendering.
   */
  liveWs: LiveWs | null;
  /**
   * Full viz `/inspect` page URL, pointed at the current inspection room.
   * Null until the selected machine has been published to that room.
   */
  liveUrl: string | null;
  /**
   * Mirror of the live `@statelyai.system.*` stream, so siblings (the chat's
   * interleaved transition log) can observe the run without a second socket.
   */
  onSystemMessage?: (message: SystemMessage) => void;
};

export function VizPanel({
  title,
  hasMachine,
  inspectionUnavailable = false,
  outlineConfig = null,
  outlineValue = null,
  liveWs,
  liveUrl,
  onSystemMessage,
}: VizPanelProps) {
  // The server may reach the relay while this browser cannot (a corporate
  // proxy, an offline demo). The viewer socket below is the canary: if it is
  // not ready within a few seconds, or errors, the embed would be blank too,
  // so the static outline takes the pane instead.
  const [socketUnavailable, setSocketUnavailable] = useState(false);

  // The hosted /inspect page renders the system; this socket exists only so
  // the chat's transition log can follow the same run.
  useEffect(() => {
    if (!liveWs) return;
    setSocketUnavailable(false);
    const transport = createWebSocketTransport({
      url: liveWs.relayUrl,
      role: "viewer",
      metadata: { name: "Stately Agent Lab" },
    });
    const deadline = window.setTimeout(() => {
      if (!transport.ready) setSocketUnavailable(true);
    }, 6000);
    const unsubscribeReady = transport.onReady(() => {
      window.clearTimeout(deadline);
      setSocketUnavailable(false);
    });
    const unsubscribeError = transport.onError?.(() => setSocketUnavailable(true));
    const unsubscribeMessage = transport.onMessage((protocolMessage) => {
      const message = protocolMessage as SystemMessage;
      if (message.type === "@statelyai.system.init") {
        if (Array.isArray(message.actors)) onSystemMessage?.(message);
      } else if (message.type.startsWith("@statelyai.system.")) {
        onSystemMessage?.(message);
      }
    });
    return () => {
      window.clearTimeout(deadline);
      unsubscribeReady();
      unsubscribeError?.();
      unsubscribeMessage();
      transport.destroy();
    };
  }, [liveWs?.relayUrl, onSystemMessage]);

  const showOutline = (inspectionUnavailable || socketUnavailable) && outlineConfig;

  return (
    <section className="viz-shell" aria-label={`Live statechart for ${title}`}>
      <div className="viz-canvas">
        {!hasMachine ? (
          // Checked before `liveUrl`: the room outlives a selection, so an
          // example with no machine must not keep showing the previous one.
          <div className="viz-state" role="status">
            <strong>No machine to inspect</strong>
            <p>This example does not export a state machine from its index.ts.</p>
          </div>
        ) : showOutline ? (
          <StateOutline title={title} config={outlineConfig} value={outlineValue} />
        ) : liveUrl ? (
          <iframe
            className="viz-embed"
            title={`Live inspection for ${title}`}
            src={liveUrl}
            allow="clipboard-read; clipboard-write"
            referrerPolicy="strict-origin"
          />
        ) : inspectionUnavailable ? (
          <div className="viz-state" role="status">
            <strong>Live inspection unavailable</strong>
            <p>The demo could not reach the inspection relay, so this machine is not visualized.</p>
          </div>
        ) : (
          <div className="viz-state" role="status">
            <strong>Loading the statechart</strong>
            <p>Publishing this machine to the inspection room.</p>
          </div>
        )}
      </div>
    </section>
  );
}
