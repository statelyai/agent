/**
 * Scripted executors — a deterministic stand-in for a real model.
 *
 * This is a FEATURE, not a fallback hack: the same machines run with no API key
 * by injecting `Partial<AgentRequestExecutors>` that return canned outputs. It
 * is what the demo's tests use to prove "test your agent with no API calls," and
 * what the UI runs when `OPENAI_API_KEY` is unset.
 *
 * Executors route on `request.name` (the setupAgent request key) and, for the
 * retry scenario, on `request.model` (the resolved model ref) — the same seams a
 * real host uses. Every script reads the prompt it is given, so a different
 * topic yields a different (if formulaic) answer: the point of no-key mode is
 * that the MACHINE's behavior is real, and the canned text should not
 * contradict what the person typed. A fresh set is built per scenario so
 * request-key namespaces never collide.
 */
import type {
  AgentDecisionRequest,
  AgentRequestExecutors,
  AgentTextRequest,
} from "@statelyai/agent";
import { KNOWLEDGE_BASE } from "@/agents/tools";
import type { ScenarioId } from "./scenarios";

type Executors = Partial<AgentRequestExecutors>;

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
    text.match(/\b(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?|bucks)\b/i) ??
    text.match(/\b(?:amount|refund)\D{0,12}(\d+(?:\.\d{1,2})?)/i);
  return match ? Number(match[1]) : null;
}

function pick(request: AgentDecisionRequest, ...preferred: string[]): { type: string } {
  const legal = new Set(request.events.map((event) => event.type));
  for (const type of preferred) if (legal.has(type)) return { type };
  return { type: request.events[0]?.type ?? preferred[0] };
}

/** Lower-cases the first letter and drops a trailing period. */
function sentenceCase(text: string, capital: boolean): string {
  const trimmed = text.trim().replace(/[.!]+$/, "");
  if (!trimmed) return trimmed;
  const first = capital ? trimmed[0].toUpperCase() : trimmed[0].toLowerCase();
  return first + trimmed.slice(1);
}

/**
 * Maps free-text review ("looks good", "too vague, name the window") to a typed
 * approval verdict. Any concrete ask is a rejection: a reviewer who wants
 * something changed has not approved, even if they were polite about it.
 */
export function scriptedReviewVerdict(text: string): "APPROVE" | "REJECT" | "UNCLEAR" {
  const lower = text.toLowerCase();
  const approves =
    /\b(approve|approved|lgtm|looks good|good to go|ship it|publish|send it|perfect|great|yes|fine by me|no notes|not bad)\b/.test(
      lower,
    );
  const asks =
    /\b(reject|rejected|revise|redo|rewrite|vague|unclear|wrong|missing|shorter|longer|too (?:short|long|vague|generic|formal|casual)|needs?|should|instead|mention|include|add|remove|drop|change|fix|please|don't|do not|not good|no good)\b/.test(
      lower,
    );
  const hedged = /\b(but|however|except|though|although)\b/.test(lower);
  if (approves && !asks && !hedged) return "APPROVE";
  if (asks || (approves && hedged)) return "REJECT";
  if (/\b(no|nope|nah)\b/.test(lower)) return "REJECT";
  return "UNCLEAR";
}

// Starts at a local-part character and stops before trailing punctuation, so
// "<priya@example.com>," yields an address `hasRecipient` accepts.
const EMAIL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

/**
 * Email drafter stand-ins, routed on request name. The evaluator flags a
 * recipient as missing when no address appears and a subject as missing when
 * the word "subject" does not; the drafter copies the request into the body,
 * so every fact the user typed is "mentioned".
 */
