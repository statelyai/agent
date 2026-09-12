import { useEffect } from "react";
import { createWebSocketTransport } from "@statelyai/sdk";

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
  /** A run started but the inspection relay never became available. */
  inspectionUnavailable?: boolean;
  /**
   * Live inspection relay. The panel joins the room as a viewer purely to
   * mirror the stream to `onSystemMessage` — the /inspect page connects to the
   * relay itself for rendering.
   */
  liveWs: LiveWs | null;
  /**
   * Full viz `/inspect` page URL, pointed at the current inspection room.
   * Null until a run starts.
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
  liveWs,
  liveUrl,
  onSystemMessage,
}: VizPanelProps) {
  // The hosted /inspect page renders the system; this socket exists only so
  // the chat's transition log can follow the same run.
  useEffect(() => {
    if (!liveWs) return;
    const transport = createWebSocketTransport({
      url: liveWs.relayUrl,
      role: "viewer",
      metadata: { name: "Stately Agent Lab" },
    });
    const unsubscribeMessage = transport.onMessage((protocolMessage) => {
      const message = protocolMessage as SystemMessage;
      if (message.type === "@statelyai.system.init") {
        if (Array.isArray(message.actors)) onSystemMessage?.(message);
      } else if (message.type.startsWith("@statelyai.system.")) {
        onSystemMessage?.(message);
      }
    });
    return () => {
      unsubscribeMessage();
      transport.destroy();
    };
  }, [liveWs?.relayUrl, onSystemMessage]);

  return (
    <section className="viz-shell" aria-label={`Live statechart for ${title}`}>
      <div className="viz-canvas">
        {liveUrl ? (
          <iframe
            className="viz-embed"
            title={`Live inspection for ${title}`}
            src={liveUrl}
            allow="clipboard-read; clipboard-write"
            referrerPolicy="strict-origin"
          />
        ) : hasMachine && inspectionUnavailable ? (
          <div className="viz-state" role="status">
            <strong>Live inspection unavailable</strong>
            <p>The demo could not reach the inspection relay, so this run is not visualized.</p>
          </div>
        ) : hasMachine ? (
          <div className="viz-state" role="status">
            <strong>Start a run to inspect</strong>
            <p>The live statechart appears here once the machine is running.</p>
          </div>
        ) : (
          <div className="viz-state" role="status">
            <strong>No machine to inspect</strong>
            <p>This example does not export a state machine from its index.ts.</p>
          </div>
        )}
      </div>
    </section>
  );
}
