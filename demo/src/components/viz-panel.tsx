import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWebSocketTransport } from "@statelyai/sdk";
import { useSelector } from "@xstate/store-react";
import { ExternalLink, RefreshCcw } from "lucide-react";
import { getTargetOrigin, isTrustedVizMessage } from "@/lib/viz-transport";
import { createVizPanelStore, type SystemMessage } from "@/lib/viz-panel-store";
import type { VizFrame } from "@/hooks/use-trace-player";

const defaultVizUrl = "https://editor.stately.ai/embed?auth=message";

export type LiveWs = { relayUrl: string; roomId: string };

export type VizDocument = {
  path: string;
  content: string;
  language?: "markdown" | "typescript" | "javascript" | "json" | "xml" | "mermaid" | "text";
};

type VizPanelProps = {
  /** Display name of the machine being inspected. */
  title: string;
  /** Stable key for the current machine — a change re-inits the embed. */
  machineKey: string;
  /** Machine source or serialized config for the embed, or null when unavailable. */
  vizConfig: unknown | null;
  frame: VizFrame;
  /**
   * Live inspection relay. When set, the panel connects to Sky or a local relay
   * and bridges `@statelyai.system.*` messages into the embed as they happen —
   * transitions render in REAL TIME during a run, not as a post-hoc replay.
   */
  liveWs: LiveWs | null;
  /**
   * Full viz `/inspect` page URL (VITE_VIZ_INSPECT_URL). When set it replaces
   * the embed entirely. Hosted Sky works directly; a local `ws://` relay needs
   * a local HTTP viz app to avoid mixed content.
   */
  liveUrl: string | null;
  /** Page theme, forwarded into the embed init payload. */
  theme: "light" | "dark";
  /** Read-only source and explanation documents shown inside Viz. */
  documents: VizDocument[];
};

export function VizPanel({
  title,
  machineKey,
  vizConfig,
  frame,
  liveWs,
  liveUrl,
  theme,
  documents,
}: VizPanelProps) {
  if (liveUrl) {
    return (
      <section className="viz-shell" aria-label={`Live statechart for ${title}`}>
        <div className="viz-canvas">
          <iframe
            className="viz-embed"
            data-ready
            title={`Live inspection for ${title}`}
            src={liveUrl}
            referrerPolicy="strict-origin"
          />
        </div>
      </section>
    );
  }
  return (
    <EmbedVizPanel
      title={title}
      machineKey={machineKey}
      vizConfig={vizConfig}
      frame={frame}
      liveWs={liveWs}
      theme={theme}
      documents={documents}
    />
  );
}

function createInitMessage(
  machine: unknown,
  theme: "light" | "dark",
  documents: VizDocument[],
): SystemMessage {
  return {
    type: "@statelyai.init",
    machine,
    mode: "inspecting",
    theme,
    readOnly: true,
    capabilities: {
      edit: false,
      export: false,
      ai: false,
      simulate: false,
      inspect: true,
      navigateHierarchy: false,
      maxDepth: 2,
      panels: ["documents"],
    },
    documents,
    leftPanels: ["documents"],
    rightPanels: [],
    activePanels: ["documents"],
  };
}

function createFrameMessage(frame: VizFrame): SystemMessage {
  return {
    type: "@statelyai.inspectSnapshot",
    snapshot: { value: frame.value, status: frame.status, context: frame.context },
    event: frame.event,
  };
}

function createStaticMessages(
  vizConfig: unknown | null,
  frame: VizFrame,
  theme: "light" | "dark",
  documents: VizDocument[],
) {
  return vizConfig
    ? [createInitMessage(vizConfig, theme, documents), createFrameMessage(frame)]
    : [];
}

