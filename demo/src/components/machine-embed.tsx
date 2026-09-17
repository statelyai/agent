/**
 * The machine drawn by Stately Viz through the SDK's embed, with no inspection
 * relay involved: the machine's source (or JSON config) is handed to the
 * editor over the embed protocol in read-only inspecting mode, and each
 * settled turn's snapshot is posted as an inspection frame so the active
 * state lights up. This is the pane's rendering whenever live inspection is
 * unavailable — the server could not reach the relay, or this browser
 * cannot — so a visitor still sees the statechart the chat is driving.
 *
 * `onUnavailable` fires if the editor never completes its handshake (offline,
 * or an embed origin that refuses); the parent then falls back to a plain
 * outline of the same config.
 */
import { useEffect, useRef, useState } from "react";
import { createStatelyEmbed, type MachineInitOptions } from "@statelyai/sdk/embed";

const defaultVizUrl = "https://editor.stately.ai";
const HANDSHAKE_TIMEOUT_MS = 9000;

export type EmbedStep = {
  value: unknown;
  context?: unknown;
  event?: unknown;
  status?: "active" | "done" | "error" | "stopped";
};

type MachineEmbedProps = {
  title: string;
  /** Stable key for the machine — a change re-inits the embed. */
  machineKey: string;
  /** Machine source text, or its plain-JSON config. */
  machine: unknown;
  theme: "light" | "dark";
  /** The latest settled step of the run, or null before a run starts. */
  step: EmbedStep | null;
  onUnavailable?: (reason: string) => void;
};

function initOptions(machine: unknown, theme: "light" | "dark"): MachineInitOptions {
  return {
    machine,
    mode: "inspecting",
    theme,
    readOnly: true,
    depth: 2,
    capabilities: { edit: false, export: false, ai: false, simulate: false, inspect: true },
  };
}

export function MachineEmbed({
  title,
  machineKey,
  machine,
  theme,
  step,
  onUnavailable,
}: MachineEmbedProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const embedRef = useRef<ReturnType<typeof createStatelyEmbed> | null>(null);
  const [ready, setReady] = useState(false);
  const vizOrigin = new URL(import.meta.env.VITE_VIZ_URL || defaultVizUrl).origin;
  const latest = useRef({ machine, theme, onUnavailable });
  latest.current = { machine, theme, onUnavailable };

  // One embed per iframe: the SDK sets the src, verifies message origin and
  // source, runs the version handshake, and reports ready or error.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    setReady(false);
    let settled = false;
    const embed = createStatelyEmbed({
      baseUrl: vizOrigin,
      apiKey: import.meta.env.VITE_STATELY_API_KEY || undefined,
      iframe,
      onReady: () => {
        settled = true;
        setReady(true);
      },
      onError: (error) => {
        if (settled) return;
        settled = true;
        latest.current.onUnavailable?.(error.message);
      },
    });
    embedRef.current = embed;
    // Queued by the SDK until the editor's ready handshake completes.
    embed.init(initOptions(latest.current.machine, latest.current.theme));
    const deadline = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      latest.current.onUnavailable?.("The Stately editor did not respond.");
    }, HANDSHAKE_TIMEOUT_MS);
    return () => {
      window.clearTimeout(deadline);
      embedRef.current = null;
      embed.destroy();
    };
    // machineKey identifies the machine; `machine` is its (stable) payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineKey, vizOrigin]);

  // A theme flip is a live message, never a re-init (which would drop the
  // camera and the inspection state).
  const previousTheme = useRef(theme);
  useEffect(() => {
    if (previousTheme.current === theme) return;
    previousTheme.current = theme;
    embedRef.current?.setTheme(theme);
  }, [theme]);

  // Each settled step is an inspection frame: the editor lights the active
  // state and shows the event that led there.
  useEffect(() => {
    if (!ready || !step) return;
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: "@statelyai.inspectSnapshot",
        snapshot: {
          value: step.value,
          status: step.status ?? "active",
          context: step.context ?? {},
        },
        event: step.event ?? { type: "xstate.init" },
      },
      vizOrigin,
    );
  }, [ready, step, vizOrigin]);

  return (
    <>
      {!ready && (
        <div className="viz-state" aria-label="Connecting to Stately Viz">
          <strong>Drawing the statechart</strong>
          <p>Live inspection is unavailable, so the machine is rendered on its own.</p>
        </div>
      )}
      {/* No `src`: the SDK sets it on attach, then owns the handshake. */}
      <iframe
        ref={iframeRef}
        className="viz-embed"
        data-ready={ready || undefined}
        title={`Statechart for ${title}`}
        allow="clipboard-read; clipboard-write"
        referrerPolicy="strict-origin"
      />
    </>
  );
}
