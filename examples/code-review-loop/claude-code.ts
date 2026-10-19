/**
 * A Claude Code host: executors that run each request through the Claude
 * Code CLI headless, `claude -p --output-format json`, one process per call.
 *
 *   - The prompt goes in on stdin; `request.system` replaces the default
 *     system prompt (`--system-prompt`).
 *   - Tools are off (`--tools ""`): the author and reviewer only read the
 *     prompt and answer with text. Sessions are not saved
 *     (`--no-session-persistence`), and `--safe-mode` keeps CLAUDE.md files,
 *     skills, hooks, and MCP servers out of the call. Pass `safeMode: false`
 *     to keep your own setup.
 *   - A structured request passes its JSON Schema as `--json-schema` and reads
 *     the envelope's `structured_output` (falling back to JSON in `result`),
 *     then validates it with the request's own schema.
 *   - `decide` answers closed choices only: one `--json-schema` enum over the
 *     offered option ids.
 *   - Each call runs in a fresh empty temp directory, so no project files are
 *     in reach even if a tool were enabled.
 *
 * `spawn` is injectable; claude-code.test.ts runs these executors over a
 * canned CLI envelope with no CLI installed.
 */
import { spawn as spawnProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getAgentOutputMode,
  type AgentCallUsage,
  type AgentDecisionExecutor,
  type AgentFinishReason,
  type AgentRequestExecutor,
  type StandardSchemaV1,
} from "@statelyai/agent";
import type { ClassifyIssueInput, IssueClassifier } from "./policy.js";

export type SpawnResult = { stdout: string; stderr: string; exitCode: number | null };
export type Spawn = (
  command: string,
  args: string[],
  options: { cwd: string; stdin: string; signal?: AbortSignal },
) => Promise<SpawnResult>;

/** One CLI call, reported through `onCall`. */
export type ClaudeCodeCall = {
  name: string;
  model?: string;
  durationMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type ClaudeCodeOptions = {
  /** The CLI binary. Default `claude`. */
  bin?: string;
  /** A Claude Code model (alias or full name) per machine model ref; unlisted refs use `defaultModel`. */
  models?: Record<string, string>;
  /** Default: the CLI's own default model. */
  defaultModel?: string;
  /** Run with `--safe-mode` (no CLAUDE.md, skills, hooks, or MCP servers). Default true. */
  safeMode?: boolean;
  /** More CLI flags, appended to every call. */
  extraArgs?: string[];
  spawn?: Spawn;
  onCall?: (call: ClaudeCodeCall) => void;
};

/** The fields of the `--output-format json` envelope these executors read. */
export type ClaudeCodeEnvelope = {
  type: "result";
  subtype: string;
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  stop_reason?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

const defaultSpawn: Spawn = (command, args, { cwd, stdin, signal }) =>
  new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd, signal, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT"
          ? new Error(`Claude Code CLI '${command}' not found. Install it, or pass { bin }.`)
          : error,
      ),
    );
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
    child.stdin.end(stdin);
  });

/** Parses the CLI's JSON envelope (the last JSON line of stdout). */
export function parseEnvelope(stdout: string, stderr = ""): ClaudeCodeEnvelope {
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.trim().startsWith("{"));
  if (!line) {
    throw new Error(`Claude Code returned no JSON envelope. stderr: ${stderr.trim() || "(empty)"}`);
  }
  const envelope = JSON.parse(line) as ClaudeCodeEnvelope;
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new Error(
      `Claude Code call failed (${envelope.subtype}): ${envelope.result ?? stderr.trim() ?? ""}`,
    );
  }
  return envelope;
}

/** A JSON value from model text: the whole text, or its one fenced block. */
function parseJsonText(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return JSON.parse((fenced ? fenced[1]! : text).trim());
}

function jsonSchemaOf(schema: StandardSchemaV1): Record<string, unknown> {
  const json = (
    schema["~standard"] as { jsonSchema?: { input?: (options?: unknown) => unknown } }
  ).jsonSchema?.input?.();
  if (!json || typeof json !== "object" || json instanceof Promise) {
    throw new Error("Claude Code host: the output schema exposes no synchronous JSON Schema.");
  }
  const { $schema: _dialect, ...rest } = json as Record<string, unknown>;
  return rest;
}

function validate(schema: StandardSchemaV1, value: unknown, name: string): unknown {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) throw new Error("async schemas are not supported");
  if (result.issues) {
    throw new Error(
      `Claude Code answer for '${name}' does not match its schema: ` +
        result.issues.map((issue: { message: string }) => issue.message).join("; "),
    );
  }
  return result.value;
}

const finishReasonOf = (envelope: ClaudeCodeEnvelope): AgentFinishReason =>
  envelope.stop_reason === "max_tokens" ? "length" : "stop";

const usageOf = (envelope: ClaudeCodeEnvelope): AgentCallUsage => {
  const usage = envelope.usage ?? {};
  return {
    inputTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
  };
};

export type ClaudeCodeExecutors = {
  generateText: AgentRequestExecutor;
  /** Closed choices only (`request.options`). */
  decide: AgentDecisionExecutor;
  /** `classifyIssue` for policies, as one structured call. */
  classify: IssueClassifier;
};

