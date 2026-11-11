/**
 * A static outline of a machine — states, their transitions, and what each
 * invokes — with the active states lit. It stands in for the hosted
 * inspector when the relay cannot be reached (offline, a blocked socket, a
 * slow first load), so the right pane still shows the statechart the chat is
 * driving instead of an empty canvas.
 *
 * Rendered from a plain-JSON view of the machine's config. Example outlines
 * also mark function transitions whose targets are chosen at runtime.
 */
import type { ReactNode } from "react";
import type { DiagramHints } from "@/lib/scenarios";

type VizNode = Record<string, unknown>;

/** Set of dotted paths that are active for a snapshot `value`, e.g. `a`, `a.b`. */
export function activePaths(value: unknown, prefix = ""): Set<string> {
  const out = new Set<string>();
  if (typeof value === "string") {
    out.add(prefix ? `${prefix}.${value}` : value);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.add(path);
      for (const nested of activePaths(child, path)) out.add(nested);
    }
  }
  return out;
}

function targetsOf(transition: unknown): string[] {
  if (!transition || typeof transition !== "object") return [];
  if (Array.isArray(transition)) return transition.flatMap(targetsOf);
  const target = (transition as { target?: unknown }).target;
  if (typeof target === "string") return [target.replace(/^#?\.?/, "")];
  if (Array.isArray(target)) return target.filter((t): t is string => typeof t === "string");
  return [];
}

function transitionRows(
  node: VizNode,
): Array<{ event: string; targets: string[]; dynamic?: boolean }> {
  const rows: Array<{ event: string; targets: string[]; dynamic?: boolean }> = [];
  const on = node.on as Record<string, unknown> | undefined;
  for (const [event, transition] of Object.entries(on ?? {})) {
    rows.push({ event, targets: targetsOf(transition), dynamic: hasDynamic(transition) });
  }
  const invokes = Array.isArray(node.invoke) ? node.invoke : node.invoke ? [node.invoke] : [];
  for (const invoke of invokes as Array<Record<string, unknown>>) {
    const src = typeof invoke.src === "string" ? invoke.src : "actor";
    if (invoke.onDone)
      rows.push({
        event: `${src} ✓`,
        targets: targetsOf(invoke.onDone),
        dynamic: hasDynamic(invoke.onDone),
      });
    if (invoke.onError)
      rows.push({
        event: `${src} ✗`,
        targets: targetsOf(invoke.onError),
        dynamic: hasDynamic(invoke.onError),
      });
  }
  if (node.onDone)
    rows.push({ event: "done", targets: targetsOf(node.onDone), dynamic: hasDynamic(node.onDone) });
  if (node.always)
    rows.push({
      event: "always",
      targets: targetsOf(node.always),
      dynamic: hasDynamic(node.always),
    });
  return rows;
}

function hasDynamic(transition: unknown): boolean {
  if (Array.isArray(transition)) return transition.some(hasDynamic);
  return !!transition && typeof transition === "object" && "dynamic" in transition;
}

/** Initial active paths, including every region of a parallel state. */
export function initialActivePaths(config: VizNode): Set<string> {
  const active = new Set<string>();
  const visit = (node: VizNode, path: string) => {
    active.add(path);
    const children = (node.states ?? {}) as Record<string, VizNode>;
    if (node.type === "parallel") {
      for (const [name, child] of Object.entries(children))
        visit(child, path ? `${path}.${name}` : name);
    } else if (typeof node.initial === "string" && children[node.initial]) {
      visit(children[node.initial], path ? `${path}.${node.initial}` : node.initial);
    }
  };
  visit(config, "");
  active.delete("");
  return active;
}

function StateNode({
  name,
  node,
  path,
  active,
  hints,
}: {
  name: string;
  node: VizNode;
  path: string;
  active: Set<string>;
  hints?: DiagramHints | null;
}): ReactNode {
  const isActive = active.has(path);
  const kind = node.type === "final" ? "final" : node.type === "parallel" ? "parallel" : "state";
  const children = (node.states ?? {}) as Record<string, VizNode>;
  const hinted = hints?.[path] ?? [];
  const staticRows = transitionRows(node);
  const rows: Array<{ event: string; targets: string[]; dynamic?: boolean }> = [
    ...staticRows.filter(
      (row) => !row.dynamic || !hinted.some((hint) => hint.event.startsWith(row.event)),
    ),
    ...hinted.filter(
      (hint) =>
        !staticRows.some(
          (row) =>
            row.event === hint.event &&
            row.targets.length === hint.targets.length &&
            row.targets.every((target, index) => target === hint.targets[index]),
        ),
    ),
  ];
  return (
    <li className="state-outline__state" data-active={isActive || undefined} data-kind={kind}>
      <div className="state-outline__name">
        <span className="state-outline__dot" aria-hidden="true" />
        <span>{name}</span>
        {kind !== "state" && <span className="state-outline__kind">{kind}</span>}
        {isActive && <span className="state-outline__active">active</span>}
      </div>
      {rows.length > 0 && (
        <ul className="state-outline__transitions">
          {rows.map((row, index) => (
            <li key={`${row.event}-${index}`}>
              <span className="state-outline__event">{row.event}</span>
              {row.targets.length > 0 && (
                <>
                  <span className="state-outline__arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="state-outline__target">{row.targets.join(", ")}</span>
                </>
              )}
              {row.dynamic && <span className="state-outline__target">runtime decision</span>}
            </li>
          ))}
        </ul>
      )}
      {Object.keys(children).length > 0 && (
        <ul className="state-outline__children">
          {Object.entries(children).map(([childName, child]) => (
            <StateNode
              key={childName}
              name={childName}
              node={child}
              path={`${path}.${childName}`}
              active={active}
              hints={hints}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function StateOutline({
  title,
  config,
  value,
  hints,
  inspectionStatus = "unavailable",
}: {
  title: string;
  config: VizNode;
  /** The latest snapshot `value`, or null before a run starts. */
  value: unknown;
  hints?: DiagramHints | null;
  inspectionStatus?: "available" | "loading" | "unavailable";
}) {
  const states = (config.states ?? {}) as Record<string, VizNode>;
  const active = value == null ? initialActivePaths(config) : activePaths(value);
  return (
    <div className="state-outline" role="region" aria-label={`Statechart outline for ${title}`}>
      <p className="state-outline__note" role="status">
        {inspectionStatus === "available"
          ? "This outline lists the machine's states and transitions. Open full chart for the live diagram. The active state follows the run."
          : inspectionStatus === "loading"
            ? "Publishing the live chart. This outline shows the machine while it connects. The active state follows the run."
            : "Live inspection is unavailable, so this is the machine's outline. The active state follows the run."}
      </p>
      <ul className="state-outline__children state-outline__root">
        {Object.entries(states).map(([name, node]) => (
          <StateNode key={name} name={name} node={node} path={name} active={active} hints={hints} />
        ))}
      </ul>
    </div>
  );
}
