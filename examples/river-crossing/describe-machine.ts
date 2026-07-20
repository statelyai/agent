/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ EXPERIMENTAL PROTOTYPE — not a stable API. Hand-rolled, example-local,│
 * │ and leans on zod/xstate introspection (`.shape`, `._zod.def.type`,    │
 * │ `machine.config`) that may break across minor versions. Do not depend │
 * │ on it outside this example; a real core helper is sketched below.     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * A hand-rolled renderer of a machine's shape into compact markdown for
 * injection into an LLM prompt. Kept in its own file so `river-crossing/index.ts`
 * reads as a clean "machine as verifiable environment" example; it re-exports
 * `describeMachine` for callers and tests.
 *
 * Graph utilities live at the `xstate/graph` subpath in v6 (the standalone
 * `@xstate/graph` package is dead), and a self-contained machine's config
 * serializes to LLM-readable JSON. This prototype stays dependency-free and
 * derives what it can *generically* from `machine.config` (state names,
 * per-state transition event keys, invoke sources, final states) and from the
 * agent schema pack (event payload field names/types). The parts a static graph
 * can't know — *why* a transition is guarded, i.e. the actual legality rules —
 * are passed in as `rules` text by the example.
 *
 * A real core helper (`agent.describe(machine)`?) would need xstate v6 to
 * expose, per transition, a machine-readable guard descriptor (name + human
 * label) rather than an opaque function, so the "unsafe pair" rules could be
 * derived instead of hand-written. Until then this stays example-local and
 * honest about the split.
 */
export function describeMachine(
  machine: {
    config: {
      id?: string;
      initial?: unknown;
      states?: Record<string, unknown>;
    };
  },
  schemas: { events: Record<string, unknown> },
  extra?: { title?: string; rules?: string[] },
): string {
  const config = machine.config;
  const states = config.states ?? {};
  const lines: string[] = [];

  lines.push(`# ${extra?.title ?? config.id ?? "machine"}`);
  if (extra?.rules?.length) {
    lines.push("", "## Rules", ...extra.rules.map((rule) => `- ${rule}`));
  }

  lines.push("", "## Events (each carries a `reasoning` string)");
  for (const [name, schema] of Object.entries(schemas.events)) {
    lines.push(`- **${name}**${renderEventFields(schema)}`);
  }

  lines.push("", "## States");
  for (const [name, node] of Object.entries(states) as [string, StateNodeShape][]) {
    const parts: string[] = [];
    if (name === config.initial) parts.push("initial");
    if (node?.type === "final") parts.push("final");
    const invokeSrc = typeof node?.invoke?.src === "string" ? node.invoke.src : undefined;
    if (invokeSrc) parts.push(`invokes \`${invokeSrc}\``);
    const events = node?.on ? Object.keys(node.on) : [];
    if (events.length) parts.push(`accepts ${events.map((event) => `\`${event}\``).join(", ")}`);
    lines.push(`- **${name}**${parts.length ? ` — ${parts.join("; ")}` : ""}`);
  }

  return lines.join("\n");
}

interface StateNodeShape {
  type?: string;
  invoke?: { src?: unknown };
  on?: Record<string, unknown>;
}

// Renders a zod event schema's non-`reasoning` fields as `(field: type, …)`.
// Best-effort against zod v4's `.shape` / `._def.type`; empty when only
// `reasoning` is present.
function renderEventFields(schema: unknown): string {
  const shape = (schema as { shape?: Record<string, unknown> })?.shape;
  if (!shape) return "";
  const fields = Object.entries(shape)
    .filter(([key]) => key !== "reasoning")
    .map(([key, field]) => `${key}: ${zodTypeName(field)}`);
  return fields.length ? ` (${fields.join(", ")})` : "";
}

// zod v4 exposes the type tag on its internals namespace `._zod.def.type`
// (e.g. "string", "number", "enum"); the legacy `._def.type` still works via
// the v3 compat layer. Prefer the newer accessor, fall back to the old one.
// Still introspection into private-ish shape — see the describeMachine banner.
function zodTypeName(field: unknown): string {
  const zodDef = (field as { _zod?: { def?: { type?: string } } })?._zod?.def;
  const legacyDef = (field as { _def?: { type?: string; typeName?: string } })?._def;
  return zodDef?.type ?? legacyDef?.type ?? legacyDef?.typeName ?? "value";
}