export function createClaudeCodeExecutors(options: ClaudeCodeOptions = {}): ClaudeCodeExecutors {
  const bin = options.bin ?? "claude";
  const spawn = options.spawn ?? defaultSpawn;

  async function call(input: {
    name: string;
    modelRef?: string;
    system?: string;
    prompt: string;
    schema?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ClaudeCodeEnvelope> {
    const model = (input.modelRef && options.models?.[input.modelRef]) ?? options.defaultModel;
    const args = [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--no-session-persistence",
      ...(options.safeMode === false ? [] : ["--safe-mode"]),
      ...(model ? ["--model", model] : []),
      ...(input.system ? ["--system-prompt", input.system] : []),
      ...(input.schema ? ["--json-schema", JSON.stringify(input.schema)] : []),
      ...(options.extraArgs ?? []),
    ];
    const cwd = await mkdtemp(path.join(tmpdir(), "claude-code-host-"));
    const started = Date.now();
    try {
      const { stdout, stderr, exitCode } = await spawn(bin, args, {
        cwd,
        stdin: input.prompt,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!stdout.trim() && exitCode !== 0) {
        throw new Error(
          `Claude Code exited ${String(exitCode)}: ${stderr.trim() || "(no output)"}`,
        );
      }
      const envelope = parseEnvelope(stdout, stderr);
      const usage = usageOf(envelope);
      options.onCall?.({
        name: input.name,
        ...(model ? { model } : {}),
        durationMs: envelope.duration_ms ?? Date.now() - started,
        ...(envelope.total_cost_usd !== undefined ? { costUsd: envelope.total_cost_usd } : {}),
        ...usage,
      });
      return envelope;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  async function structured(
    input: Parameters<typeof call>[0] & { schema: Record<string, unknown> },
  ): Promise<{ value: unknown; envelope: ClaudeCodeEnvelope }> {
    const envelope = await call(input);
    const value = envelope.structured_output ?? parseJsonText(envelope.result ?? "");
    return { value, envelope };
  }

  const generateText: AgentRequestExecutor = async (request, info) => {
    const prompt =
      request.prompt ??
      (request.messages ?? [])
        .map((m: { content?: unknown }) => (typeof m.content === "string" ? m.content : ""))
        .join("\n\n");
    const base = {
      name: request.name,
      modelRef: request.model,
      ...(request.system ? { system: request.system } : {}),
      prompt,
      ...(info?.signal ? { signal: info.signal } : {}),
    };
    if (request.outputSchema && getAgentOutputMode(request.outputSchema) === "structured") {
      const { value, envelope } = await structured({
        ...base,
        schema: jsonSchemaOf(request.outputSchema),
      });
      return {
        result: validate(request.outputSchema, value, request.name),
        usage: usageOf(envelope),
        finishReason: finishReasonOf(envelope),
        raw: envelope,
      };
    }
    const envelope = await call(base);
    return {
      result: envelope.result ?? "",
      usage: usageOf(envelope),
      finishReason: finishReasonOf(envelope),
      raw: envelope,
    };
  };

  const decide: AgentDecisionExecutor = async (request, info) => {
    const offered = request.options;
    if (!offered?.length) {
      throw new Error(
        `Claude Code decide '${request.name}': closed choices only (pass payloads on the decision).`,
      );
    }
    const ids = offered.map((_, index) => `option-${index + 1}`);
    const lines = offered.map(
      (option, index) =>
        `${ids[index]}: ${JSON.stringify(option.event)}${option.description ? ` (${option.description})` : ""}`,
    );
    const retries = request.attempts.map((attempt) => `- ${attempt.reason}`);
    const prompt = [
      request.prompt ?? "",
      "Choose exactly one option by its id:",
      ...lines,
      ...(retries.length ? ["Your previous choices were refused:", ...retries] : []),
    ].join("\n");
    const { value, envelope } = await structured({
      name: request.name ?? "decide",
      modelRef: request.model,
      ...(request.system ? { system: request.system } : {}),
      prompt,
      schema: {
        type: "object",
        properties: { option: { type: "string", enum: ids } },
        required: ["option"],
      },
      ...(info?.signal ? { signal: info.signal } : {}),
    });
    const index = ids.indexOf(String((value as { option?: unknown }).option));
    // An unknown id becomes an unoffered event, which the runtime retries.
    const event = offered[index]?.event ?? { type: `unknown option ${JSON.stringify(value)}` };
    return { event, usage: usageOf(envelope) };
  };

  const classify: IssueClassifier = async (input: ClassifyIssueInput, signal) => {
    const { value } = await structured({
      name: "classifyIssue",
      modelRef: "classifier",
      system:
        "You triage code review findings. Answer whether the task itself is broken (the spec " +
        "contradicts itself or the tests, or a person has to decide), as opposed to a bug a " +
        "better patch could fix.",
      prompt: JSON.stringify(input, null, 2),
      schema: {
        type: "object",
        properties: { novel: { type: "boolean" }, confidence: { type: "number" } },
        required: ["novel", "confidence"],
      },
      ...(signal ? { signal } : {}),
    });
    const answer = value as { novel?: unknown; confidence?: unknown };
    return { novel: answer.novel === true, confidence: Number(answer.confidence ?? 0.5) };
  };

  return { generateText, decide, classify };
}
