/**
 * The malleable POLICY layer: a playbook is a JSON `AgentWorkflowConfig` that
 * takes the desk's facts plus this turn's offered options as input and ends
 * in a final state whose output is ONE proposal event
 * (`{ type: <ProposalType>, ...payload }`). Wrapped by `createPlaybookDecide`,
 * it is a `decide` executor the desk's boundary calls like any other.
 *
 * The output must be exactly one of the offered options: `decideNext`
 * retries anything else, and the desk escalates when the retries run out.
 *
 * What a playbook may reference is a fixed vocabulary, injected here rather
 * than authored in the JSON:
 *   - input / events / output schemas: `PlaybookInput`, the proposal events, a proposal
 *   - `classifyTicket` (actor): a Jev judgment, "is this a refund request?"
 *   - `draftQuestion` (text request): one question for the customer
 *   - `agent.decide` over the proposal events, closed over `{{ context.facts.payloads }}`
 *   - the `playbookGuards` registry, for the checks the `{{ }}` template
 *     language cannot express (equality, comparison, array search)
 *
 * The playbook keeps its input at `context.facts` (the guards read it
 * there), and its final state outputs the chosen proposal.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { z } from "zod";
import { createAsyncLogic, type AnyStateMachine } from "xstate";
import { experimental_decide, type Experimental_DecisionModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import {
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentDecisionExecutor,
  type AgentExecutorDecisionRequest,
  type AgentRequestExecutor,
  type AgentWorkflowActorConfig,
  type AgentWorkflowConfig,
  type AgentWorkflowRequestConfig,
  type ChosenEvent,
  type SchemaCompiler,
  type StandardSchemaV1,
} from "@statelyai/agent";
import { factsSchema, PROPOSALS, proposalEventSchemas, type Facts } from "./contract.js";

// ─── Schemas ───

// The Ajv-to-StandardSchema recipe from examples/json-agent, shared with
// improve.ts so the gates lower proposals exactly as the decider does.
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

/**
 * `z.toJSONSchema` in input mode (no `additionalProperties: false`, so an
 * event's `type` key passes its payload schema), minus the draft-2020 `$schema`
 * key the default Ajv build does not know.
 */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: "input" });
  return rest;
}

/**
 * A playbook's input: the desk's facts plus `payloads`, this turn's offered
 * options grouped by proposal type (`{ ISSUE_REFUND: [{ amount: 40 }], CLOSE: [], ... }`;
 * every type is present, empty when nothing of that type is legal).
 */
export const playbookInputSchema = factsSchema.extend({
  payloads: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
export type PlaybookInput = z.infer<typeof playbookInputSchema>;

/** The playbook's input schema, generated from zod. */
const playbookInputJsonSchema = toJsonSchema(playbookInputSchema);

/** One proposal event, payload and `type` together. */
export const proposalSchema = z.discriminatedUnion(
  "type",
  PROPOSALS.map((type) => proposalEventSchemas[type].extend({ type: z.literal(type) })) as [
    z.ZodObject<{ type: z.ZodLiteral<string> }>,
    ...z.ZodObject<{ type: z.ZodLiteral<string> }>[],
  ],
);

const proposalEventJsonSchemas = Object.fromEntries(
  PROPOSALS.map((type) => [type, toJsonSchema(proposalEventSchemas[type])]),
);

// ─── The vocabulary ───

/** The model every playbook model call uses. A string ref, resolved by the host. */
export const PLAYBOOK_MODEL = "openai/gpt-5.4-mini";

/** Actors a playbook may invoke by name. */
export const playbookActorNames = ["classifyTicket"] as const;
/** Text requests a playbook may invoke by name. */
export const playbookRequestNames = ["draftQuestion"] as const;
/** The builtin a playbook may invoke for a model-chosen proposal. */
export const PLAYBOOK_DECIDE_SRC = "agent.decide";

const playbookActors: Record<(typeof playbookActorNames)[number], AgentWorkflowActorConfig> = {
  classifyTicket: {
    description:
      "Jev judgment: is the ticket (plus the customer's replies) a refund request? " +
      "Output { isRefundRequest: boolean, confidence: number }; read it in onDone as " +
      "{{ event.output.isRefundRequest }}.",
    input: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        customerReplies: { type: "array", items: { type: "string" } },
      },
      required: ["ticket", "customerReplies"],
    },
    output: {
      type: "object",
      properties: { isRefundRequest: { type: "boolean" }, confidence: { type: "number" } },
      required: ["isRefundRequest", "confidence"],
    },
  },
};