function emailDrafterOutput(request: AgentTextRequest): unknown {
  const text = request.prompt ?? "";
  if (request.name === "evaluatePrompt") {
    const missing = [
      ...(EMAIL.test(text) ? [] : ["recipient"]),
      ...(/subject/i.test(text) ? [] : ["subject"]),
    ];
    return {
      satisfied: missing.length === 0,
      missing,
      questions: missing.map((field) => `What is the ${field}?`),
    };
  }
  const to = text.match(EMAIL)?.[0] ?? "";
  const openQuestions = [
    ...(to ? [] : ["Who should this go to?"]),
    ...(/subject/i.test(text) ? [] : ["What subject line do you want?"]),
  ];
  // v1's drafter ignores `openQuestions`; v2's collects them.
  return { to, subject: "Re: your request", body: text, openQuestions };
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
          const type = /bill|charge|invoice|payment|refund|receipt|subscription|card/.test(text)
            ? "BILLING"
            : /password|log ?in|sign ?in|account|profile|2fa|locked out|verify/.test(text)
              ? "ACCOUNT"
              : /error|bug|broken|crash|fail|technical|time ?out|slow|freez|won'?t (?:open|load)/.test(
                    text,
                  )
                ? "TECHNICAL"
                : "UNCLEAR";
          // The machine requires a justification on every route event, so the
          // scripted decision supplies one too — no-key mode stays runnable.
          return { event: { ...pick(request, type), reason: ROUTING_REASONS[type] } };
        },
      };

    case "email-drafter-v1":
    case "email-drafter-v2":
      return { generateText: async (request) => ({ output: emailDrafterOutput(request) }) };

    case "approval":
      return {
        generateText: async (request) => ({ output: approvalDraft(request.prompt ?? "") }),
      };

    case "research":
      return {
        generateText: async (request) => ({ output: researchOutput(request) }),
      };

    case "pipeline":
      return {
        generateText: async (request) => ({ output: pipelineOutput(request) }),
      };

    case "retry": {
      // Outage markers in the ticket pick the failure shape, so all three
      // starters show something different. Attempts are counted per ticket:
      //   (none)                  — the primary answers on the first try.
      //   [primary-outage]        — the first primary attempt fails; the retry
      //                             succeeds on the primary.
      //   [primary-outage-hard]   — every primary attempt fails; the fallback
      //                             model answers on attempt 3.
      const attempts = new Map<string, number>();
      return {
        generateText: async (request: AgentTextRequest) => {
          const ticket = request.prompt ?? "";
          const attempt = attempts.get(ticket) ?? 0;
          attempts.set(ticket, attempt + 1);
          const hard = /\[primary-outage-hard\]/.test(ticket);
          const soft = !hard && /\[primary-outage\]/.test(ticket);
          if (request.model === "primary" && (hard || (soft && attempt === 0))) {
            throw new Error("primary model unavailable (scripted failure)");
          }
          return { output: classifyTicket(ticket) };
        },
      };
    }

    case "tools":
      return {
        decide: async (request) => {
          const prompt = request.prompt ?? "";
          const question = prompt.match(/^Question:\s*([\s\S]*?)\n\nObservations:/)?.[1] ?? prompt;
          const observations = parseObservations(prompt);
          const next = nextToolCall(question, observations);
          if (next?.kind === "calc") {
            return {
              event: {
                ...pick(request, "CALCULATE"),
                operation: next.operation,
                a: next.a,
                b: next.b,
              },
            };
          }
          if (next?.kind === "lookup") {
            return { event: { ...pick(request, "LOOKUP"), key: next.key } };
          }
          return {
            event: { ...pick(request, "FINISH"), answer: composeAnswer(question, observations) },
          };
        },
        // Only reached at the step cap: answer from whatever was gathered.
        generateText: async (request) => {
          const prompt = request.prompt ?? "";
          const question = prompt.match(/^Question:\s*([\s\S]*?)\n\nObservations:/)?.[1] ?? prompt;
          return { output: composeAnswer(question, parseObservations(prompt)) };
        },
      };

    case "reflection":
      return {
        generateText: async (request: AgentTextRequest) => {
          const prompt = request.prompt ?? "";
          if (request.name === "writeDraft") {
            const topic = prompt.match(/^Topic:\s*(.*)/m)?.[1] ?? prompt;
            const revising = /Revise to address/.test(prompt);
            return { output: revising ? revisedDraft(topic) : flatDraft(topic) };
          }
          // evaluate: the flat first pass scores low (forcing one revision);
          // the revision, recognizable by its shape, clears the bar.
          const draft = prompt.replace(/^Score this draft:\s*/, "");
          return {
            output: isRevisedDraft(draft)
              ? {
                  score: 9,
                  feedback:
                    "Concrete sensory detail, a controlling idea the paragraph builds to, and varied rhythm. Nothing left to name.",
                }
              : {
                  score: 5,
                  feedback:
                    "Too plain: two generic sentences with no concrete image. Name one specific sound or texture, and give the paragraph a sense of time passing.",
                },
          };
        },
      };
  }
}

