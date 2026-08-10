import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSelector } from "@xstate/store-react";
import { AppPanel, type TextPolicy, type Turn } from "@/components/app-panel";
import type { SystemMessage } from "@/lib/viz-panel-store";
import { liveTraceStep, type TraceStep } from "@/lib/trace-view";
import { ExampleIntro, ScenarioIntro, type StarterAction } from "@/components/chat-intros";
import { SiteHeader } from "@/components/site-header";
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
import { humanizeEventType } from "@/lib/machine-ui";
import { resumeScenario, startScenario } from "@/lib/run-demo-agent";
import { getScenario, scenarioSource, scenarioVizConfig, scenarios } from "@/lib/scenarios";
import type { Selection } from "@/lib/selection";
import {
  createShellStore,
  persistTheme,
  readStoredTheme,
  type AnyRunResult,
} from "@/lib/shell-store";

const mobileQuery = "(max-width: 800px)";

function subscribeToMobileQuery(callback: () => void) {
  const media = window.matchMedia(mobileQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
function getMobileSnapshot() {
  return window.matchMedia(mobileQuery).matches;
}

/** Deep link: `#scenario:refund` or `#example:joke`. */
function selectionFromHash(): Selection | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  const [type, id] = hash.split(":");
  if (type === "example" && id) return { type: "example", id };
  const scenario = type === "scenario" ? scenarios.find((entry) => entry.id === id) : undefined;
  if (scenario) return { type: "scenario", id: scenario.id };
  return null;
}

function hashFromSelection(selection: Selection) {
  return `#${selection.type}:${selection.id}`;
}

/**
 * Optional full /inspect page (VITE_VIZ_INSPECT_URL). The hosted route is
 * login-free now. Default: the embed + WS bridge inside VizPanel, which
 * connects to hosted Stately Sky and forwards live messages via postMessage.
 * A local ws:// relay still needs an http viewer to avoid mixed content.
 */
const inspectOverride = import.meta.env.VITE_VIZ_INSPECT_URL || null;

function createLiveInspectUrl(baseUrl: string, inspection: InspectionInfo): string {
  const url = new URL(baseUrl);
  url.searchParams.set("ws", inspection.relayUrl);
  url.searchParams.set("r", inspection.roomId);
  return url.toString();
}

export function DemoShell() {
  const [store] = useState(() =>
    createShellStore(selectionFromHash() ?? { type: "scenario", id: "refund" }, readStoredTheme()),
  );
  const selection = useSelector(store, (s) => s.context.selection);
  const machineIndex = useSelector(store, (s) => s.context.machineIndex);
  const theme = useSelector(store, (s) => s.context.theme);
  const mobileView = useSelector(store, (s) => s.context.mobileView);
  const turns = useSelector(store, (s) => s.context.turns);
  const pendingIdle = useSelector(store, (s) => s.context.pendingIdle);
  const checkpoints = useSelector(store, (s) => s.context.checkpoints);

  const [examples, setExamples] = useState<ExampleSummary[]>([]);
  const [exampleDetail, setExampleDetail] = useState<ExampleDetail | null>(null);
  const [exampleError, setExampleError] = useState<string | null>(null);
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

  // Apply the persisted theme attribute on mount (SSR renders light).
  useEffect(() => {
    persistTheme(store.getSnapshot().context.theme);
  }, [store]);

  // Deep-link: selection ↔ URL hash.
  useEffect(() => {
    window.history.replaceState(null, "", hashFromSelection(selection));
  }, [selection]);
  useEffect(() => {
    function onHashChange() {
      const fromHash = selectionFromHash();
      const current = store.getSnapshot().context.selection;
      if (fromHash && (fromHash.type !== current.type || fromHash.id !== current.id)) {
        store.trigger.exampleSelected({ selection: fromHash });
        player.reset();
      }
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [player, store]);

  // Live inspection: use Sky by default; boot a local relay only when opted in.
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

  // ─── run control: one AbortController per in-flight turn + live feed ───
  //
  // The controller's signal rides the server-fn request; aborting it (Cancel,
  // navigation) tears down the HTTP request, whose signal the server passes
  // into `runAgent` — so cancellation actually stops server-side model calls.
  // The live feed mirrors the inspection relay (via VizPanel) into TraceSteps
  // so the chat's transition log fills in while the run is still going.
  const abortRef = useRef<AbortController | null>(null);
  const liveRun = useRef<{ sessionId: string | null; startedAt: number } | null>(null);
  const [liveSteps, setLiveSteps] = useState<TraceStep[]>([]);

  const beginRun = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    liveRun.current = { sessionId: null, startedAt: Date.now() };
    setLiveSteps([]);
    return controller.signal;
  };
  const endRun = () => {
    abortRef.current = null;
    liveRun.current = null;
    setLiveSteps([]);
  };
  const cancelRun = () => abortRef.current?.abort();

  const handleSystemMessage = useCallback((message: SystemMessage) => {
    const run = liveRun.current;
    if (!run) return; // only observe while a turn is in flight
    if (message.type === "@statelyai.system.init") {
      const root = Array.isArray(message.actors)
        ? [...message.actors].reverse().find((actor) => actor.parentSessionId == null)
        : null;
      // A fresh system means a fresh run — drop any replayed leftovers.
      if (root) {
        run.sessionId = root.sessionId;
        setLiveSteps([]);
      }
      return;
    }
    if (
      message.type === "@statelyai.system.actorRegistered" &&
      message.parentSessionId == null &&
      typeof message.sessionId === "string"
    ) {
      run.sessionId = message.sessionId;
      setLiveSteps([]);
      return;
    }
    if (message.type === "@statelyai.system.actorSnapshot" && message.sessionId === run.sessionId) {
      const step = liveTraceStep(
        message.event,
        (message.snapshot as { value?: unknown } | null | undefined)?.value,
        Date.now() - run.startedAt,
      );
      if (step) setLiveSteps((previous) => [...previous, step]);
    }
  }, []);

  const resetRun = () => {
    store.trigger.runReset();
    player.reset();
  };

  /** Rewind to a stored idle checkpoint; the next answer forks a new branch. */
  const rewindTo = (turnId: number) => {
    abortRef.current?.abort();
    endRun();
    store.trigger.rewound({ turnId });
  };

  const select = (next: Selection) => {
    store.trigger.exampleSelected({ selection: next });
    player.reset();
  };

  const selectMachine = (index: number) => {
    store.trigger.machineSelected({ index });
    player.reset();
  };

  const settle = (epoch: number, turnId: number, result: AnyRunResult) => {
    endRun();
    store.trigger.turnSettled({ epoch, id: turnId, result });
    // With live inspection the viz already showed the run in real time; the
    // trace replay only backs the no-relay fallback.
    if (!inspection && store.getSnapshot().context.epoch === epoch) player.play(result.trace);
  };

  const fail = (epoch: number, turnId: number, error: unknown) => {
    endRun();
    // An aborted fetch is the user's Cancel, not a failure worth a stack trace.
    const aborted = error instanceof DOMException && error.name === "AbortError";
    const message = aborted
      ? "Run cancelled."
      : error instanceof Error
        ? error.message
        : "Agent request failed";
    store.trigger.turnFailed({ epoch, id: turnId, message });
  };

  const loading = turns.some((turn) => turn.status === "loading");
  const started = turns.length > 0;
  const interpretMode = isScenario && scenario.id === "approval" && pendingIdle !== null;

  /** Appends a turn and returns its id + the epoch it belongs to. */
  const pushTurn = (
    text: string,
    role: Turn["role"],
    status: Turn["status"],
    eventType?: string,
  ) => {
    const { epoch, nextTurnId } = store.getSnapshot().context;
    store.trigger.turnPushed({ id: nextTurnId, input: text, role, status, eventType });
    return { id: nextTurnId, epoch };
  };

  /** Starts a library-example run with the given machine input. */
  const startExampleRun = (label: string, machineInput: Record<string, unknown>) => {
    if (!activeMachine || loading) return;
    const signal = beginRun();
    const { id, epoch } = pushTurn(label, "user", "loading");
    void startExample({
      data: {
        id: selection.type === "example" ? selection.id : "",
        exportName: activeMachine.exportName,
        input: machineInput,
      },
      signal,
    }).then(
      (result) => settle(epoch, id, result),
      (error) => fail(epoch, id, error),
    );
  };

  /** Delivers a typed event to the idle machine (either run path). */
  const sendEvent = (event: { type: string; [key: string]: unknown }) => {
    const { idleSnapshot, pendingIdle: idle } = store.getSnapshot().context;
    if (!idleSnapshot || loading) return;
    const descriptor = idle?.events.find((candidate) => candidate.type === event.type);
    const { type: _type, ...payload } = event;
    const payloadNote = Object.keys(payload).length
      ? ` · ${JSON.stringify(payload).slice(0, 60)}`
      : "";
    const label = `${descriptor?.label ?? humanizeEventType(event.type)}${payloadNote}`;
    const signal = beginRun();
    const { id, epoch } = pushTurn(label, "action", "loading", event.type);
    const deliver = isScenario
      ? resumeScenario({
          data: { scenarioId: scenario.id, snapshot: idleSnapshot as never, event },
          signal,
        })
      : resumeExample({
          data: {
            id: selection.type === "example" ? selection.id : "",
            exportName: activeMachine?.exportName ?? "",
            snapshot: idleSnapshot as never,
            event,
          },
          signal,
        });
    void deliver.then(
      (result) => settle(epoch, id, result as AnyRunResult),
      (error) => fail(epoch, id, error),
    );
  };

  /** Free chat text: start a run, map to the idle text event, or mark ignored. */
  const submit = (raw: string) => {
    const text = raw.trim();
    if (!text || loading) return;
    const { idleSnapshot } = store.getSnapshot().context;

    // Approval scenario while idle → model-interpreted free-text review.
    if (interpretMode && idleSnapshot) {
      const signal = beginRun();
      const { id, epoch } = pushTurn(text, "user", "loading");
      void resumeScenario({
        data: {
          scenarioId: scenario.id,
          snapshot: idleSnapshot as never,
          event: { kind: "interpret", text },
        },
        signal,
      }).then(
        (result) => settle(epoch, id, result),
        (error) => fail(epoch, id, error),
      );
      return;
    }

    // Idle with a text-mapped event → typed event carrying the message.
    if (pendingIdle?.textEvent && idleSnapshot) {
      sendEvent({ type: pendingIdle.textEvent.type, [pendingIdle.textEvent.field]: text });
      return;
    }

    // Not started → the prompt starts the run.
    if (!started) {
      if (isScenario) {
        const signal = beginRun();
        const { id, epoch } = pushTurn(text, "user", "loading");
        void startScenario({ data: { scenarioId: scenario.id, prompt: text }, signal }).then(
          (result) => settle(epoch, id, result),
          (error) => fail(epoch, id, error),
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
          : pendingIdle?.textEvent
            ? `Message becomes ${pendingIdle.textEvent.type} (${pendingIdle.textEvent.field})`
            : scenario.placeholder,
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
          if (starter.kind === "text") {
            const field = activeMachine.promptField;
            if (!field) return [];
            return [
              {
                label: starter.label,
                onStart: () => startExampleRun(starter.text, { [field]: starter.text }),
              },
            ];
          }
          return [
            { label: starter.label, onStart: () => startExampleRun(starter.label, starter.input) },
          ];
        });

  const intro = isScenario ? (
    <ScenarioIntro scenario={scenario} />
  ) : exampleSummary ? (
    <ExampleIntro
      summary={exampleSummary}
      detail={exampleDetail}
      error={exampleError}
      machineIndex={machineIndex}
      onSelectMachine={selectMachine}
    />
  ) : null;

  const headerName = isScenario ? scenario.name : (exampleSummary?.title ?? selection.id);

  const appPanel = (
    <AppPanel
      intro={intro}
      starters={starters}
      turns={turns}
      liveSteps={liveSteps}
      pendingIdle={pendingIdle}
      startForm={startForm}
      onSubmit={submit}
      onSendEvent={sendEvent}
      onCancel={cancelRun}
      onRestart={resetRun}
      checkpoints={checkpoints.map(({ turnId, label }) => ({ turnId, label }))}
      onRewind={rewindTo}
      textPolicy={textPolicy}
    />
  );

  const liveUrl =
    inspection && inspectOverride && started
      ? createLiveInspectUrl(inspectOverride, inspection)
      : null;
  const liveWs = inspection;
  const vizDocuments = isScenario
    ? [
        {
          path: `src/agents/${scenario.id}.ts`,
          content: scenarioSource[scenario.id],
        },
        {
          path: `docs/${scenario.id}.md`,
          content: `# ${scenario.name}\n\n${scenario.description}`,
        },
      ]
    : [
        {
          path: `examples/${selection.id}/index.ts`,
          content: exampleDetail?.source ?? "// Loading…",
        },
      ];

  const vizPanel = (
    <VizPanel
      title={headerName}
      machineKey={machineKey}
      vizConfig={
        isScenario
          ? scenarioSource[scenario.id]
          : exampleDetail
            ? (activeMachine?.vizConfig ?? null)
            : null
      }
      frame={player.frame}
      liveWs={liveWs}
      liveUrl={liveUrl}
      theme={theme}
      documents={vizDocuments}
      onSystemMessage={handleSystemMessage}
    />
  );

  return (
    <div className="demo-shell">
      <SiteHeader store={store} examples={examples} currentTitle={headerName} onSelect={select} />

      {isMobile && (
        <div className="mobile-tabs" role="tablist" aria-label="Demo view">
          <button
            role="tab"
            aria-selected={mobileView === "app"}
            onClick={() => store.trigger.mobileViewChanged({ view: "app" })}
          >
            Chat
          </button>
          <button
            role="tab"
            aria-selected={mobileView === "machine"}
            onClick={() => store.trigger.mobileViewChanged({ view: "machine" })}
          >
            Machine
          </button>
        </div>
      )}

      <main className="workspace">
        {!isMobile ? (
          <>
            <div className="chat-pane">{appPanel}</div>
            <div className="viz-pane">{vizPanel}</div>
          </>
        ) : (
          <div className="mobile-workspace">{mobileView === "app" ? appPanel : vizPanel}</div>
        )}
      </main>
    </div>
  );
}
