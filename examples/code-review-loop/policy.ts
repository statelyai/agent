/**
 * The malleable POLICY: a JSON `AgentWorkflowConfig` (`policies/*.json`) that
 * takes the triage facts plus this turn's offered options as input and ends
 * in a final state whose output is ONE event, `RETRY {feedback, focus}` or
 * `ESCALATE {reason}`. Wrapped by `createPolicyDecide`, it is the decide
 * executor for the environment's model ref `"triage"`.
 *
 * What a policy may reference is a fixed vocabulary, injected here rather
 * than authored in the JSON:
 *   - input / events / output schemas: `PolicyInput`, RETRY and ESCALATE, one event
 *   - `classifyIssue` (actor): a judgment, "can another round fix these issues, or
 *     is the task itself broken?" (Jev in tests, Claude Code in run.ts)
 *   - `agent.decide` with model `"policy"` over RETRY and ESCALATE, closed over
 *     `{{ context.facts.payloads }}`
 *
 * The output must equal one of the offered options: the environment's
 * `agent.decide` retries anything else, and escalates when the retries run out.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { z } from "zod";
import { createAsyncLogic, type AnyActorLogic, type AnyStateMachine } from "xstate";
import { experimental_decide, type Experimental_DecisionModel } from "ai";
import {
  setupAgent,
  type AgentDecisionExecutor,
  type AgentExecutorDecisionRequest,
  type AgentRequestExecutor,
  type AgentWorkflowActorConfig,
  type AgentWorkflowConfig,
  type ChosenEvent,
  type SchemaCompiler,
  type StandardSchemaV1,
  runAgent,
} from "@statelyai/agent";
import { RETRY_FOCI, issueSchema, reviewLoopEvents, triageFactsSchema } from "./environment.js";

// ─── Schemas ───

// The Ajv-to-StandardSchema recipe from examples/json-agent.
const ajv = new Ajv({ strict: false });
export const ajvCompileSchema: SchemaCompiler = (jsonSchema, name): StandardSchemaV1 => {
  const validate = ajv.compile(jsonSchema);
  return {
    "~standard": {
      version: 1,
      vendor: "ajv",
      validate: (value: unknown) =>
        validate(value)
          ? { value }
          : {
              issues: (validate.errors ?? []).map((error) => ({
                message: `${name}${error.instancePath} ${error.message}`,
              })),
            },
      jsonSchema: { input: () => jsonSchema },
    },
  };
};

/** `z.toJSONSchema` in input mode, minus the draft-2020 `$schema` key the default Ajv build does not know. */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: "input" });
  return rest;
}

export const POLICY_EVENTS = ["RETRY", "ESCALATE"] as const;

const retryOptionSchema = reviewLoopEvents.RETRY.extend({ type: z.literal("RETRY") });

/**
 * A policy's input: the triage facts, plus this turn's offered options twice
 * over: `retry` keyed by focus (`retry.tests` is the RETRY whose feedback is
 * the failing tests only; absent when not offered), and `payloads` grouped by
 * type for `agent.decide`.
 */
