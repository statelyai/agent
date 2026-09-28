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
  if (typeof value !== "string") return false;
  const text = value.trim();
  return !text.includes("\n") && text.length <= INLINE_CHARS;
}

/** A scalar as it reads after a label or in a cell: flags as yes/no, text trimmed. */
function scalarText(value: Scalar): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return typeof value === "string" ? value.trim() : String(value);
}

/**
 * Multi-line text as the lines of a list item, so an email body in a list
 * keeps its lines. Blank lines ("") mark paragraph breaks; see {@link bullet}.
 */
function textLines(text: string): string[] {
  return truncate(text.replace(/\r\n?/g, "\n").trim(), BLOCK_CHARS)
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim());
}

/**
 * A markdown bullet from its lines: the first after "- ", the rest indented
 * under it as hard-broken continuation lines ("" is a paragraph break that
 * stays inside the item).
 */
function bullet(lines: string[]): string {
  let text = `- ${lines[0] ?? "(empty)"}`;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === "") text += "\n";
    else text += `${lines[index - 1] === "" ? "\n" : "  \n"}  ${line}`;
  }
  return text;
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
  if (isScalar(value)) return scalarText(value);
  if (value == null) return "none";
  if (Array.isArray(value) && value.every(isScalar)) {
    return oneLine(value.map(scalarText).join(", "), max);
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

/** "User: …" / "Assistant: …" lines: a transcript kept as plain strings. */
function isRoleLines(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && /^(user|assistant|system|tool):/i.test(item))
  );
}

/** A conversation log: a chat message array or role-prefixed lines. */
function isChatLog(value: unknown): value is ChatMessageLike[] | string[] {
  return isMessageList(value) || isRoleLines(value);
}

/** The text of each assistant turn in a conversation log, oldest first. */
function assistantTexts(log: ChatMessageLike[] | string[]): string[] {
  return log.flatMap((message): string[] => {
    if (typeof message === "string") {
      const match = /^assistant:\s*([\s\S]*)$/i.exec(message);
      return match?.[1].trim() ? [match[1].trim()] : [];
    }
    if (message.role !== "assistant") return [];
    const source = message.content ?? message.parts;
    const text = (Array.isArray(source) ? source : [source])
      .map((part) =>
        typeof part === "string" ? part : isRecord(part) && part.type === "text" ? part.text : "",
      )
      .filter((part): part is string => typeof part === "string")
      .join("")
      .trim();
    return text ? [text] : [];
  });
}

/** The log's newest turn when the assistant spoke it; null when the user did. */
function latestReply(log: ChatMessageLike[] | string[]): string | null {
  const last = log[log.length - 1];
  const role = typeof last === "string" ? /^(\w+):/.exec(last)?.[1].toLowerCase() : last.role;
  return role === "assistant" ? (assistantTexts([last] as typeof log)[0] ?? null) : null;
}

/** Text a reader would read, not a code or a slug: it has words. */
function isProse(text: string): boolean {
  return /\s/.test(text.trim()) && !parsedJsonString(text);
}

/** Every string a value holds (JSON text parsed, chat logs excluded), trimmed. */
function textLeaves(value: unknown, depth = 0): string[] {
  if (typeof value === "string") {
    const parsed = parsedJsonString(value);
    if (parsed) return textLeaves(parsed, depth);
    return value.trim() ? [value.trim()] : [];
  }
  if (depth > RENDER_DEPTH || isChatLog(value)) return [];
  if (Array.isArray(value)) return value.flatMap((item) => textLeaves(item, depth + 1));
  if (isRecord(value)) return Object.values(value).flatMap((item) => textLeaves(item, depth + 1));
  return [];
}

/**
 * A card's fields without saying anything twice. A string identical to an
 * earlier one is dropped. A conversation log shows only when it is the
 * card's only readable text: next to a prose field (a reply, a draft) it
 * would repeat that text as a transcript, and so it would when every
 * assistant turn in it already appears in another field.
 */
