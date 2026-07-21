import { Collapsible } from "@base-ui/react/collapsible";
import {
  GitFork,
  ListTree,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Wrench,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { scenarios, type ScenarioId } from "@/lib/scenarios";

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

type ExamplesSidebarProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedId: ScenarioId;
  onSelect: (id: ScenarioId) => void;
  mobile?: boolean;
};

export function ExamplesSidebar({
  open,
  onOpenChange,
  selectedId,
  onSelect,
  mobile = false,
}: ExamplesSidebarProps) {
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
        <nav aria-label="Demo examples">
          <ul className="example-list">
            {scenarios.map((scenario) => {
              const Icon = icons[scenario.id];
              return (
                <li key={scenario.id}>
                  <button
                    className="example-item"
                    data-active={scenario.id === selectedId || undefined}
                    onClick={() => onSelect(scenario.id)}
                    aria-current={scenario.id === selectedId ? "page" : undefined}
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
                data-active={scenario.id === selectedId || undefined}
                onClick={() => onSelect(scenario.id)}
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
