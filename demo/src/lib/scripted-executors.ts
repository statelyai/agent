/**
 * Scripted executors — a keyless, deterministic stand-in for a real model.
 *
 * This is a FEATURE, not a fallback hack: the same machines run with no API key
 * by injecting `Partial<AgentRequestExecutors>` that return canned outputs. It
 * is what the demo's tests use to prove "test your agent with no API calls," and
 * what the UI runs when `OPENAI_API_KEY` is unset.
 *
 * Executors route on `request.name` (the setupAgent request key) and, for the
 * retry scenario, on `request.model` (the resolved model ref) — the same seams a
 * real host uses. A fresh set is built per scenario so request-key namespaces
 * never collide.
 */
import type {
  AgentDecisionRequest,
  AgentRequestExecutors,
  AgentTextRequest,
} from "@statelyai/agent";
import type { ScenarioId } from "./scenarios";

type Executors = Partial<AgentRequestExecutors>;

const REFLECTION_DRAFT_A = "The tide pulls the shoreline thin, then hands it back at dawn.";
const REFLECTION_DRAFT_B =
  "At dusk the tide unstitches the shoreline; by dawn it has quietly sewn every grain back into place.";

const ROUTING_REASONS: Record<string, string> = {
  BILLING: "The request mentions a charge, invoice, or payment.",
  ACCOUNT: "The request is about sign-in or profile access.",
  TECHNICAL: "The request reports a product error or failure.",
  UNCLEAR: "The request names no billing, access, or failure signal to route on.",
};

/** Best-effort dollar-amount extraction from free text (matches the live path's intent). */
function extractAmount(text: string): number | null {
  const match =
    text.match(/\$\s*(\d+(?:\.\d{1,2})?)/) ??
    text.match(/\b(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)\b/i) ??
    text.match(/\b(?:amount|refund)\D{0,12}(\d+(?:\.\d{1,2})?)/i);
  return match ? Number(match[1]) : null;
}

function pick(request: AgentDecisionRequest, ...preferred: string[]): { type: string } {
  const legal = new Set(request.events.map((event) => event.type));
  for (const type of preferred) if (legal.has(type)) return { type };
  return { type: request.events[0]?.type ?? preferred[0] };
}

/** Maps free-text review ("looks good") to a typed approval verdict. */
export function scriptedReviewVerdict(text: string): "APPROVE" | "REJECT" | "UNCLEAR" {
  const lower = text.toLowerCase();
  if (/\b(reject|rejected|bad|no good|not good|revise|redo|no)\b/.test(lower)) return "REJECT";
  if (/\b(approve|approved|good|looks good|ship|publish|yes|great)\b/.test(lower)) return "APPROVE";
  return "UNCLEAR";
}

export function scriptedExecutorsFor(scenarioId: ScenarioId): Executors {
  switch (scenarioId) {
    case "refund":
      return {
        decide: async (request) => {
          const amount = extractAmount(request.prompt ?? "");
          if (amount === null) return { event: pick(request, "NEEDS_DETAILS", "REVIEW") };
          return { event: { ...pick(request, "AUTO_REFUND", "REVIEW"), amount } };
        },
      };

    case "routing":
      return {
        decide: async (request) => {
          const text = (request.prompt ?? "").toLowerCase();
          const type = /bill|charge|invoice|payment|refund/.test(text)
            ? "BILLING"
            : /password|login|account|profile|sign ?in/.test(text)
              ? "ACCOUNT"
              : /error|bug|broken|crash|fail|technical/.test(text)
                ? "TECHNICAL"
                : "UNCLEAR";
          // The machine requires a justification on every route event, so the
          // scripted decision supplies one too — no-key mode stays runnable.
          return { event: { ...pick(request, type), reason: ROUTING_REASONS[type] } };
        },
      };

    case "approval":
      return {
        generateText: async () => ({
          output:
            "Heads up: the database migration is running behind. No customer data is at risk. Next update at 16:00 UTC.",
        }),
      };

    case "research":
      return {
        generateText: async (request) => ({ output: researchOutput(request) }),
      };

    case "pipeline":
      return {
        generateText: async (request) => ({ output: pipelineOutput(request) }),
      };

    case "retry":
      return {
        // Deterministic failure: the primary model (attempts 0 and 1) always
        // fails; the fallback succeeds. Proves the machine's retry path.
        generateText: async (request: AgentTextRequest) => {
          if (request.model === "primary") {
            throw new Error("primary model unavailable (scripted failure)");
          }
          return { output: "Category: billing · Priority: high · Route to billing support." };
        },
      };

    case "tools":
      return {
        decide: async (request) => {
          const noObservations = /\(none\)/.test(request.prompt ?? "");
          const question = (request.prompt ?? "").toLowerCase();
          const calc = question.match(/(\d+)\s*(?:\*|x|times|multiplied by)\s*(\d+)/);
          if (noObservations && calc) {
            return {
              event: {
                ...pick(request, "CALCULATE"),
                operation: "multiply",
                a: Number(calc[1]),
                b: Number(calc[2]),
              },
            };
          }
          if (
            noObservations &&
            /speed of light|earth radius|seconds per day|moon distance/.test(question)
          ) {
            const key = ["speed of light", "earth radius", "seconds per day", "moon distance"].find(
              (k) => question.includes(k),
            )!;
            return { event: { ...pick(request, "LOOKUP"), key } };
          }
          return {
            event: {
              ...pick(request, "FINISH"),
              answer: "Based on the tool results, here is the answer.",
            },
          };
        },
        generateText: async () => ({
          output: "Best-effort answer from the observations gathered.",
        }),
      };

    case "reflection":
      return {
        generateText: async (request: AgentTextRequest) => {
          if (request.name === "writeDraft") {
            const revising = /Revise to address/.test(request.prompt ?? "");
            return { output: revising ? REFLECTION_DRAFT_B : REFLECTION_DRAFT_A };
          }
          // evaluate: first draft scores low (forces one revision), revision scores high.
          const draft = request.prompt ?? "";
          const isRevision = draft.includes(REFLECTION_DRAFT_B);
          return {
            output: isRevision
              ? { score: 9, feedback: "Vivid and complete." }
              : { score: 6, feedback: "Too plain. Add a concrete image and a sense of time." },
          };
        },
      };
  }
}

function researchOutput(request: AgentTextRequest): string {
  switch (request.name) {
    case "researchRisks":
      return "Risks: adoption friction, account-recovery complexity, and uneven platform support.";
    case "researchOpportunities":
      return "Opportunities: lower phishing risk, faster sign-in, and fewer password resets.";
    case "synthesize":
      return "On balance, proceed: the sign-in and phishing gains outweigh the risks if recovery and platform gaps are planned for.";
    default:
      return "Analysis complete.";
  }
}

function pipelineOutput(request: AgentTextRequest): string {
  switch (request.name) {
    case "planTask":
      return "Plan: identify the audience, extract the supplied claims, then write a concise update.";
    case "executeTask":
      return "Sync is faster, retries are safer, and the rollout is gradual so each stage can be validated.";
    case "verifyTask":
      return "Verification: all three supplied claims are present and supported; no unsupported claims.";
    default:
      return "Step complete.";
  }
}