const playbookRequests: Record<(typeof playbookRequestNames)[number], AgentWorkflowRequestConfig> =
  {
    draftQuestion: {
      description:
        "Draft ONE short question for the customer. Input { ticket, missing }; read the " +
        "result in onDone as {{ event.output.result.question }}.",
      model: PLAYBOOK_MODEL,
      system:
        "You write one short, polite question to a customer asking for exactly the missing " +
        "detail. No greeting, no sign-off.",
      prompt: "Ticket: {{ input.ticket }}\nWe still need: {{ input.missing }}",
      input: {
        type: "object",
        properties: { ticket: { type: "string" }, missing: { type: "string" } },
        required: ["ticket", "missing"],
      },
      output: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
    },
  };

/** Reads the facts a playbook keeps at `context.facts`. */
function factsOf(context: unknown): Facts | undefined {
  const parsed = factsSchema.safeParse((context as { facts?: unknown } | undefined)?.facts);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Named guards a playbook may reference (`"guard": "overThreshold"`). They
 * cover what `{{ }}` guards cannot say: equality, comparison, and searching an
 * array. Every one reads `context.facts` and is false when the facts are
 * missing.
 */
export const playbookGuards = {
  /** A rejection this episode was about identity (a refused VERIFY_IDENTITY, or a reason naming it). */
  identityRejected: ({ context }: { context: unknown }) =>
    factsOf(context)?.rejections.some(
      (rejection) => rejection.proposal === "VERIFY_IDENTITY" || /identity/i.test(rejection.reason),
    ) ?? false,
  /** The loaded order's `customerId` is not the ticket's customer. */
  orderBelongsToOtherCustomer: ({ context }: { context: unknown }) => {
    const facts = factsOf(context);
    return !!facts?.order && facts.order.customerId !== facts.customerId;
  },
  /** The loaded order's total is above `approvalThreshold`. */
  overThreshold: ({ context }: { context: unknown }) => {
    const facts = factsOf(context);
    return !!facts?.order && facts.order.total > facts.approvalThreshold;
  },
} satisfies Record<string, (args: { context: unknown; event: unknown }) => boolean>;

/**
 * The config a playbook actually lowers to: the authored JSON plus the fixed
 * interface. `schemas.input/events/output`, `requests`, and `actors` are
 * always the vocabulary's; a playbook only authors `context` (and its schema)
 * and `states`.
 */
export function withPlaybookInterface(config: AgentWorkflowConfig): AgentWorkflowConfig {
  return {
    ...config,
    schemas: {
      ...config.schemas,
      input: playbookInputJsonSchema,
      events: proposalEventJsonSchemas,
      output: toJsonSchema(proposalSchema),
    },
    requests: playbookRequests,
    actors: playbookActors,
  };
}

/** Lowers a playbook with the vocabulary's schemas, requests, actors, and guards. Throws like `fromConfig`. */
export function lowerPlaybook(
  config: AgentWorkflowConfig,
  compileSchema: SchemaCompiler = ajvCompileSchema,
): AnyStateMachine {
  return setupAgent.fromConfig(withPlaybookInterface(config), {
    compileSchema,
    guards: playbookGuards,
  }).machine;
}

/** Reads `playbooks/<name>.json`. */
export function loadPlaybook(name: string): AgentWorkflowConfig {
  const path = fileURLToPath(new URL(`./playbooks/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as AgentWorkflowConfig;
}

// ─── classifyTicket ───

export type ClassifyTicketInput = { ticket: string; customerReplies: string[] };
export type ClassifyTicketOutput = { isRefundRequest: boolean; confidence: number };

/**
 * The classifier as a judgment: one boolean question to the decision model
 * (Jev by default), with the ticket and replies as state. `onCall` counts it.
 */
export function createClassifyTicket(model: Experimental_DecisionModel, onCall?: () => void) {
  return createAsyncLogic<ClassifyTicketOutput, ClassifyTicketInput>({
    run: async ({ input, signal }) => {
      onCall?.();
      const { answers } = await experimental_decide({
        model,
        state: { ticket: input.ticket, customerReplies: input.customerReplies },
        questions: {
          isRefundRequest: {
            type: "boolean" as const,
            instructions:
              "Is the customer asking for money back on an order, in `ticket` or " +
              "`customerReplies`? Questions about shipping, addresses, or anything else " +
              "are not refund requests.",
          },
        },
        abortSignal: signal,
      });
      const probability = answers.isRefundRequest.probability;
      return {
        isRefundRequest: probability >= 0.5,
        confidence: Math.max(probability, 1 - probability),
      };
    },
  });
}

// ─── The decider ───

export type PlaybookExecutors = {
  generateText: AgentRequestExecutor;
  decide: AgentDecisionExecutor;
};

export type PlaybookOptions = {
  executors: PlaybookExecutors;
  /** The judge behind `classifyTicket`. Defaults to Jev (`TYPESAFE_AI_API_KEY`). */
  judge?: Experimental_DecisionModel;
  compileSchema?: SchemaCompiler;
};

export type PlaybookDecide = AgentDecisionExecutor & {
  machine: AnyStateMachine;
  /** Calls made by every run of this decider so far. */
  counters: { modelCalls: number; judgeCalls: number };
  config: AgentWorkflowConfig;
};

/** The offered options of a closed choice, grouped by proposal type (every type present). */
export function payloadsByType(
  options: readonly { event: ChosenEvent }[],
): Record<string, Record<string, unknown>[]> {
  return Object.fromEntries(
    PROPOSALS.map((type) => [
      type,
      options
        .filter((option) => option.event.type === type)
        .map(({ event: { type: _type, ...payload } }) => payload),
    ]),
  );
}

/**
 * A playbook's input for one `decideNext` request: the facts from
 * `request.input.context`, this turn's failed attempts appended to
 * `rejections`, and the offered options as `payloads`.
 */
export function playbookInputOf(request: AgentExecutorDecisionRequest): PlaybookInput {
  const facts = factsSchema.parse((request.input as { context?: unknown } | undefined)?.context);
  return {
    ...facts,
    rejections: [
      ...facts.rejections,
      ...request.attempts.map((attempt) => ({
        proposal: attempt.event?.type ?? "(none)",
        reason: attempt.reason,
      })),
    ],
    payloads: payloadsByType(request.options ?? []),
  };
}

/**
 * Lowers `config` once and returns a decision executor that runs it per call
 * on {@link playbookInputOf} the request. A run that does not end `done` with
 * a valid proposal throws.
 */
export function createPlaybookDecide(
  config: AgentWorkflowConfig,
  options: PlaybookOptions,
): PlaybookDecide {
  const machine = lowerPlaybook(config, options.compileSchema);
  const counters = { modelCalls: 0, judgeCalls: 0 };

  const generateText: AgentRequestExecutor = (request, info) => {
    counters.modelCalls += 1;
    return options.executors.generateText(request, info);
  };
  const decide: AgentDecisionExecutor = (request, info) => {
    counters.modelCalls += 1;
    return options.executors.decide(request, info);
  };
  const classifyTicket = createClassifyTicket(
    options.judge ?? typeSafeAi.decisionModel("jev-latest"),
    () => {
      counters.judgeCalls += 1;
    },
  );

  const run: AgentDecisionExecutor = async (request) => {
    const input = playbookInputOf(request);
    const result = await runToQuiescence(
      createAgentRuntime(machine, {
        executors: { generateText, decide },
        actors: { classifyTicket },
      }),
      { input },
    );
    if (result.status !== "done") {
      const where = JSON.stringify(result.snapshot.value);
      const why = result.status === "error" ? `: ${String(result.error)}` : "";
      throw new Error(
        `playbook '${config.id ?? "(unnamed)"}' settled '${result.status}' in ${where}${why}`,
      );
    }
    const proposal = proposalSchema.safeParse(result.output);
    if (!proposal.success) {
      throw new Error(
        `playbook '${config.id ?? "(unnamed)"}' output is not a proposal: ` +
          `${JSON.stringify(result.output)} (${proposal.error.issues.map((i) => i.message).join("; ")})`,
      );
    }
    return { event: proposal.data };
  };

  return Object.assign(run, { machine, counters, config });
}
