import { useEffect, useMemo, useRef } from "react";
import { useSelector } from "@xstate/store-react";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, Moon, Sun } from "lucide-react";
import { scenarios } from "@/lib/scenarios";
import type { ExampleSummary } from "@/lib/example-library";
import type { Selection } from "@/lib/selection";
import type { ShellStore } from "@/lib/shell-store";

/**
 * Header logo slot. Placeholder per the design handoff (dashed rounded rect +
 * accent dot) — swap the SVG for the real Stately brand mark.
 */
function LogoSlot() {
  return (
    <svg className="logo-slot" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <rect
        x="1.5"
        y="1.5"
        width="23"
        height="23"
        rx="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
      <circle cx="13" cy="13" r="3.5" fill="var(--primary)" />
    </svg>
  );
}

type SwitcherRow = {
  selection: Selection;
  title: string;
  purpose: string;
  keyless: boolean;
};

type SwitcherGroup = { label: string; rows: SwitcherRow[] };

function buildGroups(examples: ExampleSummary[], query: string): SwitcherGroup[] {
  const trimmed = query.trim().toLowerCase();
  const matches = (row: SwitcherRow) =>
    !trimmed ||
    row.title.toLowerCase().includes(trimmed) ||
    row.purpose.toLowerCase().includes(trimmed) ||
    (row.selection.type === "example" && row.selection.id.includes(trimmed));

  // Keyless (scripted-fallback) scenarios lead; library examples group by kind.
  const groups: SwitcherGroup[] = [
    {
      label: "Interactive · no key needed",
      rows: scenarios.map((scenario) => ({
        selection: { type: "scenario", id: scenario.id } as const,
        title: scenario.name,
        purpose: scenario.eyebrow,
        keyless: true,
      })),
    },
  ];

  const byKind = new Map<string, SwitcherRow[]>();
  for (const example of examples) {
    const row: SwitcherRow = {
      selection: { type: "example", id: example.id },
      title: example.title,
      purpose: example.purpose ?? example.kind,
      keyless: false,
    };
    const rows = byKind.get(example.kind) ?? [];
    rows.push(row);
    byKind.set(example.kind, rows);
  }
  for (const [kind, rows] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    groups.push({ label: kind.replace(/-/g, " "), rows });
  }

  return groups
    .map((group) => ({ ...group, rows: group.rows.filter(matches) }))
    .filter((group) => group.rows.length > 0);
}

function sameSelection(a: Selection, b: Selection) {
  return a.type === b.type && a.id === b.id;
}

type SiteHeaderProps = {
  store: ShellStore;
  examples: ExampleSummary[];
  currentTitle: string;
  onSelect: (selection: Selection) => void;
};

export function SiteHeader({ store, examples, currentTitle, onSelect }: SiteHeaderProps) {
  const selection = useSelector(store, (s) => s.context.selection);
  const open = useSelector(store, (s) => s.context.switcherOpen);
  const query = useSelector(store, (s) => s.context.switcherQuery);
  const theme = useSelector(store, (s) => s.context.theme);
  const listRef = useRef<HTMLDivElement>(null);

  const keyless = selection.type === "scenario";
  const groups = useMemo(() => buildGroups(examples, query), [examples, query]);
  const total = scenarios.length + examples.length;

  // ⌘K / Ctrl-K toggles the switcher from anywhere.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        store.trigger.switcherToggled();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  const moveFocus = (delta: 1 | -1) => {
    const items = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(".switcher-row") ?? []),
    ];
    if (items.length === 0) return;
    const active = document.activeElement;
    const index = items.findIndex((item) => item === active);
    const next = index === -1 ? (delta === 1 ? 0 : items.length - 1) : index + delta;
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="Stately Agent home">
        <LogoSlot />
        <strong>Stately Agent</strong>
      </a>
      <span className="brand-separator" aria-hidden="true">
        /
      </span>

      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          if (next !== open) store.trigger.switcherToggled();
        }}
      >
        <Popover.Trigger className="switcher-trigger">
          <span className="switcher-trigger__title">{currentTitle}</span>
          {keyless && <span className="key-badge">no key needed</span>}
          <ChevronDown size={14} aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner align="start" sideOffset={8}>
            <Popover.Popup className="switcher-popup" aria-label="Switch example">
              <input
                className="switcher-search"
                type="search"
                autoFocus
                placeholder={`Search ${total} examples…`}
                value={query}
                onChange={(event) =>
                  store.trigger.switcherQueryChanged({ query: event.target.value })
                }
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveFocus(1);
                  }
                }}
                aria-label="Search examples"
              />
              <div
                className="switcher-list"
                ref={listRef}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveFocus(1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    moveFocus(-1);
                  }
                }}
              >
                {groups.map((group) => (
                  <div key={group.label} className="switcher-group">
                    <span className="switcher-group__label">{group.label}</span>
                    {group.rows.map((row) => {
                      const active = sameSelection(row.selection, selection);
                      return (
                        <button
                          key={`${row.selection.type}:${row.selection.id}`}
                          className="switcher-row"
                          data-active={active || undefined}
                          onClick={() => onSelect(row.selection)}
                        >
                          <span className="switcher-row__dot" aria-hidden="true" />
                          <span className="switcher-row__text">
                            <strong>{row.title}</strong>
                            <small>{row.purpose}</small>
                          </span>
                          {row.keyless ? (
                            <span className="key-badge">no key</span>
                          ) : (
                            <span className="key-badge key-badge--needs">API key</span>
                          )}
                          {active && <Check size={13} aria-label="Current example" />}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {groups.length === 0 && <p className="switcher-empty">No examples match.</p>}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      <span className="site-header__spacer" />

      <button
        className="kbd-chip"
        onClick={() => store.trigger.switcherToggled()}
        aria-label="Open example switcher"
      >
        ⌘K
      </button>
      <button
        className="icon-button"
        onClick={() => store.trigger.themeToggled()}
        aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      >
        {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </header>
  );
}