// ─── approval ───

/**
 * A two-sentence announcement built from the topic. Revision requests arrive
 * appended to the topic (`Revision requested: …`), so a rejected draft comes
 * back with the reviewer's own words worked in.
 */
function approvalDraft(prompt: string): string {
  const body = prompt.replace(/^Write a short announcement about:\s*/i, "");
  const [rawTopic, ...rest] = body.split("\n");
  const revisions = rest
    .map((line) => line.match(/^Revision requested:\s*(.*)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line));
  const topic = sentenceCase(
    (rawTopic ?? "")
      .replace(/^(?:please\s+)?(?:draft|write|announce|post|send|share|publish)\s+(?:an?\s+)?/i, "")
      .replace(
        /^(?:tell|remind|let)\s+(?:everyone|the team|all|staff)\s+(?:know\s+)?(?:that\s+)?/i,
        "",
      )
      .replace(/^(?:production|internal|team|status)\s+update\s+(?:about|on|for)\s+/i, "")
      .replace(/^(?:update|note|announcement|message)\s+(?:about|on|for)\s+/i, ""),
    false,
  );
  const lead = `Heads up: ${topic || "a change is on the way"}.`;
  if (revisions.length === 0) {
    return `${lead} Nothing is required from you right now; details will follow in this thread. Reply here with questions.`;
  }
  const latest = revisions[revisions.length - 1].replace(/[.!]+$/, "");
  // A bare "reject" carries no ask to work in; a real note does.
  const bare = /^(?:reject(?:ed)?|no|nope|redo|revise|again)$/i.test(latest);
  return bare
    ? `${lead} Revised for another pass: the timing, what is affected, and who to contact are now spelled out, and the filler is gone. Reply here with questions.`
    : `${lead} Per your note ("${latest}"): this version names the exact timing, spells out what is affected and for how long, and gives a contact for questions. Nothing else is required from you.`;
}

// ─── research ───

const RESEARCH_PROFILES: Array<{
  match: RegExp;
  risks: string;
  opportunities: string;
  synthesis: string;
}> = [
  {
    match: /passkey|webauthn|passwordless/i,
    risks:
      "Risks: adoption friction on older devices, account-recovery complexity when a device is lost, and uneven platform support. Recovery is the least certain part.",
    opportunities:
      "Opportunities: lower phishing exposure, faster sign-in, and fewer password-reset tickets.",
    synthesis:
      "On balance, proceed: the sign-in and phishing gains outweigh the risks, provided recovery and platform gaps are designed for before rollout rather than after.",
  },
  {
    match: /self-?host|inference|gpu|on-?prem|run (?:our|its) own (?:model|llm)/i,
    risks:
      "Risks: GPU capital and idle cost before traffic justifies it, an on-call burden a small team cannot absorb, and hosted models improving faster than a self-managed stack can track.",
    opportunities:
      "Opportunities: lower unit cost at sustained volume, full control over data residency and model versions, and latency that is not shared with a provider's other tenants.",
    synthesis:
      "Not yet: rent inference until it is a top-three cost line or a data-residency requirement forces the issue, and keep the serving layer behind an interface so the switch is a config change.",
  },
];

