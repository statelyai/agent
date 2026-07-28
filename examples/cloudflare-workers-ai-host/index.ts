/**
 * Cloudflare Workers AI step host for the game workflow — the DURABLE thin-loop
 * flavor.
 *
 * Unlike `../ai-sdk-game-host/index.ts` (same append-only-log loop, AI SDK
 * models, one in-process run), this one persists nothing but the JOURNAL of
 * external inputs (`entries`) and resumes by REPLAYING it. Each iteration below
 * calls `replay(machine, entries)` to rebuild `{ snapshot, effects }` from the
 * log alone — exactly what a fresh Worker invocation would do after loading the
 * journal from durable storage (KV, D1, a Durable Object). No snapshot blob is
 * persisted; the log is the source of truth.
 *
 * Workers AI does not expose the same tool-calling shape as the Vercel AI SDK
 * binding path, so this host serializes allowed event tools into the prompt and
 * accepts JSON output for both text effects (structured output) and decision
 * effects (event choice) — see `resolveDecision` for the retry/validation core
 * this uses for the latter.
 *
 * Running this
 * -------------
 * The `default { fetch }` export below is a complete Worker (it runs one game
 * turn per request), but it needs the Workers runtime and an `AI` binding, so
 * it cannot run under `tsx`. Add a `wrangler.toml` next to a Worker entry that
 * imports this file, with the AI binding:
 *
 *   name = "workers-ai-game-host"
 *   main = "examples/cloudflare-workers-ai-host/index.ts"
 *   compatibility_date = "2025-01-01"
 *   [ai]
 *   binding = "AI"
 *
 * Then: `npx wrangler dev` and `curl localhost:8787`. `model` on the game
 * machine's requests must name a Workers AI model id (e.g.
 * `@cf/meta/llama-3.1-8b-instruct`). Requires the `wrangler` dev dependency.
 */
import { type EventObject } from "xstate";
import {
  type AgentDecisionRequest,
  type AgentTextRequest,
  type ChosenEvent,
} from "@statelyai/agent";
import { initEntry, renderDecisionAttempts, replay, resolveDecision } from "@statelyai/agent/steps";
import { getAgentOutputMode } from "@statelyai/agent/adapter";
import { gameActors, gameMachine, gameSchemas } from "../game-agent/index.js";

interface Env {
  AI: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
}

async function runWorkersAiPrompt(
  env: Env,
  args: {
    model: string;
    system?: string;
    prompt: string;
    temperature?: number;
    maxOutputTokens?: number;
  },
): Promise<string> {
  const response = (await env.AI.run(args.model, {
    system: args.system,
    prompt: args.prompt,
    temperature: args.temperature,
    max_tokens: args.maxOutputTokens,
  })) as { response?: string } | string | Record<string, unknown>;

  return typeof response === "string"
    ? response
    : typeof response.response === "string"
      ? response.response
      : JSON.stringify(response);
}

/** Text effect: structured output serialized into the prompt, JSON parsed back out. */
async function runWorkersAiTextRequest(env: Env, request: AgentTextRequest) {
  const structured = getAgentOutputMode(request.outputSchema) === "structured";
  const basePrompt = structured
    ? [request.prompt ?? "", "", "Respond with JSON only, matching the requested shape."].join("\n")
    : (request.prompt ?? "");

  const ask = (prompt: string) =>
    runWorkersAiPrompt(env, {
      model: request.model,
      system: request.system,
      prompt,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
    });

  const text = await ask(basePrompt);
  if (!structured) return text;

  // Mirror the decision path's recover-with-feedback: on a malformed JSON
  // response, retry once telling the model what went wrong, then surface the
  // raw text if it still fails to parse.
  try {
    return JSON.parse(text);
  } catch (firstError) {
    const retryText = await ask(
      [
        basePrompt,
        "",
        `Your previous response was not valid JSON: ${String(firstError)}`,
        "Respond with valid JSON only, no prose or code fences.",
      ].join("\n"),
    );
    try {
      return JSON.parse(retryText);
    } catch (retryError) {
      throw new Error(
        `Workers AI structured response was not valid JSON: ${String(retryError)}\nRaw text: ${retryText}`,
      );
    }
  }
}

/** Decision effect: legal events serialized into the prompt, JSON-parsed
 * choice validated and retried via `resolveDecision`. */
async function runWorkersAiDecision(env: Env, request: AgentDecisionRequest): Promise<ChosenEvent> {
  return resolveDecision(
    request,
    async (attemptRequest) => {
      const legalEvents = attemptRequest.events.map((event) => `- ${event.type}`).join("\n");
      const attemptFeedback = renderDecisionAttempts(attemptRequest)
        .map((m) => m.content)
        .join("\n");

      const prompt = [
        attemptRequest.prompt ?? "",
        attemptFeedback,
        "",
        "Choose exactly one legal event and respond as JSON.",
        "Legal events:",
        legalEvents,
        'Example: {"type":"ATTACK","target":"goblin"}',
      ]
        .filter(Boolean)
        .join("\n");

      const text = await runWorkersAiPrompt(env, {
        model: attemptRequest.model,
        system: attemptRequest.system,
        prompt,
        temperature: attemptRequest.temperature,
        maxOutputTokens: attemptRequest.maxOutputTokens,
      });

      return { event: JSON.parse(text) as ChosenEvent };
    },
    { maxRetries: 2 },
  );
}

export async function runCloudflareGameTurn(env: Env, input = { playerHp: 20, enemyHp: 15 }) {
  const options = { schemas: gameSchemas, actors: gameActors };

  // The ONLY durable state is this journal of external inputs. In a real Worker
  // it lives in KV/D1/a Durable Object; each turn below loads it, appends one
  // completion, and stores it again.
  const entries: EventObject[] = [initEntry(input).event];

  // Resume-by-replay: rebuild the frontier from the log alone every iteration,
  // exactly as a fresh Worker invocation would after loading `entries`.
  let { snapshot, effects } = replay(gameMachine, entries, options);

  while (snapshot.status === "active") {
    let next: EventObject | undefined;
    for (const effect of effects) {
      if (effect.kind === "execute") {
        effect.exec();
        continue;
      }
      if (effect.kind === "text") {
        next = effect.toDoneEvent(await runWorkersAiTextRequest(env, effect.request));
        break;
      }
      if (effect.kind === "decision") {
        next = await runWorkersAiDecision(env, effect.request);
        break;
      }
      throw new Error(`This game host does not handle '${effect.kind}' effects.`);
    }
    if (!next) {
      break; // idle: nothing async owed. Persist `entries`; resume on the next event.
    }

    // Journal the completion, then re-derive the next frontier by REPLAYING the
    // whole log — crash-safe: the same log always rebuilds the same
    // `{ snapshot, effects }`, so a Worker that crashed mid-turn resumes here
    // with no lost or duplicated work. (A hot loop could fold with
    // `transition(snapshot, next)` for speed and only `replay` on cold start —
    // both yield the identical state.)
    entries.push(next);
    ({ snapshot, effects } = replay(gameMachine, entries, options));
  }

  return snapshot.output;
}

export default {
  async fetch(_request: Request, env: Env) {
    const output = await runCloudflareGameTurn(env);
    return Response.json(output);
  },
};
