import { useRef, useState, useSyncExternalStore } from "react";
import { Braces, Menu, X } from "lucide-react";
import { AppPanel, type PendingIdle, type Turn } from "@/components/app-panel";
import { CodePanel } from "@/components/code-panel";
import { ExamplesSidebar } from "@/components/examples-sidebar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { VizPanel } from "@/components/viz-panel";
import { useTracePlayer } from "@/hooks/use-trace-player";
import { resumeScenario, startScenario, type ScenarioResult } from "@/lib/run-demo-agent";
import { getScenario, type ScenarioId } from "@/lib/scenarios";

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

export function DemoShell() {
  const [selectedId, setSelectedId] = useState<ScenarioId>("refund");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("app");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pendingIdle, setPendingIdle] = useState<PendingIdle | null>(null);
  const requestRef = useRef(0);
  const idleSnapshotRef = useRef<ScenarioResult["idle"] | null>(null);
  const isMobile = useSyncExternalStore(subscribeToMobileQuery, getMobileSnapshot, () => false);
  const scenario = getScenario(selectedId);
  const player = useTracePlayer(selectedId);

  const resetRun = () => {
    requestRef.current += 1;
    setInput("");
    setTurns([]);
    setPendingIdle(null);
    idleSnapshotRef.current = null;
    player.reset();
  };

  const selectScenario = (id: ScenarioId) => {
    resetRun();
    setSelectedId(id);
    setMobileMenuOpen(false);
    setMobileView("app");
  };

  const settle = (requestId: number, turnId: number, result: ScenarioResult) => {
    if (requestRef.current !== requestId) return;
    setTurns((current) =>
      current.map((turn) => (turn.id === turnId ? { ...turn, status: "ready", result } : turn)),
    );
    player.play(result.trace);
    if (result.status === "idle" && result.idle) {
      idleSnapshotRef.current = result.idle;
      setPendingIdle({
        scenarioId: scenario.id,
        acceptedEvents: result.idle.acceptedEvents,
        prompt: result.idle.prompt,
      });
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

  const submit = (prompt: string) => {
    const text = prompt.trim();
    if (!text || turns.some((turn) => turn.status === "loading")) return;
    const requestId = ++requestRef.current;
    const turnId = requestId;
    setTurns((current) => [...current, { id: turnId, input: text, role: "user", status: "loading" }]);
    setInput("");

    // Approval scenario while idle → interpret the free text into an event.
    if (pendingIdle?.scenarioId === "approval" && idleSnapshotRef.current) {
      void resumeScenario({
        data: { scenarioId: scenario.id, snapshot: idleSnapshotRef.current.snapshot, event: { kind: "interpret", text } },
      }).then((result) => settle(requestId, turnId, result), (error) => fail(requestId, turnId, error));
      return;
    }

    void startScenario({ data: { scenarioId: scenario.id, prompt: text } }).then(
      (result) => settle(requestId, turnId, result),
      (error) => fail(requestId, turnId, error),
    );
  };

  const resume = (event: { type: string; [key: string]: unknown }) => {
    const idle = idleSnapshotRef.current;
    if (!idle || turns.some((turn) => turn.status === "loading")) return;
    const requestId = ++requestRef.current;
    const turnId = requestId;
    const label = event.type === "APPROVE" ? "Approve" : event.type === "DENY" ? "Deny" : "Reject";
    setTurns((current) => [...current, { id: turnId, input: label, role: "action", status: "loading" }]);
    setPendingIdle(null);
    void resumeScenario({ data: { scenarioId: scenario.id, snapshot: idle.snapshot, event } }).then(
      (result) => settle(requestId, turnId, result),
      (error) => fail(requestId, turnId, error),
    );
  };

  const appPanel = (
    <AppPanel
      scenario={scenario}
      turns={turns}
      pendingIdle={pendingIdle}
      input={input}
      onInputChange={setInput}
      onSubmit={submit}
      onResume={resume}
      onRestart={resetRun}
    />
  );

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
        <span className="header-example">{scenario.name}</span>
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
                selectedId={selectedId}
                onSelect={selectScenario}
              />
            </div>
            <div className="desktop-workspace">
              <ResizablePanelGroup orientation="horizontal">
                <ResizablePanel defaultSize={34} minSize={26}>
                  {appPanel}
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel defaultSize={44} minSize={30}>
                  <VizPanel scenario={scenario} frame={player.frame} />
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel defaultSize={22} minSize={16}>
                  <CodePanel scenario={scenario} />
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          </>
        )}

        {isMobile && (
          <div className="mobile-workspace">
            {mobileView === "app" ? appPanel : null}
            {mobileView === "machine" ? <VizPanel scenario={scenario} frame={player.frame} /> : null}
            {mobileView === "code" ? <CodePanel scenario={scenario} /> : null}
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
              selectedId={selectedId}
              onSelect={selectScenario}
            />
          </div>
        </div>
      )}
    </div>
  );
}