const GENERIC_RESEARCH = {
  risks:
    "Risks: upfront cost and migration effort, uncertain adoption, and operational load on a team that is already stretched. The size of the effort is the least certain part.",
  opportunities:
    "Opportunities: lower long-run cost, tighter control over the outcome, and a differentiated experience competitors would need time to match.",
  synthesis:
    "On balance, proceed in stages: pilot with one team, measure the cost and adoption assumptions, and expand only when both hold.",
};

function researchOutput(request: AgentTextRequest): string {
  const topic = (request.prompt ?? "").replace(/^Topic:\s*/, "").split("\n")[0] ?? "";
  const profile = RESEARCH_PROFILES.find((entry) => entry.match.test(topic)) ?? GENERIC_RESEARCH;
  switch (request.name) {
    case "researchRisks":
      return profile.risks;
    case "researchOpportunities":
      return profile.opportunities;
    case "synthesize":
      return profile.synthesis;
    default:
      return "Analysis complete.";
  }
}

// ─── pipeline ───

/** The facts after the task's last colon, e.g. "faster sync, safer retries, gradual rollout". */
function pipelineFacts(task: string): string[] {
  const afterColon = task.includes(":") ? task.slice(task.lastIndexOf(":") + 1) : "";
  return afterColon
    .split(/,|;| and /)
    .map((fact) => fact.trim().replace(/[.]+$/, ""))
    .filter(Boolean);
}

function pipelineLead(task: string): string {
  if (/launch/i.test(task)) return "Launch update";
  if (/sprint/i.test(task)) return "Sprint summary";
  if (/release/i.test(task)) return "Release notes";
  if (/incident|outage|postmortem/i.test(task)) return "Incident summary";
  return "Update";
}

function joinFacts(facts: string[]): string {
  if (facts.length <= 1) return facts[0] ?? "";
  return `${facts.slice(0, -1).join(", ")}, and ${facts[facts.length - 1]}`;
}

/** "Write a welcome email for new users of our budgeting app." → "a welcome email for new users of our budgeting app" */
function pipelineSubject(task: string): string {
  return (
    task
      .replace(/^(?:please\s+)?(?:write|draft|create|compose|produce|make)\s+/i, "")
      .replace(/[.]+$/, "")
      .trim() || "the requested piece"
  );
}

function pipelineOutput(request: AgentTextRequest): string {
  const prompt = request.prompt ?? "";
  const task = (prompt.match(/^Task:\s*([\s\S]*?)\n\n/)?.[1] ?? prompt).trim();
  const facts = pipelineFacts(task);
  switch (request.name) {
    case "planTask":
      return facts.length
        ? `Plan: audience is the team; the ${facts.length} supplied facts are ${joinFacts(facts.map((f) => `"${f}"`))}; structure is one lead sentence, then one sentence per fact, no claims beyond them.`
        : `Plan: the task supplies no explicit facts, so the draft stays a template: name the audience, state the purpose of ${pipelineSubject(task)}, and end with one next step. No specifics are invented.`;
    case "executeTask":
      return facts.length
        ? `${pipelineLead(task)}: this cycle brings ${joinFacts(facts)}. Each item shipped as described, with no changes beyond those three.`
        : `Here is ${pipelineSubject(task)}. It says what this is for, what to expect first, and the one thing to do next. [Specifics go here once the notes supply them.] Reply to this message with any questions.`;
    case "verifyTask":
      return facts.length
        ? `All ${facts.length} supplied facts appear in the draft (${facts.map((f) => f.split(" ")[0]).join(", ")}); no unsupported claims were added. Verdict: publishable.`
        : "The task supplied no facts to check against, and the draft invents none: it is a template with a marked gap. Verdict: not publishable until the notes supply specifics.";
    default:
      return "Step complete.";
  }
}

