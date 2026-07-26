import { Bot, Eye, Play, Terminal } from "lucide-react";
import type { ExampleDetail, ExampleSummary } from "@/lib/example-library";
import type { Scenario, ScenarioId } from "@/lib/scenarios";

export type StarterAction = { label: string; onStart: () => void };

/** One-click pre-baked inputs: click a chip and the run starts with it. */
export function StarterChips({ starters }: { starters: StarterAction[] }) {
  if (starters.length === 0) return null;
  return (
    <div className="starter-chips" role="group" aria-label="Try an example input">
      <span className="starter-chips__label">Try one:</span>
      {starters.map((starter, index) => (
        <button key={index} className="starter-chip" onClick={starter.onStart}>
          <Play size={11} aria-hidden="true" />
          <span>{starter.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Presentational "what to watch for" hints per scenario, keyed off the id. */
const watchHints: Record<ScenarioId, string> = {
  refund: "The amount is over $100, so the machine routes to human approval — the model never gets to auto-refund.",
  approval: "The run pauses in an idle state. Nothing publishes until you approve — that's the human in the loop.",
  routing: "The model returns one typed event; watch the statechart jump to exactly one branch.",
  research: "Two regions light up at once, then converge — the machine waits for both before synthesizing.",
  pipeline: "Three states run in order. Each has its own output and its own failure boundary.",
  retry: "Watch the retry counter and the switch to the fallback model when the primary call fails.",
  tools: "The loop is capped by the machine — after the budget, it's forced to answer instead of calling more tools.",
  reflection: "Draft → score → revise repeats until the score clears the bar or the budget runs out.",
};

export function ScenarioIntro({
  scenario,
  starters,
}: {
  scenario: Scenario;
  starters: StarterAction[];
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__badge" aria-hidden="true">
        <Bot size={18} />
      </div>
      <span className="empty-state__eyebrow">{scenario.eyebrow}</span>
      <p className="empty-state__lead">{scenario.description}</p>
      <div className="empty-state__watch">
        <span className="empty-state__watch-label">
          <Eye size={13} aria-hidden="true" />
          Watch for
        </span>
        <p>{watchHints[scenario.id]}</p>
      </div>
      <StarterChips starters={starters} />
    </div>
  );
}

type ExampleIntroProps = {
  summary: ExampleSummary;
  detail: ExampleDetail | null;
  error: string | null;
  machineIndex: number;
  onSelectMachine: (index: number) => void;
  starters: StarterAction[];
};

/** Empty-state for a library example: metadata, machine picker, how to run it locally. */
export function ExampleIntro({
  summary,
  detail,
  error,
  machineIndex,
  onSelectMachine,
  starters,
}: ExampleIntroProps) {
  return (
    <div className="empty-state example-intro">
      <div className="empty-state__badge" aria-hidden="true">
        <Bot size={18} />
      </div>
      <span className="empty-state__eyebrow">{summary.kind}</span>
      {summary.purpose ? <p className="empty-state__lead">{summary.purpose}</p> : null}

      {error ? <p className="example-panel__error">Failed to load this example: {error}</p> : null}
      {!detail && !error ? <p className="example-panel__loading">Loading example…</p> : null}

      {detail?.importError ? (
        <p className="example-panel__error">
          Could not import the example module on the server: {detail.importError}
        </p>
      ) : null}

      {detail && detail.machines.length > 1 ? (
        <div className="example-panel__machines" role="group" aria-label="Exported machines">
          <span className="panel-kicker">Machines</span>
          {detail.machines.map((machine, index) => (
            <button
              key={machine.exportName}
              className="example-panel__machine"
              data-active={index === machineIndex || undefined}
              onClick={() => onSelectMachine(index)}
            >
              {machine.exportName}
            </button>
          ))}
        </div>
      ) : null}

      <StarterChips starters={starters} />

      {detail ? (
        <div className="example-panel__run">
          <span className="panel-kicker">
            <Terminal size={13} aria-hidden="true" /> Run it locally
          </span>
          <pre>
            <code>pnpm tsx examples/{summary.id}/index.ts</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}
