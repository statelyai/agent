import { useEffect, useMemo, useRef } from "react";
import { useSelector } from "@xstate/store-react";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, Moon, Sun } from "lucide-react";
import { scenarios } from "@/lib/scenarios";
import type { ExampleSummary } from "@/lib/example-library";
import type { Selection } from "@/lib/selection";
import type { ShellStore } from "@/lib/shell-store";

/** Stately brand mark. Body follows `currentColor`; the head dot uses the accent. */
function LogoSlot() {
  return (
    <svg className="logo-slot" width="26" height="26" viewBox="0 0 400 400" aria-hidden="true">
      <path
        fill="currentColor"
        d="M160.048396,62 L200.37018,102.226265 L313.959955,215.546521 L313.959955,215.570808 C315.837975,217.466064 317,220.069114 317,222.944958 C317,226.157786 315.548447,229.029294 313.267435,230.954041 L208.213956,335.758657 C203.882338,340.080448 196.858891,340.080448 192.527273,335.758657 L87.2490397,230.730253 C82.9169868,226.408463 82.9169868,219.401654 87.2490397,215.080297 L152.153757,150.3289 L159.394132,157.552991 C169.631514,167.11948 186.170262,195.360094 164.012235,218.951043 C161.846426,221.111288 161.846426,224.615126 164.012235,226.775804 L196.490243,259.176874 C198.656487,261.337552 202.167775,261.337552 204.334019,259.176874 L236.707692,226.879891 C237.766686,225.869377 238.504418,224.471572 238.504418,222.894216 C238.504418,221.359796 237.836243,219.971098 236.827242,218.965788 L209.069933,191.274668 L209.153401,191.191832 L160.173597,142.328058 C137.904715,120.111929 137.779514,84.2165628 160.048396,62 Z"
      />
      <path
        fill="var(--primary)"
        d="M244.500217,62 C260.239954,62 273,74.7595142 273,90.5 C273,106.240051 260.239954,119 244.500217,119 C228.760046,119 216,106.240051 216,90.5 C216,74.7595142 228.760046,62 244.500217,62 Z"
      />
    </svg>
  );
}

type SwitcherRow = {
  selection: Selection;
  title: string;
  purpose: string;
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
      })),
    },
  ];

  const byKind = new Map<string, SwitcherRow[]>();
  for (const example of examples) {
    const row: SwitcherRow = {
      selection: { type: "example", id: example.id },
      title: example.title,
      purpose: example.purpose ?? example.kind,
    };
    const rows = byKind.get(example.kind) ?? [];
    rows.push(row);
    byKind.set(example.kind, rows);
  }
  // Key requirement is uniform within a group, so it lives in the group
  // label — a badge repeated on every row is noise.
  for (const [kind, rows] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    groups.push({ label: `${kind.replace(/-/g, " ")} · API key`, rows });
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
