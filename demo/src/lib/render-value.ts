/**
 * Readable chat text for whatever a machine produced: a run's output and the
 * work an idle snapshot holds. Common shapes read as prose and markdown —
 * multi-line text as paragraphs, lists as bullets, records as a table or one
 * bullet each, chat message arrays as a transcript, objects as labeled
 * fields — and only structure too deep for that falls back to fenced JSON.
 */
import { humanizeFieldName } from "./machine-ui";

/** A value short enough to sit on one line after a label. */
const INLINE_CHARS = 80;
/** Longest cell in a table; wider rows read better as one bullet per item. */
const TABLE_CELL_CHARS = 60;
/** Most columns a table gets before items fall back to bullets. */
const TABLE_KEYS = 5;
/** Most items of a list rendered before the rest are counted. */
const LIST_ITEMS = 20;
/** Most messages of a transcript rendered — the newest ones. */
const TRANSCRIPT_MESSAGES = 20;
/** Longest text kept per bullet continuation, cell-free field, or message. */
const BLOCK_CHARS = 1200;

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line of text: whitespace collapsed, cut to `max`. */
function oneLine(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

/** Fits on one line after a label: a number, a boolean, or a short single-line string. */
function isInline(value: unknown): value is Scalar {
  if (typeof value === "number" || typeof value === "boolean") return true;
  return typeof value === "string" && !value.includes("\n") && value.length <= INLINE_CHARS;
}

/**
 * Multi-line text as markdown. A bare newline is not a line break in
 * markdown, so single newlines become hard breaks — "To: Priya\nSubject: …"
 * keeps its two lines instead of collapsing into one. Text that carries its
 * own fenced code is already markdown and passes through.
 */
function prose(text: string): string {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  if (trimmed.includes("```")) return trimmed;
  return trimmed.replace(/\n{3,}/g, "\n\n").replace(/([^\n])\n(?=[^\n])/g, "$1  \n");
}

/** A string holding a JSON object or array (a model's structured text), parsed. */
function parsedJsonString(text: string): object | null {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function jsonFence(value: unknown): string | null {
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? null : "```json\n" + json + "\n```";
  } catch {
    return null;
  }
}

/** A compact one-line rendering of any value, for a bullet or a tool call. */
function inlineValue(value: unknown, max = INLINE_CHARS): string {
  if (typeof value === "string") return oneLine(value, max);
  if (isScalar(value)) return String(value);
  if (value == null) return "none";
  if (Array.isArray(value) && value.every(isScalar)) {
    return oneLine(value.map(String).join(", "), max);
  }
  try {
    return oneLine(JSON.stringify(value) ?? "", max);
  } catch {
    return "…";
  }
}

// ── transcripts (AI SDK / chat message arrays) ──

type ChatMessageLike = { role: string; content?: unknown; parts?: unknown };

/** Items with a `role` and `content` (model messages) or `parts` (UI messages). */
function isMessageList(value: unknown): value is ChatMessageLike[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        isRecord(item) && typeof item.role === "string" && ("content" in item || "parts" in item),
    )
  );
}

const ROLE_LABELS: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
  tool: "Tool",
};

/**
 * One message part as a line of the transcript. Text reads as text; a tool
 * call reads as the call it made; ids, provider options and reasoning are the
 * SDK's bookkeeping and drop out.
 */
function messagePartLine(part: unknown): string | null {
  if (typeof part === "string") return part.trim() || null;
  if (!isRecord(part)) return null;
  const type = typeof part.type === "string" ? part.type : "";
  if (type === "text" && typeof part.text === "string") return part.text.trim() || null;
  if (type === "image" || type === "file") return `(${type})`;
  const named = typeof part.toolName === "string" ? part.toolName : "tool";
  if (type === "tool-result") {
    const output = part.output ?? part.result;
    // AI SDK tool outputs are wrapped as `{ type: "json" | "text", value }`.
    const value = isRecord(output) && "value" in output ? output.value : output;
    return `← ${named}: ${inlineValue(value)}`;
  }
  // A model message's `tool-call`, or a UI message's `tool-<name>` part.
  const toolName =
    type === "tool-call" || type === "dynamic-tool"
      ? named
      : type.startsWith("tool-")
        ? type.slice("tool-".length)
        : null;
  return toolName ? `→ ${toolName}(${inlineValue(part.input ?? part.args ?? {})})` : null;
}

