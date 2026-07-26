import { Collapsible } from "@base-ui/react/collapsible";
import {
  Boxes,
  Eye,
  Gauge,
  GitFork,
  ListTree,
  PanelLeftClose,
  PanelLeftOpen,
  Puzzle,
  RefreshCcw,
  Scale,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { scenarios, type ScenarioId } from "@/lib/scenarios";
import type { ExampleSummary } from "@/lib/example-library";
import type { Selection } from "@/lib/selection";

const icons = {
  refund: ShieldCheck,
  approval: UserCheck,
  routing: ListTree,
  research: GitFork,
  pipeline: Workflow,
  retry: RefreshCcw,
  tools: Wrench,
  reflection: Sparkles,
} satisfies Record<ScenarioId, typeof ShieldCheck>;

/** Library examples are grouped by their metadata `kind`; each kind gets an icon. */
const kindIcons: Record<string, typeof ShieldCheck> = {
  "agent-workflow": Workflow,
  pattern: Puzzle,
  comparison: Scale,
  "host-adapter": Server,
  "multi-agent": Users,
  evaluation: Gauge,
  observability: Eye,
  search: Search,
};

function iconForKind(kind: string): typeof ShieldCheck {
  return kindIcons[kind] ?? Boxes;
}

type ExamplesSidebarProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  /** Auto-discovered examples from `examples/*` (empty until loaded). */
  examples: ExampleSummary[];
  mobile?: boolean;
};

export function ExamplesSidebar({
  open,
  onOpenChange,
  selection,
  onSelect,
  examples,
  mobile = false,
}: ExamplesSidebarProps) {
  const isScenario = (id: ScenarioId) => selection.type === "scenario" && selection.id === id;
  const isExample = (id: string) => selection.type === "example" && selection.id === id;

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={onOpenChange}
      className={cn("examples-sidebar", mobile && "examples-sidebar--mobile")}
    >
      <div className="examples-sidebar__topline">
        {open && <span className="examples-sidebar__label">Examples</span>}
        <Collapsible.Trigger
          className="icon-button"
          aria-label={open ? "Collapse examples" : "Expand examples"}
        >
          {open ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </Collapsible.Trigger>
      </div>

      <Collapsible.Panel className="examples-sidebar__panel">
        <nav aria-label="Demo examples" className="examples-sidebar__scroll">
          <span className="examples-sidebar__section">Interactive</span>
          <ul className="example-list">
            {scenarios.map((scenario) => {
              const Icon = icons[scenario.id];
              return (
                <li key={scenario.id}>
                  <button
                    className="example-item"
                    data-active={isScenario(scenario.id) || undefined}
                    onClick={() => onSelect({ type: "scenario", id: scenario.id })}
                    aria-current={isScenario(scenario.id) ? "page" : undefined}
                  >
                    <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
                    <span>
                      <strong>{scenario.name}</strong>
                      <small>{scenario.eyebrow}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <span className="examples-sidebar__section">Library</span>
          <ul className="example-list">
            {examples.length === 0 && <li className="example-list__empty">Loading examples…</li>}
            {examples.map((example) => {
              const Icon = iconForKind(example.kind);
              return (
                <li key={example.id}>
                  <button
                    className="example-item"
                    data-active={isExample(example.id) || undefined}
                    onClick={() => onSelect({ type: "example", id: example.id })}
                    aria-current={isExample(example.id) ? "page" : undefined}
                  >
                    <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
                    <span>
                      <strong>{example.title}</strong>
                      <small>{example.kind}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </Collapsible.Panel>

      {!open && (
        <nav className="example-rail" aria-label="Demo examples">
          {scenarios.map((scenario) => {
            const Icon = icons[scenario.id];
            return (
              <button
                key={scenario.id}
                className="example-rail__item"
                data-active={isScenario(scenario.id) || undefined}
                onClick={() => onSelect({ type: "scenario", id: scenario.id })}
                aria-label={scenario.name}
                title={scenario.name}
              >
                <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
              </button>
            );
          })}
        </nav>
      )}
    </Collapsible.Root>
  );
}