function EmbedVizPanel({
  title,
  machineKey,
  vizConfig,
  frame,
  liveWs,
  theme,
  documents,
}: Omit<VizPanelProps, "liveUrl">) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const latestRef = useRef({ vizConfig, frame, theme, documents });
  const [store] = useState(createVizPanelStore);
  const status = useSelector(store, (snapshot) => snapshot.context.status);
  const transportError = useSelector(store, (snapshot) => snapshot.context.error);
  const frameKey = useSelector(store, (snapshot) => snapshot.context.frameKey);
  const ready = status === "ready";
  const timedOut = status === "timedOut";
  const failed = status === "failed";
  const vizUrl = import.meta.env.VITE_VIZ_URL || defaultVizUrl;
  const targetOrigin = useMemo(() => getTargetOrigin(vizUrl), [vizUrl]);

  latestRef.current = { vizConfig, frame, theme, documents };

  const post = useCallback(
    (message: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage(message, targetOrigin);
    },
    [targetOrigin],
  );

  useEffect(() => {
    const subscription = store.on("post", ({ message }) => post(message));
    return () => subscription.unsubscribe();
  }, [post, store]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isTrustedVizMessage(event, iframeRef.current?.contentWindow ?? null, targetOrigin))
        return;
      if (event.data?.type === "@statelyai.ready") {
        const latest = latestRef.current;
        store.trigger.iframeReady({
          fallbackMessages: createStaticMessages(
            latest.vizConfig,
            latest.frame,
            latest.theme,
            latest.documents,
          ),
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [store, targetOrigin]);

  // Reset live inspection only when the selected machine changes. In
  // particular, do not clear observations when the iframe becomes ready.
  useEffect(() => {
    store.trigger.machineChanged({
      initMessage: vizConfig
        ? createInitMessage(vizConfig, latestRef.current.theme, latestRef.current.documents)
        : null,
    });
    // machineKey identifies the machine; vizConfig is its (stable) payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineKey, store]);

  // Theme lives in the embed's init payload, so a flip means re-initing the
  // embed and replaying whatever it was already showing.
  const previousTheme = useRef(theme);
  useEffect(() => {
    if (previousTheme.current === theme) return;
    previousTheme.current = theme;
    store.trigger.themeChanged({
      initMessage: vizConfig ? createInitMessage(vizConfig, theme, documents) : null,
      fallbackMessages: createStaticMessages(vizConfig, latestRef.current.frame, theme, documents),
    });
  }, [documents, store, theme, vizConfig]);

  // Fallback replay frames (only used when live inspection is unavailable).
  useEffect(() => {
    if (!vizConfig) return;
    store.trigger.fallbackFrame({ message: createFrameMessage(frame) });
  }, [frame, store, vizConfig]);

  // ─── live bridge: relay WS → embed postMessage ───
  //
  // The demo page plays the role the viz /inspect route would: it joins the
  // inspection room as a viewer and forwards the full streamed system
  // protocol into the (auth-free) embed. The local HTTP parent owns the ws://
  // connection, avoiding mixed content in the hosted HTTPS iframe.
  useEffect(() => {
    if (!liveWs) return;
    const transport = createWebSocketTransport({
      url: liveWs.relayUrl,
      role: "viewer",
      metadata: { name: "Stately Agent Lab" },
    });
    const unsubscribeMessage = transport.onMessage((protocolMessage) => {
      const message = protocolMessage as SystemMessage;
      if (message.type === "@statelyai.system.init" && Array.isArray(message.actors)) {
        store.trigger.systemInit({ message });
      } else if (message.type.startsWith("@statelyai.system.")) {
        store.trigger.systemMessage({ message });
      } else if (message.type === "@statelyai.error") {
        const detail = typeof message.message === "string" ? message.message : "Unknown error";
        store.trigger.transportFailed({ message: detail });
      }
    });
    const unsubscribeError = transport.onError?.((failure) => {
      store.trigger.transportFailed({ message: failure.message });
    });
    return () => {
      unsubscribeMessage();
      unsubscribeError?.();
      transport.destroy();
    };
  }, [frameKey, liveWs?.relayUrl, store]);

  useEffect(() => {
    const timeout = window.setTimeout(() => store.trigger.timeout(), 9000);
    return () => window.clearTimeout(timeout);
  }, [frameKey, store, vizUrl]);

  return (
    <section className="viz-shell" aria-label={`Live statechart for ${title}`}>
      <div className="viz-canvas">
        {!vizConfig ? (
          <div className="viz-state" role="status">
            <strong>No machine to inspect</strong>
            <p>This example does not export a state machine from its index.ts.</p>
          </div>
        ) : (
          <>
            {!ready && !timedOut && (
              <div className="viz-state" aria-label="Connecting to Stately Viz">
                <span className="viz-state__spinner" aria-hidden="true" />
                <p>Connecting to Viz…</p>
              </div>
            )}
            {(timedOut || failed) && !ready && (
              <div className="viz-state" role="status">
                <strong>Viz did not connect</strong>
                <p>{transportError ?? "Check the embed URL or run the local Viz app."}</p>
                <div className="viz-state__actions">
                  <button type="button" className="viz-chip" onClick={() => store.trigger.retry()}>
                    <RefreshCcw size={13} aria-hidden="true" /> Retry
                  </button>
                  <a className="viz-chip" href={vizUrl} target="_blank" rel="noreferrer">
                    Open Viz <ExternalLink size={12} aria-hidden="true" />
                  </a>
                </div>
              </div>
            )}
            <iframe
              key={frameKey}
              ref={iframeRef}
              className="viz-embed"
              data-ready={ready || undefined}
              title={`Live statechart for ${title}`}
              src={vizUrl}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="strict-origin"
            />
          </>
        )}
      </div>
    </section>
  );
}
