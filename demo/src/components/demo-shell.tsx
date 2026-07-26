import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Braces, Menu, X } from "lucide-react";
import { AppPanel, type ChatTurnResult, type TextPolicy, type Turn } from "@/components/app-panel";
import { ExampleIntro, ScenarioIntro, type StarterAction } from "@/components/chat-intros";
import { CodePanel } from "@/components/code-panel";
import { ExamplesSidebar } from "@/components/examples-sidebar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { VizPanel } from "@/components/viz-panel";
import { useTracePlayer } from "@/hooks/use-trace-player";
import {
  getExample,
  getInspection,
  listExamples,
  resumeExample,
  startExample,
  type ExampleDetail,
  type ExampleSummary,
  type InspectionInfo,
} from "@/lib/example-library";
import { humanizeEventType, type ChatIdle, type Json } from "@/lib/machine-ui";
import { resumeScenario, startScenario } from "@/lib/run-demo-agent";
import { getScenario, scenarioSource, scenarioVizConfig } from "@/lib/scenarios";
import type { Selection } from "@/lib/selection";

type MobileView = "app" | "machine" | "code";
const mobileQuery = "(max-width: 800px)";

function subscribeToMobileQuery(callback: () => void) {
  const media = window.matchMedia(mobileQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
function getMobileSnapshot() {
  return window.matchMedia(mobileQuery).matches;
}

/** A settled result from either run path (curated scenario or library example). */
type AnyRunResult = ChatTurnResult & { idle?: ChatIdle & { snapshot: Json } };

/**
 * Optional full /inspect page (VITE_VIZ_INSPECT_URL). The hosted route is
 * login-free now, but an https page cannot open a ws:// connection to the
 * local relay (mixed content), so it only works with a local (http) viz app
 * or a wss relay. Default: the embed + WS bridge inside VizPanel, which
 * connects from this (http) page and forwards live messages via postMessage.
 */
const inspectOverride = import.meta.env.VITE_VIZ_INSPECT_URL || null;

export function DemoShell() {
  const [selection, setSelection] = useState<Selection>({ type: "scenario", id: "refund" });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("app");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pendingIdle, setPendingIdle] = useState<ChatIdle | null>(null);
  const [examples, setExamples] = useState<ExampleSummary[]>([]);
  const [exampleDetail, setExampleDetail] = useState<ExampleDetail | null>(null);
  const [exampleError, setExampleError] = useState<string | null>(null);
  const [machineIndex, setMachineIndex] = useState(0);
  const requestRef = useRef(0);
  const idleSnapshotRef = useRef<Json | null>(null);
  const detailCache = useRef(new Map<string, ExampleDetail>());
  const isMobile = useSyncExternalStore(subscribeToMobileQuery, getMobileSnapshot, () => false);

  const isScenario = selection.type === "scenario";
  const scenario = getScenario(isScenario ? selection.id : "refund");
  const exampleSummary = !isScenario
    ? (exampleDetail ?? examples.find((example) => example.id === selection.id) ?? null)
    : null;
  const activeMachine = exampleDetail?.machines[machineIndex] ?? exampleDetail?.machines[0] ?? null;

  const machineKey = isScenario
    ? `scenario:${scenario.id}`
    : `example:${selection.id}:${activeMachine?.exportName ?? "none"}`;
  const initialValue = isScenario
    ? ((scenarioVizConfig[scenario.id] as { initial?: string }).initial ?? null)
    : (activeMachine?.initial ?? null);
  const player = useTracePlayer(machineKey, initialValue);

  // Live inspection: boot the local WS relay and remember how to connect.
  const [inspection, setInspection] = useState<InspectionInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getInspection().then(
      (info) => {
        if (!cancelled) setInspection(info);
      },
      () => {
        if (!cancelled) setInspection(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-discovered examples: whatever folders exist under `examples/*`.
  useEffect(() => {
    let cancelled = false;
    void listExamples().then(
      (list) => {
        if (!cancelled) setExamples(list);
      },
      () => {
        if (!cancelled) setExamples([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch (and cache) the selected example's machines + source.
  useEffect(() => {
    if (selection.type !== "example") {
      setExampleDetail(null);
      setExampleError(null);
      return;
    }
    const id = selection.id;
    const cached = detailCache.current.get(id);
    if (cached) {
      setExampleDetail(cached);
      setExampleError(null);
      return;
    }
    let cancelled = false;
    setExampleDetail(null);
    setExampleError(null);
    void getExample({ data: { id } }).then(
      (detail) => {
        if (cancelled) return;
        detailCache.current.set(id, detail);
        setExampleDetail(detail);
      },
      (error) => {
        if (cancelled) return;
        setExampleError(error instanceof Error ? error.message : "Failed to load example");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selection]);

  const resetRun = () => {
    requestRef.current += 1;
    setInput("");
    setTurns([]);
    setPendingIdle(null);
    idleSnapshotRef.current = null;
    player.reset();
  };

  const select = (next: Selection) => {
    resetRun();
    setMachineIndex(0);
    setSelection(next);
    setMobileMenuOpen(false);
    setMobileView("app");
  };

  const selectMachine = (index: number) => {
    resetRun();
    setMachineIndex(index);
  };

  const settle = (requestId: number, turnId: number, result: AnyRunResult) => {
    if (requestRef.current !== requestId) return;
    setTurns((current) =>
      current.map((turn) => (turn.id === turnId ? { ...turn, status: "ready", result } : turn)),
    );
    // With live inspection the viz already showed the run in real time; the
    // trace replay only backs the no-relay fallback.
    if (!inspection) player.play(result.trace);
    if (result.status === "idle" && result.idle) {
      const { snapshot, ...idle } = result.idle;
      idleSnapshotRef.current = snapshot;
      setPendingIdle(idle);
    } else {
      idleSnapshotRef.current = null;
      setPendingIdle(null);
    }
  };

  const fail = (requestId: number, turnId: number, error: unknown) => {
    if (requestRef.current !== requestId) return;
    const message = error instanceof Error ? error.message : "Agent request failed";
    setTurns((current) =>
      current.map((turn) => (turn.id === turnId ? { ...turn, status: "error", error: message } : turn)),
    );
  };

  const loading = turns.some((turn) => turn.status === "loading");
  const started = turns.length > 0;
  const interpretMode = isScenario && scenario.id === "approval" && pendingIdle !== null;

  const pushTurn = (text: string, role: Turn["role"], status: Turn["status"]): number => {
    const requestId = ++requestRef.current;
    setTurns((current) => [...current, { id: requestId, input: text, role, status }]);
    return requestId;
  };

  /** Starts a library-example run with the given machine input. */
  const startExampleRun = (label: string, machineInput: Record<string, unknown>) => {
    if (!activeMachine || loading) return;
    const requestId = pushTurn(label, "user", "loading");
    void startExample({
      data: { id: selection.type === "example" ? selection.id : "", exportName: activeMachine.exportName, input: machineInput },
    }).then(
      (result) => settle(requestId, requestId, result),
      (error) => fail(requestId, requestId, error),
    );
  };

  /** Delivers a typed event to the idle machine (either run path). */
  const sendEvent = (event: { type: string; [key: string]: unknown }) => {
    const snapshot = idleSnapshotRef.current;
    if (!snapshot || loading) return;
    const descriptor = pendingIdle?.events.find((candidate) => candidate.type === event.type);
    const { type: _type, ...payload } = event;
    const payloadNote = Object.keys(payload).length
      ? ` · ${JSON.stringify(payload).slice(0, 60)}`
      : "";
    const label = `${descriptor?.label ?? humanizeEventType(event.type)}${payloadNote}`;
    const requestId = pushTurn(label, "action", "loading");
    setPendingIdle(null);
    const deliver = isScenario
      ? resumeScenario({ data: { scenarioId: scenario.id, snapshot: snapshot as never, event } })
      : resumeExample({
          data: {
            id: selection.type === "example" ? selection.id : "",
            exportName: activeMachine?.exportName ?? "",
            snapshot: snapshot as never,
            event,
          },
        });
    void deliver.then(
      (result) => settle(requestId, requestId, result as AnyRunResult),
      (error) => fail(requestId, requestId, error),
    );
  };

  /** Free chat text: start a run, map to the idle text event, or mark ignored. */
  const submit = (raw: string) => {
    const text = raw.trim();
    if (!text || loading) return;
    setInput("");

    // Approval scenario while idle → model-interpreted free-text review.
    if (interpretMode && idleSnapshotRef.current) {
      const requestId = pushTurn(text, "user", "loading");
      void resumeScenario({
        data: {
          scenarioId: scenario.id,
          snapshot: idleSnapshotRef.current as never,
          event: { kind: "interpret", text },
        },
      }).then(
        (result) => settle(requestId, requestId, result),
        (error) => fail(requestId, requestId, error),
      );
      return;
    }

    // Idle with a text-mapped event → typed event carrying the message.
    if (pendingIdle?.textEvent && idleSnapshotRef.current) {
      sendEvent({ type: pendingIdle.textEvent.type, [pendingIdle.textEvent.field]: text });
      return;
    }

    // Not started → the prompt starts the run.
    if (!started) {
      if (isScenario) {
        const requestId = pushTurn(text, "user", "loading");
        void startScenario({ data: { scenarioId: scenario.id, prompt: text } }).then(
          (result) => settle(requestId, requestId, result),
          (error) => fail(requestId, requestId, error),
        );
      } else if (activeMachine?.promptField) {
        startExampleRun(text, { [activeMachine.promptField]: text });
      }
      return;
    }

    // Out of place: keep the message in the log, marked ignored (bullet 1 —
    // the machine, not the chat, owns whether stray input means anything).
    pushTurn(text, "user", "ignored");
  };

  // ─── composer policy ───

  const textPolicy: TextPolicy = (() => {
    if (isScenario) {
      return {
        visible: true,
        placeholder: interpretMode
          ? "Say “looks good” or “that’s no good”…"
          : (pendingIdle?.textEvent
              ? `Message becomes ${pendingIdle.textEvent.type} (${pendingIdle.textEvent.field})`
              : scenario.placeholder),
        submitLabel: interpretMode ? "Interpret review" : started ? "Send" : scenario.startLabel,
      };
    }
    if (!exampleDetail) return { visible: false, placeholder: "", submitLabel: "" };
    if (!exampleDetail.runnable) {
      return {
        visible: false,
        placeholder: "",
        submitLabel: "",
        note: "Set OPENAI_API_KEY on the demo server to run library examples live.",
      };
    }
    if (!activeMachine) {
      return {
        visible: false,
        placeholder: "",
        submitLabel: "",
        note: "This example exports no machine, so there is nothing to run.",
      };
    }
    if (!started && !activeMachine.promptField) {
      // Structured input: the start form (below the intro) owns the first step.
      return { visible: false, placeholder: "", submitLabel: "" };
    }
    return {
      visible: true,
      placeholder: pendingIdle?.textEvent
        ? `Message becomes ${pendingIdle.textEvent.type} (${pendingIdle.textEvent.field})`
        : started
          ? "Send a message…"
          : `${activeMachine.promptField}…`,
      submitLabel: started ? "Send" : "Start run",
    };
  })();

  const startForm =
    !isScenario && exampleDetail?.runnable && activeMachine && !activeMachine.promptField
      ? {
          schema: activeMachine.inputJsonSchema ?? { type: "object" as const },
          onStart: (values: Record<string, unknown>) =>
            startExampleRun(`Start · ${activeMachine.exportName}`, values),
        }
      : null;

  // Pre-baked starter inputs → one-click chips in the intro. A string starter
  // needs a chat-startable machine (single string input); an object starter is
  // the machine input verbatim.
  const starters: StarterAction[] = isScenario
    ? scenario.starters.map((text) => ({ label: text, onStart: () => submit(text) }))
    : !exampleDetail?.runnable || !activeMachine
      ? []
      : (exampleSummary?.starters ?? []).flatMap((starter) => {
          if (typeof starter === "string") {
            const field = activeMachine.promptField;
            if (!field) return [];
            return [{ label: starter, onStart: () => startExampleRun(starter, { [field]: starter }) }];
          }
          const firstString = Object.values(starter).find((value) => typeof value === "string");
          const label = typeof firstString === "string" ? firstString : JSON.stringify(starter).slice(0, 80);
          return [{ label, onStart: () => startExampleRun(label, starter) }];
        });

  const intro = isScenario ? (
    <ScenarioIntro scenario={scenario} starters={starters} />
  ) : exampleSummary ? (
    <ExampleIntro
      summary={exampleSummary}
      detail={exampleDetail}
      error={exampleError}
      machineIndex={machineIndex}
      onSelectMachine={selectMachine}
      starters={starters}
    />
  ) : null;

  const headerName = isScenario ? scenario.name : (exampleSummary?.title ?? selection.id);

  const appPanel = (
    <AppPanel
      title={headerName}
      intro={intro}
      turns={turns}
      pendingIdle={pendingIdle}
      startForm={startForm}
      input={input}
      onInputChange={setInput}
      onSubmit={submit}
      onSendEvent={sendEvent}
      onRestart={resetRun}
      textPolicy={textPolicy}
    />
  );

  const liveUrl =
    inspection && inspectOverride && started
      ? `${inspectOverride}?ws=${encodeURIComponent(inspection.wsUrl)}&session=${encodeURIComponent(inspection.session)}`
      : null;
  const liveWs = inspection ? { wsUrl: inspection.wsUrl, session: inspection.session } : null;

  const vizProps = {
    title: headerName,
    machineKey,
    vizConfig: isScenario
      ? (scenarioVizConfig[scenario.id] as Record<string, unknown>)
      : exampleDetail
        ? (activeMachine?.vizConfig ?? null)
        : null,
    frame: player.frame,
    liveWs,
    liveUrl,
  };

  const codeProps = isScenario
    ? {
        fileLabel: `src/agents/${scenario.id}.ts`,
        source: scenarioSource[scenario.id],
        cacheKey: `scenario:${scenario.id}`,
      }
    : {
        fileLabel: `examples/${selection.id}/index.ts`,
        source: exampleDetail?.source ?? "// Loading…",
        // The placeholder must not be cached under the example's key.
        cacheKey: exampleDetail ? `example:${selection.id}` : `example:${selection.id}:loading`,
      };

  return (
    <div className="demo-shell">
      <header className="site-header">
        <button
          className="icon-button site-header__menu"
          onClick={() => setMobileMenuOpen(true)}
          aria-label="Open examples"
        >
          <Menu size={18} />
        </button>
        <a className="brand" href="/" aria-label="Stately Agent Lab home">
          <span className="brand__mark" aria-hidden="true">
            <Braces size={16} strokeWidth={2.2} />
          </span>
          <strong>Stately Agent Lab</strong>
        </a>
        <span className="header-divider" aria-hidden="true" />
        <span className="header-example">{headerName}</span>
        <a
          className="header-code-link"
          href="https://github.com/statelyai/agent"
          target="_blank"
          rel="noreferrer"
        >
          <Braces size={14} />
          View code
        </a>
      </header>

      <div className="mobile-tabs" role="tablist" aria-label="Demo view">
        <button role="tab" aria-selected={mobileView === "app"} onClick={() => setMobileView("app")}>
          App
        </button>
        <button role="tab" aria-selected={mobileView === "machine"} onClick={() => setMobileView("machine")}>
          Machine
        </button>
        <button role="tab" aria-selected={mobileView === "code"} onClick={() => setMobileView("code")}>
          Code
        </button>
      </div>

      <main className="workspace">
        {!isMobile && (
          <>
            <div className="desktop-sidebar" data-open={sidebarOpen || undefined}>
              <ExamplesSidebar
                open={sidebarOpen}
                onOpenChange={setSidebarOpen}
                selection={selection}
                onSelect={select}
                examples={examples}
              />
            </div>
            <div className="desktop-workspace">
              <ResizablePanelGroup orientation="horizontal">
                <ResizablePanel defaultSize={34} minSize={26}>
                  {appPanel}
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel defaultSize={44} minSize={30}>
                  <VizPanel {...vizProps} />
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel defaultSize={22} minSize={16}>
                  <CodePanel {...codeProps} />
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          </>
        )}

        {isMobile && (
          <div className="mobile-workspace">
            {mobileView === "app" ? appPanel : null}
            {mobileView === "machine" ? <VizPanel {...vizProps} /> : null}
            {mobileView === "code" ? <CodePanel {...codeProps} /> : null}
          </div>
        )}
      </main>

      {mobileMenuOpen && (
        <div className="mobile-drawer" role="dialog" aria-modal="true" aria-label="Examples">
          <button
            className="mobile-drawer__backdrop"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close examples"
          />
          <div className="mobile-drawer__sheet">
            <button
              className="icon-button mobile-drawer__close"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Close examples"
            >
              <X size={18} />
            </button>
            <ExamplesSidebar
              mobile
              open
              onOpenChange={() => setMobileMenuOpen(false)}
              selection={selection}
              onSelect={select}
              examples={examples}
            />
          </div>
        </div>
      )}
    </div>
  );
}
