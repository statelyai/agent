/**
 * Cloudflare Workers AI step host for the game workflow.
 *
 * Unlike `../ai-sdk-game-host/index.ts` (same explicit step loop, AI SDK
 * models), this drives the loop against a raw Workers AI `AI` binding. Workers
 * AI does not expose the same tool-calling shape as the Vercel AI SDK binding
 * path, so this host serializes allowed event tools into the prompt and accepts
 * JSON output for both text requests (structured output) and decision requests
 * (event choice) — see `resolveDecision` in `../../src/index.js` for the retry/
 * validation core this uses for the latter.
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
import {
  getAgentOutputMode,
  initialAgentStep,
  resolveAgentStep,
  resolveDecision,
  type AgentDecisionRequest,
  type AgentRequest,
  type ChosenEvent,
} from "../../src/index.js";
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

/** Text request: structured output serialized into the prompt, JSON parsed back out. */
async function runWorkersAiTextRequest(env: Env, request: AgentRequest) {
  const structured = getAgentOutputMode(request.input.outputSchema) === "structured";
  const basePrompt = structured
    ? [
        request.input.prompt ?? "",
        "",
        "Respond with JSON only, matching the requested shape.",
      ].join("\n")
    : (request.input.prompt ?? "");

  const ask = (prompt: string) =>
    runWorkersAiPrompt(env, {
      model: request.input.model,
      system: request.input.system,
      prompt,
      temperature: request.input.temperature,
      maxOutputTokens: request.input.maxOutputTokens,
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

/** Decision request: legal events serialized into the prompt, JSON-parsed
 * choice validated and retried via `resolveDecision`. */
async function runWorkersAiDecision(env: Env, request: AgentDecisionRequest): Promise<ChosenEvent> {
  return resolveDecision(
    request,
    async (attemptRequest) => {
      const legalEvents = attemptRequest.events.map((event) => `- ${event.type}`).join("\n");
      const attemptFeedback = attemptRequest.attempts
        .map((attempt) => `Your previous choice failed: ${attempt.reason}`)
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
  let step = initialAgentStep(gameMachine, input, {
    schemas: gameSchemas,
    actorSources: gameActors,
  });

  while (!step.done) {
    const [request] = step.requests;
    if (!request) {
      throw new Error("Machine is waiting without an agent request.");
    }

    if (request.kind === "decision") {
      const event = await runWorkersAiDecision(env, request);
      step = resolveAgentStep(gameMachine, step, request, event, {
        schemas: gameSchemas,
        actorSources: gameActors,
      });
    } else {
      const output = await runWorkersAiTextRequest(env, request);
      step = resolveAgentStep(gameMachine, step, request, output, {
        schemas: gameSchemas,
        actorSources: gameActors,
      });
    }
  }

  return step.snapshot.output;
}

export default {
  async fetch(_request: Request, env: Env) {
    const output = await runCloudflareGameTurn(env);
    return Response.json(output);
  },
};
