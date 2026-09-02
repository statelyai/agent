/**
 * Cloudflare Workers AI host for the game workflow.
 *
 * Workers AI does not expose the same tool-calling shape as the Vercel AI SDK
 * binding path, so this host serializes allowed event tools into the prompt and
 * accepts JSON output for both text effects (structured output) and decision
 * effects (event choice). `runAgent` owns decision validation and retries.
 *
 * Running this
 * -------------
 * The `default { fetch }` export below is a complete Worker: one game turn per
 * request, against the `AI` binding declared in `wrangler.jsonc`. It needs the
 * Workers runtime, so it cannot run under `tsx`.
 *
 *   pnpm --filter @statelyai/example-cloudflare-workers-ai-host dev
 *   curl localhost:3010
 *
 * `wrangler dev` runs the Worker locally but proxies the `AI` binding to the
 * logged-in Cloudflare account, so a local run performs real inference. Run
 * `npx wrangler login` first if the account is not connected.
 */
import {
  getAgentOutputMode,
  renderDecisionAttempts,
  runAgent,
  type AgentDecisionRequest,
  type AgentTextRequest,
  type ChosenEvent,
} from "@statelyai/agent";
import { gameMachine } from "../game-agent/index.js";

export interface Env {
  AI: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
}

/**
 * The game machine names its models symbolically (`defineModels` keys), which
 * is the point: the machine stays provider-free and the HOST decides what each
 * ref means. Here every ref maps to a Workers AI model id; an unknown ref is
 * passed through, so a machine can also name a `@cf/...` id directly.
 */
const workersAiModels: Record<string, string> = {
  moveChooser: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  turnSummarizer: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

const resolveWorkersAiModel = (modelRef: string) => workersAiModels[modelRef] ?? modelRef;

/**
 * Workers AI models have no JSON mode and no tool calling, so they answer in
 * prose ("Here you go: ```json {...}```"). Take the first JSON object in the
 * text rather than demanding the whole response be JSON — a plain
 * `JSON.parse(text)` fails on most real completions.
 */
function parseJsonFromText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate =
      fenced?.[1]?.trim() ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    if (!candidate) {
      throw new SyntaxError(`No JSON object found in response: ${text.slice(0, 200)}`);
    }
    return JSON.parse(candidate);
  }
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
  const response = (await env.AI.run(resolveWorkersAiModel(args.model), {
    system: args.system,
    prompt: args.prompt,
    temperature: args.temperature,
    max_tokens: args.maxOutputTokens,
  })) as { response?: unknown } | string;

  // Response shapes vary by model: a bare string, `{ response: "text" }`, or —
  // on newer models that pre-parse JSON output — `{ response: { ... } }` inside
  // a full completion envelope. Normalize to the text the caller asked for,
  // never the envelope around it.
  if (typeof response === "string") return response;
  const inner = response.response;
  if (typeof inner === "string") return inner;
  if (inner !== undefined && inner !== null) return JSON.stringify(inner);
  return JSON.stringify(response);
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
    return parseJsonFromText(text);
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
      return parseJsonFromText(retryText);
    } catch (retryError) {
      throw new Error(
        `Workers AI structured response was not valid JSON: ${String(retryError)}\nRaw text: ${retryText}`,
      );
    }
  }
}

/** One decision attempt. `runAgent` validates the returned event and calls this
 * again with attempt feedback when it is malformed or rejected by a guard. */
async function runWorkersAiDecision(
  env: Env,
  request: AgentDecisionRequest,
): Promise<{ event: ChosenEvent }> {
  const legalEvents = request.events.map((event) => `- ${event.type}`).join("\n");
  const attemptFeedback = renderDecisionAttempts(request)
    .map((message) => message.content)
    .join("\n");

  const prompt = [
    request.prompt ?? "",
    attemptFeedback,
    "",
    "Choose exactly one legal event.",
    "Legal events:",
    legalEvents,
    "",
    "Reply with ONLY a JSON object and no other text, no explanation, no prose.",
    'Example reply: {"type":"ATTACK","target":"goblin"}',
  ]
    .filter(Boolean)
    .join("\n");

  const text = await runWorkersAiPrompt(env, {
    model: request.model,
    system: request.system,
    prompt,
    temperature: request.temperature,
    maxOutputTokens: request.maxOutputTokens,
  });

  try {
    return { event: parseJsonFromText(text) as ChosenEvent };
  } catch (error) {
    return { event: { type: `<unparsed response: ${String(error)}>` } };
  }
}

export async function runCloudflareGameTurn(env: Env, input = { playerHp: 20, enemyHp: 15 }) {
  const result = await runAgent(gameMachine, {
    input,
    executors: {
      generateText: async (request) => ({
        output: await runWorkersAiTextRequest(env, request),
      }),
      decide: (request) => runWorkersAiDecision(env, request),
    },
  });
  if (result.status !== "done") {
    throw new Error(`Game turn ended with ${result.status}.`);
  }
  return result.output;
}

export default {
  async fetch(_request: Request, env: Env) {
    try {
      return Response.json(await runCloudflareGameTurn(env));
    } catch (error) {
      // Workers AI failures (entitlement, model id, rate limit) surface here —
      // report them as-is rather than as an opaque 500.
      return Response.json({ error: (error as Error).message }, { status: 502 });
    }
  },
};
