import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSelector } from "@xstate/store-react";
import { AppPanel, type LiveText, type TextPolicy, type Turn } from "@/components/app-panel";
import { traceSteps, type TraceStep } from "@/lib/trace-view";
import { ExampleIntro, ScenarioIntro, type StarterAction } from "@/components/chat-intros";
import { SiteHeader } from "@/components/site-header";
import { VizPanel } from "@/components/viz-panel";
import {
  declareExampleMachine,
  getExample,
  getInspection,
  listExamples,
  resumeExample,
  runExample,
  startExample,
  type ExampleDetail,
  type ExampleSummary,
  type InspectionInfo,
} from "@/lib/example-library";
import {
  humanizeEventType,
  missingKeyMessage,
  textRouting,
  type ChatIdle,
  type RequiredKey,
} from "@/lib/machine-ui";
import {
  declareScenarioMachine,
  getApiKeyStatus,
  resumeScenario,
  startScenario,
} from "@/lib/run-demo-agent";
import type { TraceEntry } from "@/lib/agent-runner";
import { readRunStream, type RunChunk } from "@/lib/run-stream";
import { getScenario, scenarios, scenarioVizConfig } from "@/lib/scenarios";
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
 * The hosted `/inspect` page renders the live system on its own: given `?ws=`
 * and `?r=` it joins the inspection room directly, no API key and no embed
 * handshake. Derived from `VITE_VIZ_URL`'s origin; `VITE_VIZ_INSPECT_URL`
 * replaces the whole URL (a local viz app, which a `ws://` relay needs to
 * avoid mixed content).
 */