function withoutRepeats(entries: Array<[string, unknown]>): Array<[string, unknown]> {
  const seen = new Set<string>();
  const plain = entries.filter(([, value]) => {
    if (isChatLog(value)) return false;
    if (typeof value !== "string" || !value.trim()) return true;
    if (seen.has(value.trim())) return false;
    seen.add(value.trim());
    return true;
  });
  const texts = plain.flatMap(([, value]) => textLeaves(value));
  const readable = texts.some(isProse);
  return entries.filter(([key, value]) => {
    if (!isChatLog(value)) return plain.some(([plainKey]) => plainKey === key);
    if (readable) return false;
    const replies = assistantTexts(value);
    return !(
      replies.length && replies.every((reply) => texts.some((text) => text.includes(reply)))
    );
  });
}

// ── lists, tables, fields ──

function moreNote(total: number): string | null {
  return total > LIST_ITEMS ? `- … ${total - LIST_ITEMS} more` : null;
}

function escapeCell(value: Scalar): string {
  return oneLine(scalarText(value), TABLE_CELL_CHARS).replace(/\|/g, "\\|");
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
              !scalarText(item[key] as Scalar).includes("\n") &&
              scalarText(item[key] as Scalar).length <= TABLE_CELL_CHARS)),
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
 * One bullet per item, every item laid out alike: fields short in every item
 * sit inline on the first line (`key: value · key: value`); a field long or
 * multi-line in ANY item goes on its own continuation line in every item,
 * its text keeping its line breaks.
 */