export const policyInputSchema = triageFactsSchema.extend({
  retry: z.partialRecord(z.enum(RETRY_FOCI), retryOptionSchema),
  escalateReasons: z.array(z.string()),
  payloads: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
export type PolicyInput = z.infer<typeof policyInputSchema>;

/** One policy decision: RETRY or ESCALATE, payload and `type` together. */
export const policyOutputSchema = z.discriminatedUnion("type", [
  retryOptionSchema,
  reviewLoopEvents.ESCALATE.extend({ type: z.literal("ESCALATE") }),
]);

// ─── The vocabulary ───

/** The model ref a policy's own `agent.decide` uses. Resolved by the host. */
export const POLICY_MODEL = "policy";
/** Actors a policy may invoke by name. */
export const policyActorNames = ["classifyIssue"] as const;

export const classifyIssueInputSchema = z.object({
  issues: z.array(issueSchema),
  concerns: z.array(z.string()),
  failingTests: z.array(z.string()),
});
export type ClassifyIssueInput = z.infer<typeof classifyIssueInputSchema>;
export type ClassifyIssueOutput = { novel: boolean; confidence: number };

const policyActors: Record<(typeof policyActorNames)[number], AgentWorkflowActorConfig> = {
  classifyIssue: {
    description:
      "Judgment: can another round fix these review issues, or is the task itself broken " +
      "(the spec contradicts itself or the tests, or a person must decide)? Output " +
      "{ novel: boolean, confidence: number }; read it in onDone as {{ event.output.novel }}.",
    input: toJsonSchema(classifyIssueInputSchema),
    output: {
      type: "object",
      properties: { novel: { type: "boolean" }, confidence: { type: "number" } },
      required: ["novel", "confidence"],
    },
  },
};

/**
 * The config a policy actually lowers to: the authored JSON plus the fixed
 * interface. A policy only authors `context` (and its schema) and `states`.
 */
export function withPolicyInterface(config: AgentWorkflowConfig): AgentWorkflowConfig {
  return {
    ...config,
    schemas: {
      ...config.schemas,
      input: toJsonSchema(policyInputSchema),
      events: Object.fromEntries(
        POLICY_EVENTS.map((type) => [type, toJsonSchema(reviewLoopEvents[type])]),
      ),
      output: toJsonSchema(policyOutputSchema),
    },
    actors: policyActors,
  };
}

/** Lowers a policy with the vocabulary's schemas and actors. Throws like `fromConfig`. */
export function lowerPolicy(
  config: AgentWorkflowConfig,
  compileSchema: SchemaCompiler = ajvCompileSchema,
): AnyStateMachine {
  return setupAgent.fromConfig(withPolicyInterface(config), { compileSchema }).machine;
}

/** Reads `policies/<name>.json`. */
export function loadPolicy(name: string): AgentWorkflowConfig {
  const path = fileURLToPath(new URL(`./policies/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as AgentWorkflowConfig;
}

// ─── classifyIssue ───

/** Any function that classifies a round's issues: a decision model, Claude Code, a script. */
export type IssueClassifier = (
  input: ClassifyIssueInput,
  signal?: AbortSignal,
) => Promise<ClassifyIssueOutput>;

/** The classifier as actor logic; `onCall` counts it. */
export function createClassifyIssue(classify: IssueClassifier, onCall?: () => void) {
  return createAsyncLogic<ClassifyIssueOutput, ClassifyIssueInput>({
    run: async ({ input, signal }) => {
      onCall?.();
      return classify(input, signal);
    },
  });
}

/** A classifier backed by an AI SDK decision model (Jev): one boolean question, the issues as state. */
export function judgeClassifier(model: Experimental_DecisionModel): IssueClassifier {
  return async (input, signal) => {
    const { answers } = await experimental_decide({
      model,
      state: input,
      questions: {
        novel: {
          type: "boolean" as const,
          instructions:
            "Do these review issues say the task itself is broken: the spec contradicts itself " +
            "or the tests, or a person has to make a decision? Bugs a better patch could fix " +
            "are not.",
        },
      },
      ...(signal ? { abortSignal: signal } : {}),
    });
    const probability = answers.novel.probability;
    return { novel: probability >= 0.5, confidence: Math.max(probability, 1 - probability) };
  };
}

// ─── The decider ───

export type PolicyOptions = {
  /** Executors for the policy's own requests: `decide` for an `agent.decide` with model "policy". */
  executors?: { decide?: AgentDecisionExecutor; generateText?: AgentRequestExecutor };
  /** Backs the `classifyIssue` actor. */
  classify?: IssueClassifier;
  compileSchema?: SchemaCompiler;
};

export type PolicyDecide = AgentDecisionExecutor & {
  machine: AnyStateMachine;
  config: AgentWorkflowConfig;
  /** Calls made by every run of this policy so far. */
  counters: { modelCalls: number; judgeCalls: number };
};

/**
 * A policy's input for one triage request: the facts the environment put on
 * `request.metadata.facts`, and the offered options (`request.options`, which
 * the runtime already filtered to the ones the environment accepts).
 */
export function policyInputOf(
  request: Pick<AgentExecutorDecisionRequest, "metadata" | "options">,
): PolicyInput {
  const facts = triageFactsSchema.parse(request.metadata?.["facts"]);
  const events = (request.options ?? []).map(({ event }) => event);
  const retry: PolicyInput["retry"] = {};
  for (const event of events) {
    const parsed = retryOptionSchema.safeParse(event);
    if (parsed.success) retry[parsed.data.focus] = parsed.data;
  }
  const payloads = Object.fromEntries(
    POLICY_EVENTS.map((type) => [
      type,
      events.filter((e) => e.type === type).map(({ type: _type, ...payload }) => payload),
    ]),
  );
  return {
    ...facts,
    retry,
    escalateReasons: events.flatMap((e) =>
      e.type === "ESCALATE" ? [String((e as { reason?: unknown }).reason)] : [],
    ),
    payloads,
  };
}

const noClassifier: IssueClassifier = async () => {
  throw new Error("classifyIssue: no classifier bound (pass `classify` to createPolicyDecide)");
};

/**
 * Lowers `config` once and returns a decision executor that runs it per call
 * on {@link policyInputOf} the request. A run that does not end `done` with a
 * RETRY or ESCALATE event throws, which the environment retries.
 */
export function createPolicyDecide(
  config: AgentWorkflowConfig,
  options: PolicyOptions = {},
): PolicyDecide {
  const machine = lowerPolicy(config, options.compileSchema);
  const counters = { modelCalls: 0, judgeCalls: 0 };
  const inner = options.executors ?? {};
  const decide: AgentDecisionExecutor = (request, info) => {
    counters.modelCalls += 1;
    if (!inner.decide) throw new Error("policy: no decide executor for model 'policy'");
    return inner.decide(request, info);
  };
  const actors: Record<string, AnyActorLogic> = {
    classifyIssue: createClassifyIssue(options.classify ?? noClassifier, () => {
      counters.judgeCalls += 1;
    }),
  };

  // The outer run's signal aborts the nested policy run, which stops its
  // actors: `classifyIssue` and the policy's own model calls see the abort.
  const run: AgentDecisionExecutor = async (request, info) => {
    const result = await runAgent(machine, {
      executors: { decide, ...(inner.generateText ? { generateText: inner.generateText } : {}) },
      actors,
      ...(info?.signal ? { signal: info.signal } : {}),
      input: policyInputOf(request),
    });
    if (result.status !== "done") {
      const why = result.status === "error" ? `: ${String(result.error)}` : "";
      throw new Error(
        `policy '${config.id ?? "(unnamed)"}' settled '${result.status}' in ` +
          `${JSON.stringify(result.snapshot.value)}${why}`,
      );
    }
    const event = policyOutputSchema.safeParse(result.output);
    if (!event.success) {
      throw new Error(
        `policy '${config.id ?? "(unnamed)"}' output is not RETRY or ESCALATE: ` +
          JSON.stringify(result.output),
      );
    }
    return { event: event.data as ChosenEvent };
  };

  return Object.assign(run, { machine, config, counters });
}

/**
 * The environment's executors with the policy plugged in: decisions for model
 * `"triage"` go to `policy`, every text request to `generateText`.
 */
export function withPolicy(
  executors: { generateText: AgentRequestExecutor },
  policy: AgentDecisionExecutor,
): { generateText: AgentRequestExecutor; decide: AgentDecisionExecutor } {
  return {
    generateText: executors.generateText,
    decide: (request, info) => {
      if (request.model !== "triage") {
        throw new Error(`no decide executor for model '${request.model}'`);
      }
      return policy(request, info);
    },
  };
}