/** A message array as a readable transcript: `**User:** …` / `**Assistant:** …`. */
function renderTranscript(messages: ChatMessageLike[]): string | null {
  const shown = messages.slice(-TRANSCRIPT_MESSAGES);
  const lines = shown.flatMap((message) => {
    const source = message.content ?? message.parts;
    const parts = Array.isArray(source) ? source : [source];
    const body = parts
      .map(messagePartLine)
      .filter((line): line is string => line !== null)
      .join("\n");
    if (!body) return [];
    const role = ROLE_LABELS[message.role] ?? humanizeFieldName(message.role);
    return [`**${role}:** ${prose(truncate(body, BLOCK_CHARS))}`];
  });
  if (!lines.length) return null;
  const earlier = messages.length - shown.length;
  return [earlier > 0 ? `_… ${earlier} earlier messages_` : null, ...lines]
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

// ── lists, tables, fields ──

function moreNote(total: number): string | null {
  return total > LIST_ITEMS ? `- … ${total - LIST_ITEMS} more` : null;
}

function escapeCell(value: Scalar): string {
  return oneLine(String(value), TABLE_CELL_CHARS).replace(/\|/g, "\\|");
}

/** Items that share the same few short scalar fields read as a table. */
function renderTable(items: Record<string, unknown>[]): string | null {
  if (items.length < 2) return null;
  const keys = Object.keys(items[0]);
  if (!keys.length || keys.length > TABLE_KEYS) return null;
  const sameShape = items.every((item) => {
    const own = Object.keys(item);
    return (
      own.length === keys.length &&
      keys.every(
        (key) =>
          key in item &&
          (item[key] == null ||
            (isScalar(item[key]) &&
              !String(item[key]).includes("\n") &&
              String(item[key]).length <= TABLE_CELL_CHARS)),
      )
    );
  });
  if (!sameShape) return null;
  const shown = items.slice(0, LIST_ITEMS);
  const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    row(keys.map(humanizeFieldName)),
    row(keys.map(() => "---")),
    ...shown.map((item) =>
      row(keys.map((key) => (item[key] == null ? "" : escapeCell(item[key] as Scalar)))),
    ),
    items.length > LIST_ITEMS ? `\n_… ${items.length - LIST_ITEMS} more_` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * One bullet per item: its short fields inline (`key: value · key: value`),
 * longer ones as continuation lines under it.
 */
function renderItemBullets(items: Record<string, unknown>[]): string {
  const bullets = items.slice(0, LIST_ITEMS).map((item) => {
    const entries = Object.entries(item).filter(([, value]) => value != null && value !== "");
    const short = entries
      .filter(([, value]) => isInline(value))
      .map(([key, value]) => `${humanizeFieldName(key)}: ${String(value)}`);
    const long = entries
      .filter(([, value]) => !isInline(value))
      .map(([key, value]) => `${humanizeFieldName(key)}: ${inlineValue(value, BLOCK_CHARS)}`);
    const [first, ...rest] = short.length ? [short.join(" · "), ...long] : long;
    return [`- ${first ?? "(empty)"}`, ...rest.map((line) => `  ${line}`)].join("  \n");
  });
  return [...bullets, moreNote(items.length)]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * An object's fields: short values as `**Key**: value` lines, long text as a
 * titled paragraph, nested values rendered one level further (deeper than
 * that falls back to fenced JSON). Nulls and empty strings say nothing.
 */
function renderFields(source: Record<string, unknown>, depth: number): string | null {
  const blocks: string[] = [];
  let lines: string[] = [];
  const flushLines = () => {
    if (lines.length) blocks.push(lines.join("  \n"));
    lines = [];
  };
  for (const [key, value] of Object.entries(source)) {
    if (value == null || value === "") continue;
    const label = humanizeFieldName(key);
    const scalarList = Array.isArray(value) && value.length > 0 && value.every(isScalar);
    if (isInline(value) && !(typeof value === "string" && parsedJsonString(value))) {
      lines.push(`**${label}**: ${String(value)}`);
    } else if (scalarList && inlineValue(value, Infinity).length <= INLINE_CHARS) {
      lines.push(`**${label}**: ${inlineValue(value, Infinity)}`);
    } else {
      const block = renderBlock(value, depth + 1);
      if (!block) continue;
      flushLines();
      blocks.push(`**${label}**\n\n${block}`);
    }
  }
  flushLines();
  return blocks.length ? blocks.join("\n\n") : null;
}

/** How deep {@link renderBlock} reads structure before showing JSON instead. */
const RENDER_DEPTH = 2;

/**
 * Any value as readable markdown: prose for strings, bullets for lists, a
 * table or one bullet per item for lists of records, a transcript for
 * message arrays, labeled fields for objects. Values nested deeper than
 * {@link RENDER_DEPTH} fall back to fenced JSON. Null when there is nothing
 * to show.
 */
function renderBlock(value: unknown, depth = 0): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const parsed = parsedJsonString(value);
    if (parsed) return renderBlock(parsed, depth);
    return value.trim() ? prose(value) : null;
  }
  if (isScalar(value)) return String(value);
  if (typeof value !== "object") return null;
  if (depth > RENDER_DEPTH) return jsonFence(value);
  if (isMessageList(value)) return renderTranscript(value) ?? null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    if (value.every(isScalar)) {
      // Numbers and flags read as one line ("1, 4, 7"); text as bullets.
      if (value.every((item) => typeof item !== "string")) return value.map(String).join(", ");
      return [
        ...value.slice(0, LIST_ITEMS).map((item) => `- ${oneLine(String(item), BLOCK_CHARS)}`),
        moreNote(value.length),
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
    }
    const flatItems =
      value.every(isRecord) &&
      value.every((item) =>
        Object.values(item as Record<string, unknown>).every(
          (field) =>
            field == null || isScalar(field) || (Array.isArray(field) && field.every(isScalar)),
        ),
      );
    if (flatItems) {
      const items = value as Record<string, unknown>[];
      return renderTable(items) ?? renderItemBullets(items);
    }
    return jsonFence(value);
  }
  return renderFields(value as Record<string, unknown>, depth) ?? null;
}

/**
 * Output → chat text. Strings read as prose. Object outputs read as prose
 * too: the longest prose string field becomes the body, remaining short
 * primitives a compact "Key: value" list under it, and everything else
 * (long text, lists, records, message transcripts) its own titled section —
 * see {@link renderBlock}. The untouched value still ships as
 * `MachineChatResult.output` for anything that wants the raw JSON.
 */
export function renderOutput(output: unknown): string {
  if (typeof output === "string" && !parsedJsonString(output)) return prose(output);
  if (isRecord(output)) {
    const entries = Object.entries(output);
    // Only prose leads. An identifier-like string (a reference code, a slug)
    // is one more "Key: value" line, and JSON text is structure, not a body.
    const prosy = entries.filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && /\s/.test(entry[1].trim()) && !parsedJsonString(entry[1]),
    );
    const [bodyKey, body] = prosy.length
      ? prosy.reduce((best, entry) => (entry[1].length > best[1].length ? entry : best))
      : [null, null];
    const rest = entries.filter(([key]) => key !== bodyKey);
    const short = rest.filter(
      ([, value]) => isInline(value) && !(typeof value === "string" && parsedJsonString(value)),
    );
    // Bullets: a bare newline is not a line break in markdown.
    const list = short.map(([key, value]) => `- ${humanizeFieldName(key)}: ${String(value)}`);
    // Everything else is still output — readable under its own heading,
    // never dropped.
    const sections = rest
      .filter(([key]) => !short.some(([shortKey]) => shortKey === key))
      .map(([key, value]) => {
        const block = renderBlock(value, 1);
        return block ? `**${humanizeFieldName(key)}**\n\n${block}` : null;
      });
    const text = [
      body === null ? null : prose(body),
      list.length ? list.join("\n") : null,
      ...sections,
    ]
      .filter((section): section is string => section !== null)
      .join("\n\n");
    if (text) return text;
  }
  const block = renderBlock(output);
  if (block) return block;
  try {
    return "```json\n" + JSON.stringify(output, null, 2) + "\n```";
  } catch {
    return String(output);
  }
}