// ─── retry ───

function classifyTicket(ticket: string): string {
  const text = ticket.replace(/\[primary-outage(?:-hard)?\]/g, "").toLowerCase();
  if (/bill|charge|invoice|payment|refund|total|receipt/.test(text)) {
    return "Category: billing · Priority: high · Route to billing support.";
  }
  if (/time ?out|slow|crash|error|fail|export|broken|500/.test(text)) {
    return "Category: technical · Priority: medium · Route to engineering triage.";
  }
  if (/password|log ?in|sign ?in|account|locked/.test(text)) {
    return "Category: account · Priority: medium · Route to account support.";
  }
  return "Category: general · Priority: low · Route to the support inbox.";
}

// ─── tools ───

type ToolCall =
  | { kind: "calc"; operation: "add" | "subtract" | "multiply" | "divide"; a: number; b: number }
  | { kind: "lookup"; key: string };

/** Phrases the scripted agent recognizes as retrieval questions, in lookup-key form. */
const LOOKUP_PHRASES: Array<{ match: RegExp; key: string }> = [
  { match: /speed of light/i, key: "speed of light" },
  { match: /earth(?:'s)? radius|radius of (?:the )?earth/i, key: "earth radius" },
  { match: /seconds (?:per|in a) day/i, key: "seconds per day" },
  {
    match: /moon distance|distance to the moon|how far (?:away )?is the moon/i,
    key: "moon distance",
  },
  { match: /boiling point of water/i, key: "boiling point of water" },
];

const CALC_PATTERNS: Array<{
  match: RegExp;
  operation: "add" | "subtract" | "multiply" | "divide";
}> = [
  {
    match: /(\d+(?:\.\d+)?)\s*(?:\*|x|×|times|multiplied by)\s*(\d+(?:\.\d+)?)/i,
    operation: "multiply",
  },
  { match: /multiply\s+(\d+(?:\.\d+)?)\s+(?:by|and)\s+(\d+(?:\.\d+)?)/i, operation: "multiply" },
  { match: /(\d+(?:\.\d+)?)\s*(?:\+|plus)\s*(\d+(?:\.\d+)?)/i, operation: "add" },
  { match: /add\s+(\d+(?:\.\d+)?)\s+(?:to|and)\s+(\d+(?:\.\d+)?)/i, operation: "add" },
  { match: /(\d+(?:\.\d+)?)\s*(?:-|minus)\s*(\d+(?:\.\d+)?)/i, operation: "subtract" },
  { match: /subtract\s+(\d+(?:\.\d+)?)\s+from\s+(\d+(?:\.\d+)?)/i, operation: "subtract" },
  { match: /(\d+(?:\.\d+)?)\s*(?:\/|÷|divided by)\s*(\d+(?:\.\d+)?)/i, operation: "divide" },
  { match: /divide\s+(\d+(?:\.\d+)?)\s+by\s+(\d+(?:\.\d+)?)/i, operation: "divide" },
];

function parseObservations(prompt: string): string[] {
  const block =
    prompt.match(/Observations:\n([\s\S]*?)(?:\n\nCall a tool or FINISH\.|$)/)?.[1] ?? "";
  return block
    .split("\n")
    .map((line) => line.replace(/^Observation:\s*/, "").trim())
    .filter((line) => line && line !== "(none)");
}

/** Every tool call the question asks for, in reading order. */
function requestedCalls(question: string): ToolCall[] {
  const calls: Array<{ index: number; call: ToolCall }> = [];
  for (const { match, operation } of CALC_PATTERNS) {
    const found = question.match(match);
    if (found && found.index !== undefined) {
      const [a, b] = [Number(found[1]), Number(found[2])];
      // "subtract X from Y" reads Y - X.
      const swap = operation === "subtract" && /^subtract/i.test(found[0]);
      calls.push({
        index: found.index,
        call: { kind: "calc", operation, a: swap ? b : a, b: swap ? a : b },
      });
      break; // one arithmetic question per prompt is enough for the script
    }
  }
  for (const { match, key } of LOOKUP_PHRASES) {
    const found = question.match(match);
    if (found && found.index !== undefined)
      calls.push({ index: found.index, call: { kind: "lookup", key } });
  }
  return calls.sort((left, right) => left.index - right.index).map((entry) => entry.call);
}

function isObserved(call: ToolCall, observations: string[]): boolean {
  return call.kind === "calc"
    ? observations.some((line) => line.startsWith(`${call.a} ${call.operation} ${call.b} =`))
    : observations.some(
        (line) => line.startsWith(`${call.key}:`) || line.includes(`No entry for "${call.key}"`),
      );
}

function nextToolCall(question: string, observations: string[]): ToolCall | undefined {
  return requestedCalls(question).find((call) => !isObserved(call, observations));
}

const OPERATOR_SYMBOL = { add: "+", subtract: "−", multiply: "×", divide: "÷" } as const;

/** A plain-language answer assembled from the tool observations. */
function composeAnswer(question: string, observations: string[]): string {
  const parts: string[] = [];
  for (const line of observations) {
    const calc = line.match(/^(\S+) (add|subtract|multiply|divide) (\S+) = (.+)$/);
    if (calc) {
      parts.push(
        `${calc[1]} ${OPERATOR_SYMBOL[calc[2] as keyof typeof OPERATOR_SYMBOL]} ${calc[3]} = ${calc[4]}.`,
      );
      continue;
    }
    const miss = line.match(/^No entry for "(.+)"\.$/);
    if (miss) {
      parts.push(`The knowledge base has no entry for "${miss[1]}", so I can't answer that part.`);
      continue;
    }
    const fact = line.match(/^([^:]+):\s*(.+)$/);
    if (fact) {
      const key = fact[1].trim();
      parts.push(
        key in KNOWLEDGE_BASE
          ? `The ${key} is ${fact[2]}.`
          : `${sentenceCase(key, true)}: ${fact[2]}.`,
      );
    }
  }
  if (parts.length === 0) {
    return `I can't answer "${question.trim()}" with the tools available (arithmetic and a small fact lookup).`;
  }
  return parts.join(" ");
}

// ─── reflection ───

/** "Write a vivid one-paragraph description of a tidal shoreline at dusk." → "a tidal shoreline at dusk" */
function reflectionSubject(topic: string): string {
  return (
    topic
      .replace(/^(?:please\s+)?(?:write|describe|give me|compose)\s+/i, "")
      .replace(
        /^(?:a\s+)?(?:vivid\s+)?(?:one-paragraph|one paragraph|short|brief)\s+(?:description|paragraph|piece)\s+(?:of|about|on)\s+/i,
        "",
      )
      .replace(/^(?:one paragraph|a paragraph)\s+(?:about|on|describing)\s+/i, "")
      .replace(/,?\s*in one paragraph\.?$/i, "")
      .replace(/[.]+$/, "")
      .trim() || "the scene"
  );
}

const REVISION_MARKER = "seems still at first";

function flatDraft(topic: string): string {
  const subject = reflectionSubject(topic);
  return `There is ${subject}. It stays like that for a while, and then it changes.`;
}

function revisedDraft(topic: string): string {
  const subject = sentenceCase(reflectionSubject(topic), true);
  return (
    `${subject} ${REVISION_MARKER}: the hum of a light that has been on too long, ` +
    `one voice carrying farther than it should, a door that never quite settles. ` +
    `Minutes pass without anyone marking them, and the stillness turns out to be attention — ` +
    `the whole scene holding its breath, waiting to see who moves first.`
  );
}

function isRevisedDraft(draft: string): boolean {
  return draft.includes(REVISION_MARKER);
}