const vizOrigin = new URL(import.meta.env.VITE_VIZ_URL || "https://editor.stately.ai").origin;
const inspectUrl = import.meta.env.VITE_VIZ_INSPECT_URL || `${vizOrigin}/inspect`;

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
      }
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [store]);

  // Live inspection: use Sky by default; boot a local relay only when opted in.
  const [inspection, setInspection] = useState<InspectionInfo | null>(null);
  const [inspectionChecked, setInspectionChecked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getInspection().then(
      (info) => {
        if (cancelled) return;
        setInspection(info);
        setInspectionChecked(true);
      },
      () => {
        if (cancelled) return;
        setInspection(null);
        setInspectionChecked(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Every run needs both model keys on the server (OpenAI and TypeSafe).
  // Unknown until this resolves; only a confirmed `false` blocks runs.
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [missingKeys, setMissingKeys] = useState<RequiredKey[]>([]);
  useEffect(() => {
    let cancelled = false;
    void getApiKeyStatus().then(
      (status) => {
        if (cancelled) return;
        setHasApiKey(status.hasApiKey);
        setMissingKeys(status.missing);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const missingKey = hasApiKey === false;

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

  // Publish the selected machine to the inspection room BEFORE any run, so the
  // visualizer draws its statechart on selection instead of an empty room. The
  // /inspect URL is the room, not the run, so it stays mounted across
  // selections: each declaration swaps the graph in place rather than
  // reloading the page.
  // Which machine the room is currently showing, not merely that something was
  // declared once: the /inspect page stays mounted across selections, so a
  // `liveUrl` that ignored the key would keep the PREVIOUS example's chart on
  // screen while the new declaration is still in flight (or after it failed).
  const [declaredKey, setDeclaredKey] = useState<string | null>(null);
  const inspectScenarioId = isScenario ? scenario.id : null;
  const inspectExampleId = !isScenario && activeMachine ? selection.id : null;
  const inspectExportName = !isScenario && activeMachine ? activeMachine.exportName : null;
  const inspectKey = inspectScenarioId
    ? `scenario:${inspectScenarioId}`
    : inspectExampleId && inspectExportName
      ? `example:${inspectExampleId}#${inspectExportName}`
      : null;
  useEffect(() => {
    if (!inspection) return;
    let cancelled = false;
    const onDeclared = ({ declared }: { declared: boolean }) => {
      if (!cancelled && declared) setDeclaredKey(inspectKey);
    };
    // A failed declaration is not worth surfacing: the panel keeps whatever it
    // was showing, and the run's own inspection still lights the chart up.
    const ignore = () => {};
    if (inspectScenarioId) {
      void declareScenarioMachine({
        data: { scenarioId: inspectScenarioId, room: inspection.roomId },
      }).then(onDeclared, ignore);
    } else if (inspectExampleId && inspectExportName) {
      void declareExampleMachine({
        data: { id: inspectExampleId, exportName: inspectExportName, room: inspection.roomId },
      }).then(onDeclared, ignore);
    }
    return () => {
      cancelled = true;
    };
  }, [inspection, inspectKey, inspectScenarioId, inspectExampleId, inspectExportName]);

  // ─── run control: one AbortController per in-flight turn + live feed ───
  //
  // The controller's signal rides the server-fn request; aborting it (Cancel,
  // navigation) tears down the HTTP request, whose signal the server passes
  // into `runAgent` — so cancellation actually stops server-side model calls.
  // The live feed is the run's own stream: each trace entry the server records
  // arrives as a step, so the chat's transition log fills in while the run is
  // still going — and never with another session's run.
  const abortRef = useRef<AbortController | null>(null);
  // The live feed is mirrored in refs so a cancelled turn can keep what it
  // showed: the settle callbacks run long after the render that created them.
  const liveStepsRef = useRef<TraceStep[]>([]);
  const [liveSteps, setLiveSteps] = useState<TraceStep[]>([]);
  const appendStep = useCallback((entry: TraceEntry) => {
    const [step] = traceSteps([entry]);
    if (!step) return;
    liveStepsRef.current = [...liveStepsRef.current, step];
    setLiveSteps(liveStepsRef.current);
  }, []);
  // Streamed text of the turn in flight, one lane per streaming request.
  const liveTextRef = useRef<LiveText[]>([]);
  const [liveText, setLiveText] = useState<LiveText[]>([]);
  const appendChunk = useCallback((chunk: RunChunk) => {
    const lanes = liveTextRef.current;
    const index = lanes.findIndex((lane) => lane.key === chunk.key);
    const lane = { key: chunk.key, call: chunk.call, label: chunk.label, text: chunk.delta };
    let next: LiveText[];
    if (index === -1) {
      next = [...lanes, lane];
    } else {
      next = lanes.slice();
      const previous = lanes[index]!;
      // A new call of the same request (a redraft) replaces what it streamed before.
      next[index] =
        previous.call === chunk.call ? { ...previous, text: previous.text + chunk.delta } : lane;
    }
    liveTextRef.current = next;
    setLiveText(next);
  }, []);

  const clearLive = () => {
    liveStepsRef.current = [];
    liveTextRef.current = [];
    setLiveSteps([]);
    setLiveText([]);
  };
  const beginRun = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    clearLive();
    return controller.signal;
  };
  const endRun = () => {
    abortRef.current = null;
    clearLive();
  };
  const cancelRun = () => abortRef.current?.abort();

  const resetRun = () => {
    store.trigger.runReset();
  };

  const select = (next: Selection) => {
    store.trigger.exampleSelected({ selection: next });
  };

  const selectMachine = (index: number) => {
    store.trigger.machineSelected({ index });
  };

  const settle = (epoch: number, turnId: number, result: AnyRunResult) => {
    endRun();
    store.trigger.turnSettled({ epoch, id: turnId, result });
  };

  const fail = (epoch: number, turnId: number, error: unknown) => {
    // An aborted fetch is the user's Cancel, not a failure worth a stack trace.
    // What the run showed before the stop stays in its turn.
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    const partial = cancelled
      ? { steps: liveStepsRef.current, text: liveTextRef.current }
      : undefined;
    endRun();
    const message = error instanceof Error ? error.message : "Agent request failed";
    store.trigger.turnFailed({ epoch, id: turnId, message, cancelled, partial });
  };

  const loading = turns.some((turn) => turn.status === "loading");
  const started = turns.length > 0;
  const interpretMode = isScenario && scenario.id === "approval" && pendingIdle !== null;
  const routing = pendingIdle ? textRouting(pendingIdle) : "none";
  // Where Jev chooses, the placeholder cannot promise one event.
  const idlePlaceholder =
    routing === "direct" && pendingIdle?.textEvent
      ? `Message becomes ${pendingIdle.textEvent.type} (${pendingIdle.textEvent.field})`
      : routing === "interpret"
        ? "Type a reply, or pick an action above…"
        : null;

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

  /**
   * Starts a library-example run with the given machine input. `followUpText`
   * is delivered as the idle text event once the run first waits for one — a
   * text starter on a machine whose input isn't a prompt (a chat loop that
   * starts idle) still runs in one click.
   */
  const startExampleRun = (
    label: string,
    machineInput: Record<string, unknown>,
    followUpText?: string,
  ) => {
    if (!activeMachine || loading) return;
    const signal = beginRun();
    const { id, epoch } = pushTurn(label, "user", "loading");
    void startExample({
      data: {
        id: selection.type === "example" ? selection.id : "",
        exportName: activeMachine.exportName,
        input: machineInput,
        room: inspection?.roomId,
      },
      signal,
    })
      .then((stream) => readRunStream(stream, appendChunk, signal, appendStep))
      .then(
        (result) => {
          settle(epoch, id, result);
          if (
            followUpText &&
            result?.status === "idle" &&
            store.getSnapshot().context.epoch === epoch
          ) {
            sendIdleText(followUpText, result.idle ?? null);
          }
        },
        (error) => fail(epoch, id, error),
      );
  };

  /**
   * Starts an example whose story spans several runs. There is no machine to
   * drive, so the server calls the example's own exported function; the result
   * settles into the thread exactly like a machine run's does.
   */
  const startExampleRunner = (label: string, exportName: string) => {
    if (loading) return;
    const signal = beginRun();
    const { id, epoch } = pushTurn(label, "user", "loading");
    void runExample({
      data: {
        id: selection.type === "example" ? selection.id : "",
        exportName,
        room: inspection?.roomId,
      },
      signal,
    })
      .then((stream) => readRunStream(stream, appendChunk, signal, appendStep))
      .then(
        (result) => settle(epoch, id, result),
        (error) => fail(epoch, id, error),
      );
  };

  /**
   * Resumes the idle machine (either run path) with a typed event, a host
   * timer firing, or free text for the server to interpret, as one new turn.
   */
  const resume = (
    event: { type: string; [key: string]: unknown } | { kind: "interpret"; text: string },
    turn: { label: string; role: Turn["role"]; eventType?: string },
  ) => {
    const { idleSnapshot } = store.getSnapshot().context;
    if (!idleSnapshot || loading) return;
    const signal = beginRun();
    const { id, epoch } = pushTurn(turn.label, turn.role, "loading", turn.eventType);
    const deliver: Promise<AnyRunResult> = isScenario
      ? resumeScenario({
          data: {
            scenarioId: scenario.id,
            snapshot: idleSnapshot as never,
            event,
            room: inspection?.roomId,
          },
          signal,
        }).then((stream) => readRunStream(stream, appendChunk, signal, appendStep))
      : resumeExample({
          data: {
            id: selection.type === "example" ? selection.id : "",
            exportName: activeMachine?.exportName ?? "",
            snapshot: idleSnapshot as never,
            event,
            room: inspection?.roomId,
          },
          signal,
        }).then((stream) => readRunStream(stream, appendChunk, signal, appendStep));
    void deliver.then(
      (result) => settle(epoch, id, result),
      (error) => fail(epoch, id, error),
    );
  };

  /** Delivers a typed event to the idle machine (either run path). */
  const sendEvent = (event: { type: string; [key: string]: unknown }) => {
    const idle = store.getSnapshot().context.pendingIdle;
    const descriptor = idle?.events.find((candidate) => candidate.type === event.type);
    const { type: _type, ...payload } = event;
    // A message typed into the composer reads as what was said, not as
    // `Send · {"text":"…"}`: the transition log below names the event.
    const textField = idle?.textEvent?.type === event.type ? idle.textEvent.field : null;
    const spokenText =
      textField && Object.keys(payload).length === 1 && typeof payload[textField] === "string"
        ? payload[textField]
        : null;
    const payloadNote = Object.keys(payload).length
      ? ` · ${JSON.stringify(payload).slice(0, 60)}`
      : "";
    const label =
      spokenText ?? `${descriptor?.label ?? humanizeEventType(event.type)}${payloadNote}`;
    resume(event, { label, role: spokenText ? "user" : "action", eventType: event.type });
  };

  // ─── host-owned timers ───
  //
  // A run waiting on a deadline settles idle with the timers it armed; the
  // browser is their scheduler. Each fires by resuming with the timer event,
  // unless the person acts first: sending anything clears `pendingIdle` (and
  // with it these timeouts), and the next idle result reports whatever is
  // still pending. Reset, selection changes and unmounting clear them too.
  const resumeRef = useRef(resume);
  resumeRef.current = resume;
  useEffect(() => {
    // Past `setTimeout`'s 32-bit range a delay would fire at once; a timer
    // that far out is left to fire never rather than immediately.
    const timers = (pendingIdle?.timers ?? []).filter((timer) => timer.delay <= 2 ** 31 - 1);
    const handles = timers.map((timer) =>
      window.setTimeout(
        () =>
          resumeRef.current(
            { type: "xstate.timer", id: timer.id },
            { label: "Timer fired", role: "action", eventType: "xstate.timer" },
          ),
        timer.delay,
      ),
    );
    return () => handles.forEach((handle) => window.clearTimeout(handle));
  }, [pendingIdle]);

  /**
   * Free text for the idle machine. When its text event is the only thing
   * text can mean, it is sent as that; when several readings are on offer
   * (buttons, the text event among them), the server reads it (Jev) as one of
   * them, or says it couldn't. False when nothing can carry text.
   */
  const sendIdleText = (text: string, idle: ChatIdle | null): boolean => {
    const routing = idle ? textRouting(idle) : "none";
    if (routing === "direct" && idle?.textEvent) {
      sendEvent({ type: idle.textEvent.type, [idle.textEvent.field]: text });
      return true;
    }
    if (routing === "interpret") {
      resume({ kind: "interpret", text }, { label: text, role: "user" });
      return true;
    }
    return false;
  };

  /** Free chat text: start a run, send or interpret it for the idle machine, or mark ignored. */
  const submit = (raw: string) => {
    const text = raw.trim();
    if (!text || loading) return;
    const { idleSnapshot } = store.getSnapshot().context;
    if (idleSnapshot && sendIdleText(text, pendingIdle)) return;

    // Not started → the prompt starts the run.
    if (!started) {
      if (isScenario) {
        const signal = beginRun();
        const { id, epoch } = pushTurn(text, "user", "loading");
        void startScenario({
          data: { scenarioId: scenario.id, prompt: text, room: inspection?.roomId },
          signal,
        })
          .then((stream) => readRunStream(stream, appendChunk, signal, appendStep))
          .then(
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
    if (missingKey) {
      return {
        visible: false,
        placeholder: "",
        submitLabel: "",
        note: missingKeyMessage(missingKeys),
      };
    }
    if (isScenario) {
      return {
        visible: true,
        placeholder: interpretMode
          ? "Say “looks good” or “that’s no good”…"
          : (idlePlaceholder ?? scenario.placeholder),
        submitLabel: interpretMode ? "Interpret review" : started ? "Send" : scenario.startLabel,
      };
    }
    if (!exampleDetail) return { visible: false, placeholder: "", submitLabel: "" };
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
      placeholder:
        idlePlaceholder ?? (started ? "Send a message…" : `${activeMachine.promptField}…`),
      submitLabel: started ? "Send" : "Start run",
    };
  })();

  const startForm =
    !isScenario && !missingKey && activeMachine && !activeMachine.promptField
      ? {
          schema: activeMachine.inputJsonSchema ?? { type: "object" as const },
          onStart: (values: Record<string, unknown>) =>
            startExampleRun(`Start · ${activeMachine.exportName}`, values),
        }
      : null;

  // Pre-baked starter inputs → one-click chips in the intro. A string starter
  // needs a chat-startable machine (single string input); an object starter is
  // the machine input verbatim.
  const offeredStarters: StarterAction[] = isScenario
    ? scenario.starters.map((text) => ({ label: text, onStart: () => submit(text) }))
    : (exampleSummary?.starters ?? []).flatMap((starter) => {
        // A runner needs no machine — it IS the whole story.
        if (starter.kind === "runner") {
          return [
            {
              label: starter.label,
              onStart: () => startExampleRunner(starter.label, starter.exportName),
            },
          ];
        }
        if (!activeMachine) return [];
        if (starter.kind === "text") {
          const field = activeMachine.promptField;
          return [
            {
              label: starter.label,
              onStart: () =>
                field
                  ? startExampleRun(starter.text, { [field]: starter.text })
                  : // No prompt input: start with defaults, then say it.
                    startExampleRun(`Start · ${activeMachine.exportName}`, {}, starter.text),
            },
          ];
        }
        return [
          { label: starter.label, onStart: () => startExampleRun(starter.label, starter.input) },
        ];
      });
  const starters = missingKey ? [] : offeredStarters;

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
      liveText={liveText}
      pendingIdle={pendingIdle}
      startForm={startForm}
      onSubmit={submit}
      onSendEvent={sendEvent}
      onCancel={cancelRun}
      onRestart={resetRun}
      textPolicy={textPolicy}
    />
  );

  // The room, not the run: once a machine is published the chart is worth
  // showing, and the first turn animates a diagram already on screen.
  const liveUrl =
    inspection && declaredKey !== null && declaredKey === inspectKey
      ? createLiveInspectUrl(inspectUrl, inspection)
      : null;
  const liveWs = inspection;

  // Without live inspection the pane draws the machine itself: the SDK embed
  // takes the machine's source (examples) or JSON config (scenarios), and the
  // plain outline is the last resort. Both light the latest settled step.
  const machineConfig: unknown = isScenario
    ? scenarioVizConfig[scenario.id]
    : (activeMachine?.vizConfig ?? null);
  const outlineConfig = isScenario
    ? scenarioVizConfig[scenario.id]
    : activeMachine && typeof activeMachine.vizConfig === "object"
      ? activeMachine.vizConfig
      : null;
  const latestStep = (() => {
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index];
      if (turn.status !== "ready" || !turn.result) continue;
      const last = turn.result.trace[turn.result.trace.length - 1];
      if (!last) continue;
      const status =
        turn.result.status === "done"
          ? "done"
          : turn.result.status === "error"
            ? "error"
            : "active";
      return { value: last.value, context: last.context, event: last.event, status } as const;
    }
    return null;
  })();

  const vizPanel = (
    <VizPanel
      title={headerName}
      hasMachine={isScenario || !!activeMachine?.vizConfig}
      inspectionUnavailable={inspectionChecked && !inspection}
      machineKey={inspectKey ?? ""}
      machineConfig={machineConfig}
      outlineConfig={outlineConfig}
      step={latestStep}
      theme={theme}
      liveWs={liveWs}
      liveUrl={liveUrl}
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