/** Markdown cut to `max` at a line boundary, so a table or list stays whole up to the cut. */
function cutAtLine(markdown: string, max: number): string {
  const cut = markdown.lastIndexOf("\n", max);
  return `${markdown.slice(0, cut > 0 ? cut : max)}\n\n…`;
}

/**
 * What the run produced so far, read generically off an idle snapshot: the
 * context values the run changed (per the trace recorder), most recent first.
 * Strings render before objects so prose (drafts, answers, SQL) leads;
 * structured values read as markdown (see {@link renderBlock}), and only a
 * value too deep for that falls back to fenced JSON — small, or skipped.
 * Echoes of what the user just sent
 * (`omitValues`) are plumbing, not work — skipped. A message-history array
 * renders only its newest assistant message: the reply a chat loop keeps in
 * `messages` instead of a dedicated field.
 * Null when the run changed nothing presentable — the idle prompt alone is
 * then the whole story.
 */
export function renderIdleWork(
  context: unknown,
  changedKeys: string[],
  omitValues: string[] = [],
): string | null {
  const MAX_SECTIONS = 3;
  const MAX_STRING = 4000;
  const MAX_JSON = 1500;
  if (!context || typeof context !== "object") return null;
  const source = context as Record<string, unknown>;
  const omitted = new Set(omitValues.map((value) => value.trim()).filter(Boolean));
  const isMessageHistory = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item && typeof item === "object" && "role" in item && "content" in item);

  const strings: Array<{ key: string; body: string }> = [];
  const objects: Array<{ key: string; body: string }> = [];
  const latestReply = (history: unknown[]): string | null => {
    const last = history[history.length - 1] as { role: unknown; content: unknown };
    if (last.role !== "assistant") return null;
    const parts = Array.isArray(last.content) ? last.content : [last.content];
    const text = parts
      .map((part) =>
        typeof part === "string"
          ? part
          : part &&
              typeof part === "object" &&
              typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("")
      .trim();
    return text || null;
  };

  for (const key of changedKeys) {
    const rawValue = source[key];
    const value = isMessageHistory(rawValue) ? latestReply(rawValue as unknown[]) : rawValue;
    if (typeof value === "string" && !parsedJsonString(value)) {
      const text = value.trim();
      if (!text || omitted.has(text)) continue;
      strings.push({
        key,
        body: prose(text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text),
      });
    } else if (value && (typeof value === "object" || typeof value === "string")) {
      // Objects, lists, and JSON text (a model's structured output as a string).
      const body = renderBlock(value);
      if (!body) continue;
      // Structure too deep to read renders as JSON — worth showing only small.
      if (body.startsWith("```json") && body.length > MAX_JSON) continue;
      objects.push({ key, body: body.length > MAX_STRING ? cutAtLine(body, MAX_STRING) : body });
    }
  }

  const sections = [...strings, ...objects].slice(0, MAX_SECTIONS);
  if (!sections.length) return null;
  if (sections.length === 1 && strings.length === 1) return sections[0].body;
  return sections
    .map((section) => `**${humanizeFieldName(section.key)}**\n\n${section.body}`)
    .join("\n\n");
}