function renderItemBullets(items: Record<string, unknown>[]): string {
  const shown = items.slice(0, LIST_ITEMS);
  const present = ([, value]: [string, unknown]) => value != null && value !== "";
  const blockKeys = new Set(
    shown.flatMap((item) =>
      Object.entries(item)
        .filter((entry) => present(entry) && !isInline(entry[1]))
        .map(([key]) => key),
    ),
  );
  const bullets = shown.map((item) => {
    const entries = Object.entries(item).filter(present);
    const short = entries
      .filter(([key]) => !blockKeys.has(key))
      .map(([key, value]) => `${humanizeFieldName(key)}: ${inlineValue(value)}`);
    const long = entries
      .filter(([key]) => blockKeys.has(key))
      .flatMap(([key, value]) => {
        const label = humanizeFieldName(key);
        return typeof value === "string" && value.trim().includes("\n")
          ? [`${label}:`, ...textLines(value)]
          : [`${label}: ${inlineValue(value, BLOCK_CHARS)}`];
      });
    return bullet(short.length ? [short.join(" · "), ...long] : long);
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
  for (const [key, value] of withoutRepeats(Object.entries(source))) {
    if (value == null || value === "") continue;
    const label = humanizeFieldName(key);
    const scalarList = Array.isArray(value) && value.length > 0 && value.every(isScalar);
    if (isInline(value) && !(typeof value === "string" && parsedJsonString(value))) {
      lines.push(`**${label}**: ${scalarText(value)}`);
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
  if (isScalar(value)) return scalarText(value);
  if (typeof value !== "object") return null;
  if (depth > RENDER_DEPTH) return jsonFence(value);
  if (isMessageList(value)) return renderTranscript(value) ?? null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    if (value.every(isScalar)) {
      // Numbers and flags read as one line ("1, 4, 7"); text as bullets.
      if (value.every((item) => typeof item !== "string")) return value.map(scalarText).join(", ");
      return [
        ...value.slice(0, LIST_ITEMS).map((item) => bullet(textLines(scalarText(item)))),
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
 * see {@link renderBlock}. Nothing is said twice (see {@link withoutRepeats}),
 * and a prose field equal to one of `shownValues` — what the user sent, or
 * what an earlier turn already showed — is left out unless nothing else
 * would remain. The untouched value still ships as
 * `MachineChatResult.output` for anything that wants the raw JSON.
 */
export function renderOutput(output: unknown, shownValues: string[] = []): string {
  if (typeof output === "string" && !parsedJsonString(output)) return prose(output);
  if (isRecord(output)) {
    const shown = new Set(shownValues.map((value) => value.trim()).filter(Boolean));
    const all = withoutRepeats(Object.entries(output));
    const fresh = all.filter(
      ([, value]) => !(typeof value === "string" && isProse(value) && shown.has(value.trim())),
    );
    const entries = fresh.some(([, value]) => value != null && value !== "") ? fresh : all;
    // Only prose leads. An identifier-like string (a reference code, a slug)
    // is one more "Key: value" line, and JSON text is structure, not a body.
    const prosy = entries.filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && isProse(entry[1]),
    );
    const [bodyKey, body] = prosy.length
      ? prosy.reduce((best, entry) => (entry[1].length > best[1].length ? entry : best))
      : [null, null];
    const rest = entries.filter(([key]) => key !== bodyKey);
    const short = rest.filter(
      (entry): entry is [string, Scalar] =>
        isInline(entry[1]) && !(typeof entry[1] === "string" && parsedJsonString(entry[1])),
    );
    // Bullets: a bare newline is not a line break in markdown.
    const list = short.map(([key, value]) => `- ${humanizeFieldName(key)}: ${scalarText(value)}`);
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
 * Nothing already in front of the user renders again: echoes of what they
 * just sent (`omitValues`), text the waiting box's `prompt` already says, and
 * a string identical to one shown above it. A conversation log (message
 * array or "User: …" lines) renders only its newest assistant reply — the
 * reply a chat loop keeps in `messages` instead of a dedicated field — and
 * only when no other readable text is shown, since that text is the reply.
 * Null when the run changed nothing presentable — the idle prompt alone is
 * then the whole story.
 */
export function renderIdleWork(
  context: unknown,
  changedKeys: string[],
  omitValues: string[] = [],
  prompt?: string | null,
): string | null {
  const MAX_SECTIONS = 3;
  const MAX_STRING = 4000;
  const MAX_JSON = 1500;
  if (!isRecord(context)) return null;
  const omitted = new Set(omitValues.map((value) => value.trim()).filter(Boolean));
  const promptText = prompt?.trim() ?? "";
  const alreadyShown = (text: string) =>
    omitted.has(text) ||
    text === promptText ||
    (isProse(text) && promptText.includes(text)) ||
    shownTexts.includes(text);

  const strings: Array<{ key: string; body: string }> = [];
  const objects: Array<{ key: string; body: string }> = [];
  const shownTexts: string[] = [];
  const replies: Array<{ key: string; text: string }> = [];
  const pushString = (key: string, text: string) => {
    strings.push({
      key,
      body: prose(text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text),
    });
    shownTexts.push(text);
  };

  for (const key of changedKeys) {
    const value = context[key];
    if (isChatLog(value)) {
      const reply = latestReply(value);
      if (reply) replies.push({ key, text: reply });
    } else if (typeof value === "string" && !parsedJsonString(value)) {
      const text = value.trim();
      if (text && !alreadyShown(text)) pushString(key, text);
    } else if (value && (typeof value === "object" || typeof value === "string")) {
      // Objects, lists, and JSON text (a model's structured output as a string).
      const body = renderBlock(value);
      if (!body) continue;
      // Structure too deep to read renders as JSON — worth showing only small.
      if (body.startsWith("```json") && body.length > MAX_JSON) continue;
      objects.push({ key, body: body.length > MAX_STRING ? cutAtLine(body, MAX_STRING) : body });
      shownTexts.push(...textLeaves(value));
    }
  }
  // A log's reply only when it is the only readable text, and not a repeat.
  for (const { key, text } of replies) {
    if (shownTexts.some(isProse) || shownTexts.some((shown) => shown.includes(text))) continue;
    if (!alreadyShown(text)) pushString(key, text);
  }

  const sections = [...strings, ...objects].slice(0, MAX_SECTIONS);
  if (!sections.length) return null;
  if (sections.length === 1 && strings.length === 1) return sections[0].body;
  return sections
    .map((section) => `**${humanizeFieldName(section.key)}**\n\n${section.body}`)
    .join("\n\n");
}
