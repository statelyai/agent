import type { ExampleDetail, ExampleSummary } from "@/lib/example-library";
import type { Scenario } from "@/lib/scenarios";

export type StarterAction = { label: string; onStart: () => void };

/** One-click pre-baked inputs: click a chip and the run starts with it. */
export function StarterChips({ starters }: { starters: StarterAction[] }) {
  if (starters.length === 0) return null;
  return (
    <div className="chat-starters" role="group" aria-label="Try an example input">
      {starters.map((starter, index) => (
        <button key={index} className="chat-starter" onClick={starter.onStart}>
          {starter.label}
        </button>
      ))}
    </div>
  );
}

export function ScenarioIntro({
  scenario,
  starters,
}: {
  scenario: Scenario;
  starters: StarterAction[];
}) {
  return (
    <div className="chat-intro">
      <h2 className="chat-intro__title">{scenario.name}</h2>
      <p className="chat-intro__purpose">{scenario.description}</p>
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

/** Empty-state for a library example: title, purpose, machine picker, starters. */
export function ExampleIntro({
  summary,
  detail,
  error,
  machineIndex,
  onSelectMachine,
  starters,
}: ExampleIntroProps) {
  return (
    <div className="chat-intro">
      <h2 className="chat-intro__title">{summary.title}</h2>
      {summary.purpose ? <p className="chat-intro__purpose">{summary.purpose}</p> : null}

      {error ? <p className="chat-intro__error">Failed to load this example: {error}</p> : null}
      {!detail && !error ? <p className="chat-intro__status">Loading example…</p> : null}

      {detail?.importError ? (
        <p className="chat-intro__error">
          Could not import the example module on the server: {detail.importError}
        </p>
      ) : null}

      {detail && detail.machines.length > 1 ? (
        <div className="chat-intro__machines" role="group" aria-label="Exported machines">
          {detail.machines.map((machine, index) => (
            <button
              key={machine.exportName}
              className="chat-intro__machine"
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
        <p className="chat-intro__run">pnpm tsx examples/{summary.id}/index.ts</p>
      ) : null}
    </div>
  );
}
