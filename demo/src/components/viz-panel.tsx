import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSelector } from "@xstate/store-react";
import { ExternalLink, RefreshCcw, X } from "lucide-react";
import { getTargetOrigin, isTrustedVizMessage } from "@/lib/viz-transport";
import { createVizPanelStore, type SystemMessage } from "@/lib/viz-panel-store";
import { CodeSource } from "@/components/code-panel";
import type { VizFrame } from "@/hooks/use-trace-player";

const defaultVizUrl = "https://editor.stately.ai/embed?auth=message";

export type LiveWs = { wsUrl: string; session: string };

export type VizCode = {
  /** Path label shown in the drawer header, e.g. `src/agents/refund.ts`. */
  fileLabel: string;
  source: string;
  /** Stable cache key for the highlighted output (scenario or example id). */
  cacheKey: string;
};

type VizPanelProps = {
  /** Display name of the machine being inspected. */
  title: string;
  /** Stable key for the current machine — a change re-inits the embed. */
  machineKey: string;
  /** Serialized machine config for the embed, or null when none is available. */
  vizConfig: Record<string, unknown> | null;
  frame: VizFrame;
  /**
   * Live inspection relay. When set, the panel connects to the local WS relay
   * and bridges `@statelyai.system.*` messages into the embed as they happen —
   * transitions render in REAL TIME during a run, not as a post-hoc replay.
   */
  liveWs: LiveWs | null;
  /**
   * Full viz `/inspect` page URL (VITE_VIZ_INSPECT_URL). When set it replaces
   * the embed entirely. Use a local HTTP viz app or a WSS relay; a hosted HTTPS
   * page cannot connect directly to the demo's local `ws://` relay.
   */
  liveUrl: string | null;
  /** Page theme, forwarded into the embed init payload. */
  theme: "light" | "dark";
  /** Code drawer visibility (parent-owned; parent also handles Escape). */
  codeOpen: boolean;
  onToggleCode: () => void;
  /** Source shown in the code drawer, or null when none is available. */
  code: VizCode | null;
};

export function VizPanel({
  title,
  machineKey,
  vizConfig,
  frame,
  liveWs,
  liveUrl,
  theme,
  codeOpen,
  onToggleCode,
  code,
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
          <CodeDrawer open={codeOpen} code={code} onClose={onToggleCode} />
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
      codeOpen={codeOpen}
      onToggleCode={onToggleCode}
      code={code}
    />
  );
}

function createInitMessage(machine: unknown, theme: "light" | "dark"): SystemMessage {
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
      panels: [],
    },
    leftPanels: [],
    rightPanels: [],
    activePanels: [],
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
  vizConfig: Record<string, unknown> | null,
  frame: VizFrame,
  theme: "light" | "dark",
) {
  return vizConfig ? [createInitMessage(vizConfig, theme), createFrameMessage(frame)] : [];
}

function EmbedVizPanel({
  title,
  machineKey,
  vizConfig,
  frame,
  liveWs,
  theme,
  codeOpen,
  onToggleCode,
  code,
}: Omit<VizPanelProps, "liveUrl">) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const latestRef = useRef({ vizConfig, frame, theme });
  const [store] = useState(createVizPanelStore);
  const status = useSelector(store, (snapshot) => snapshot.context.status);
  const frameKey = useSelector(store, (snapshot) => snapshot.context.frameKey);
  const ready = status === "ready";
  const timedOut = status === "timedOut";
  const vizUrl = import.meta.env.VITE_VIZ_URL || defaultVizUrl;
  const targetOrigin = useMemo(() => getTargetOrigin(vizUrl), [vizUrl]);

  latestRef.current = { vizConfig, frame, theme };

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
          fallbackMessages: createStaticMessages(latest.vizConfig, latest.frame, latest.theme),
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
      initMessage: vizConfig ? createInitMessage(vizConfig, latestRef.current.theme) : null,
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
      initMessage: vizConfig ? createInitMessage(vizConfig, theme) : null,
      fallbackMessages: createStaticMessages(vizConfig, latestRef.current.frame, theme),
    });
  }, [store, theme, vizConfig]);

  // Fallback replay frames (only used when live inspection is unavailable).
  useEffect(() => {
    if (!vizConfig) return;
    store.trigger.fallbackFrame({ message: createFrameMessage(frame) });
  }, [frame, store, vizConfig]);

  // ─── live bridge: relay WS → embed postMessage ───
  //
  // The demo page plays the role the viz /inspect route would: it joins the
  // relay session as a "viz" peer and forwards the full streamed system
  // protocol into the (auth-free) embed. The local HTTP parent owns the ws://
  // connection, avoiding mixed content in the hosted HTTPS iframe.
  useEffect(() => {
    if (!liveWs) return;
    let connectedAt = 0;
    const socket = new WebSocket(liveWs.wsUrl);
    socket.onopen = () => {
      connectedAt = Date.now();
      socket.send(
        JSON.stringify({ type: "@statelyai.register", role: "viz", sessionId: liveWs.session }),
      );
    };
    socket.onmessage = (messageEvent) => {
      let message: SystemMessage;
      try {
        message = JSON.parse(String(messageEvent.data)) as SystemMessage;
      } catch {
        return;
      }
      // A `system.init` right after connecting is relay replay of an older
      // session — ignore it so the static preview isn't clobbered on page
      // load. A LATER init is the node inspector's fresh connect (first run
      // in a server process): adopt its root machine.
      if (message.type === "@statelyai.system.init" && Array.isArray(message.actors)) {
        if (Date.now() - connectedAt < 1000) return;
        store.trigger.systemInit({ message });
      } else if (message.type.startsWith("@statelyai.system.")) {
        store.trigger.systemMessage({ message });
      }
    };
    return () => socket.close();
  }, [liveWs?.wsUrl, liveWs?.session, store]);

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
            {timedOut && !ready && (
              <div className="viz-state" role="status">
                <strong>Viz did not connect</strong>
                <p>Check the embed URL or run the local Viz app.</p>
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

        <CodeDrawer open={codeOpen} code={code} onClose={onToggleCode} />
      </div>
    </section>
  );
}

function CodeDrawer({
  open,
  code,
  onClose,
}: {
  open: boolean;
  code: VizCode | null;
  onClose: () => void;
}) {
  return (
    <aside className="viz-drawer" data-open={open || undefined} aria-hidden={!open} inert={!open}>
      {code ? (
        <>
          <div className="viz-drawer__header">
            <span className="viz-drawer__file">{code.fileLabel}</span>
            <button
              type="button"
              className="viz-drawer__close"
              onClick={onClose}
              aria-label="Close code"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <CodeSource
            source={code.source}
            cacheKey={code.cacheKey}
            className="viz-drawer__body"
          />
        </>
      ) : null}
    </aside>
  );
}
