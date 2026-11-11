import { useEffect, useState } from "react";
import { createWebSocketTransport } from "@statelyai/sdk";
import { StateOutline } from "@/components/state-outline";
import { MachineEmbed, type EmbedStep } from "@/components/machine-embed";
import type { DiagramHints } from "@/lib/scenarios";

export type LiveWs = { relayUrl: string; roomId: string };

type VizPanelProps = {
  /** Display name of the machine being inspected. */
  title: string;
  /** Whether the selected example exports a machine at all. */
  hasMachine: boolean;
  /** The inspection relay was reached for and never became available. */
  inspectionUnavailable?: boolean;
  /**
   * Stable key for the selected machine, and its source text or plain-JSON
   * config: what the SDK embed can draw if no outline is available.
   */
  machineKey?: string;
  machineConfig?: unknown;
  /**
   * Plain-JSON machine config for the outline shown when inspection is down.
   * Null when the machine has no JSON view.
   */
  outlineConfig?: Record<string, unknown> | null;
  outlineHints?: DiagramHints | null;
  /** The latest settled step of the run, for the active state. */
  step?: EmbedStep | null;
  theme?: "light" | "dark";
  /** Prefer the authored outline when the hosted viewer has no browser reachability signal. */
  preferOutline?: boolean;
  /**
   * Live inspection relay. The panel joins the room as a viewer purely as a
   * reachability canary — the /inspect page connects to the relay itself for
   * rendering.
   */
  liveWs: LiveWs | null;
  /**
   * Full viz `/inspect` page URL, pointed at the current inspection room.
   * Null until the selected machine has been published to that room.
   */
  liveUrl: string | null;
};

export function VizPanel({
  title,
  hasMachine,
  inspectionUnavailable = false,
  machineKey = "",
  machineConfig = null,
  outlineConfig = null,
  outlineHints = null,
  step = null,
  theme = "light",
  preferOutline = false,
  liveWs,
  liveUrl,
}: VizPanelProps) {
  // The server may reach the relay while this browser cannot (a corporate
  // proxy, an offline demo). The viewer socket below is the canary: if it is
  // not ready within a few seconds, or errors, the embed would be blank too,
  // so the static outline takes the pane instead.
  const [socketUnavailable, setSocketUnavailable] = useState(false);
  // The embed's own handshake failed too; nothing hosted can draw it.
  const [embedUnavailable, setEmbedUnavailable] = useState(false);
  useEffect(() => setEmbedUnavailable(false), [machineKey]);

  // The hosted /inspect page renders the system; this socket only checks that
  // this browser can reach the relay. (The chat's live transition log comes
  // from the run's own response stream, not from here.)
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
    return () => {
      window.clearTimeout(deadline);
      unsubscribeReady();
      unsubscribeError?.();
      transport.destroy();
    };
  }, [liveWs?.relayUrl]);

  const inspectionDown = inspectionUnavailable || socketUnavailable;
  const showOutline = (preferOutline || inspectionDown) && outlineConfig;
  const showEmbed = inspectionDown && !showOutline && machineConfig != null && !embedUnavailable;

  return (
    <section className="viz-shell" aria-label={`Live statechart for ${title}`}>
      <div className="viz-canvas">
        {!hasMachine ? (
          // An example with no machine must not keep showing a previous chart.
          <div className="viz-state" role="status">
            <strong>No machine to inspect</strong>
            <p>This example does not export a state machine from its index.ts.</p>
          </div>
        ) : showEmbed ? (
          <MachineEmbed
            title={title}
            machineKey={machineKey}
            machine={machineConfig}
            theme={theme}
            step={step}
            onUnavailable={() => setEmbedUnavailable(true)}
          />
        ) : showOutline ? (
          <StateOutline
            title={title}
            config={outlineConfig}
            value={step?.value ?? null}
            hints={outlineHints}
            liveChartAvailable={preferOutline && !inspectionDown && !!liveUrl}
          />
        ) : liveUrl ? (
          <iframe
            key={machineKey}
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
        {hasMachine && liveUrl && !inspectionDown && (
          <a
            className="viz-open-link"
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open full statechart for ${title}`}
          >
            Open full chart ↗
          </a>
        )}
      </div>
    </section>
  );
}
