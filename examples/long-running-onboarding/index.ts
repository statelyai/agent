/**
 * Long-running onboarding coordinator.
 *
 * Ported from the Google Cloud Tech ADK article shape: onboarding spans days,
 * not one chat turn. The machine sends a welcome packet, pauses while docs are
 * signed, delegates IT provisioning to a typed actor, pauses while hardware
 * ships, then writes a day-one schedule.
 *
 * The IT actor is a stub: the email and Slack handle it returns are derived
 * from the employee's name, so they are recorded (and prompted) as simulated
 * placeholders rather than accounts anyone can use.
 *
 * Demonstrates:
 *   - durable memory as typed machine context, not raw chat history
 *   - event-driven idle states: they wait for DOCS_SIGNED / DOCS_REJECTED and
 *     HARDWARE_DELIVERED, so no thread polls or stays blocked
 *   - the waits that make it long-running: a rejected packet goes back to the
 *     start, bounded by MAX_DOCS_REJECTIONS, and ESCALATE hands any stalled
 *     wait to a human — both end in the `escalated` final state
 *   - multi-agent delegation: the coordinator invokes a specialized IT actor
 *     and stores its output before waiting again
 *   - pause/resume by persisted JSON snapshots across fresh runAgent calls
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/long-running-onboarding/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { createAsyncLogic, type Snapshot, type StateValue } from "xstate";
import {
  getInteraction,
  getStatePath,
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
  type RunAgentOptions,
} from "@statelyai/agent";

/** Rejected document rounds allowed before the case is escalated to a human. */
export const MAX_DOCS_REJECTIONS = 2;

export const models = defineModels({
  scheduler: openai("gpt-5.4-mini"),
});

const employeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  startDate: z.string(),
  equipment: z.string(),
});

const accountsSchema = z.object({
  email: z.string(),
  slack: z.string(),
  ticketId: z.string(),
});
type Accounts = z.infer<typeof accountsSchema>;

const welcomePacketSchema = z.object({ packetId: z.string() });

// Stub IT system: it does NOT reach a real directory, so every identifier it
// returns is derived from the employee's name and labelled simulated
// downstream — nothing here implies a real mailbox or Slack account exists.
const provisionIt = createAsyncLogic({
  schemas: {
    input: employeeSchema,
    output: accountsSchema,
  },
  run: async ({ input }) => {
    const slug = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.+|\.+$/g, "");
    return {
      email: `${slug}@example.com`,
      slack: `@${slug}`,
      ticketId: `IT-${input.id}`,
    };
  },
});

const contextSchema = z.object({
  employee: employeeSchema,
  welcomePacketId: z.string().nullable(),
  docsSignedAt: z.string().nullable(),
  accounts: accountsSchema.nullable(),
  hardwareDeliveredAt: z.string().nullable(),
  schedule: z.string().nullable(),
  /** Document rounds rejected so far; bounds the resend loop. */
  docsRejections: z.number(),
  /** Why the case left the happy path. `null` while it is still on it. */
  escalation: z.string().nullable(),
});

const coordinatorSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ employee: employeeSchema }),
  // An onboarding that stalls is a real outcome, so the output says which of
  // the two final states the case ended in and leaves the rest nullable.
  output: z.object({
    employeeId: z.string(),
    status: z.enum(["onboarded", "escalated"]),
    welcomePacketId: z.string().nullable(),
    accounts: accountsSchema.nullable(),
    schedule: z.string().nullable(),
    escalation: z.string().nullable(),
  }),
  meta: interactionMetaSchema,
  events: {
    DOCS_SIGNED: z.object({ signedAt: z.string() }),
    /** HR sent the packet back: something in it was wrong. */
    DOCS_REJECTED: z.object({ reason: z.string() }),
    HARDWARE_DELIVERED: z.object({ deliveredAt: z.string() }),
    /** Any wait can be handed to a human instead of waiting longer. */
    ESCALATE: z.object({ note: z.string() }),
  },
  actors: {
    sendWelcomePacket: createAsyncLogic({
      schemas: {
        input: employeeSchema,
        output: welcomePacketSchema,
      },
      run: async ({ input }) => ({ packetId: `WELCOME-${input.id}` }),
    }),
    provisionIt,
  },
  requests: {
    writeDayOneSchedule: {
      schemas: {
        input: z.object({
          employee: employeeSchema,
          accounts: accountsSchema,
          // Status, not just a timestamp: the model is told delivery already
          // happened, so it cannot write it up as still upcoming.
          hardwareStatus: z.string(),
        }),
        output: z.string(),
      },
      model: "scheduler",
      system:
        "Write a concise day-one schedule for a new hire. Mention the role, " +
        "account setup, and hardware readiness. Never contradict the recorded " +
        "facts below: anything already recorded as done is in the past — never " +
        "describe it as upcoming or scheduled. Accounts marked simulated are " +
        "placeholders; do not present them as verified. Return only the schedule.",
      prompt: ({ input }) =>
        [
          `Employee: ${input.employee.name}`,
          `Role: ${input.employee.role}`,
          `Start date: ${input.employee.startDate}`,
          `Email (simulated): ${input.accounts.email}`,
          `Slack (simulated): ${input.accounts.slack}`,
          `Hardware: ${input.hardwareStatus}`,
        ].join("\n"),
    },
  },
  // waitingForHardware's HARDWARE_DELIVERED sets hardwareDeliveredAt in the
  // same transition that enters preparingSchedule; accounts was already set
  // earlier by provisioningIt. Both narrowed non-null there and downstream in
  // onboarded (schedule is set by preparingSchedule's own onDone).
  states: {
    // Narrowing threads through the chain: each state declares what is
    // guaranteed by the time it is entered, so every bare `target` into the
    // next narrowed state typechecks.
    waitingForSignedDocs: {
      schemas: { context: contextSchema.extend({ welcomePacketId: z.string() }) },
    },
    provisioningIt: {
      schemas: { context: contextSchema.extend({ welcomePacketId: z.string() }) },
    },
    waitingForHardware: {
      schemas: {
        context: contextSchema.extend({ welcomePacketId: z.string(), accounts: accountsSchema }),
      },
    },
    preparingSchedule: {
      schemas: {
        context: contextSchema.extend({
          welcomePacketId: z.string(),
          accounts: accountsSchema,
          hardwareDeliveredAt: z.string(),
        }),
      },
    },
    onboarded: {
      schemas: {
        context: contextSchema.extend({
          welcomePacketId: z.string(),
          accounts: accountsSchema,
          schedule: z.string(),
        }),
      },
    },
  },
});

export const longRunningOnboardingMachine = coordinatorSetup.createMachine({
  id: "long-running-onboarding",
  context: ({ input }) => ({
    employee: input.employee,
    welcomePacketId: null,
    docsSignedAt: null,
    accounts: null,
    hardwareDeliveredAt: null,
    schedule: null,
    docsRejections: 0,
    escalation: null,
  }),
  initial: "sendingWelcomePacket",
  states: {
    sendingWelcomePacket: {
      invoke: {
        src: "sendWelcomePacket",
        input: ({ context }) => context.employee,
        onDone: ({ output }) => ({
          target: "waitingForSignedDocs",
          context: { welcomePacketId: output.packetId },
        }),
        onError: ({ event }) => ({
          target: "escalated",
          context: { escalation: `Welcome packet could not be sent: ${String(event.error)}` },
        }),
      },
    },
    waitingForSignedDocs: {
      // `meta.interaction` is this machine's wait signal (see setupAgent above).
      meta: {
        interaction: {
          // `{path}` fields resolve against context when `getInteraction` reads
          // the label.
          label:
            "Waiting on {employee.name}'s signed onboarding documents. Mark them signed, send them back, or escalate.",
          events: {
            DOCS_SIGNED: { label: "Mark documents signed", style: "primary" },
            DOCS_REJECTED: { label: "Send the packet back" },
            ESCALATE: { label: "Escalate to HR", style: "danger" },
          },
        },
      },
      on: {
        DOCS_SIGNED: ({ event }) => ({
          target: "provisioningIt",
          context: { docsSignedAt: event.signedAt },
        }),
        // The wait that makes this long-running: a rejected packet goes back
        // to the start, but only MAX_DOCS_REJECTIONS times. Past that the case
        // is a person's problem, not the machine's.
        DOCS_REJECTED: ({ context, event }) =>
          context.docsRejections + 1 >= MAX_DOCS_REJECTIONS
            ? {
                target: "escalated",
                context: {
                  docsRejections: context.docsRejections + 1,
                  escalation: `Onboarding documents rejected ${context.docsRejections + 1} times. Last reason: ${event.reason}`,
                },
              }
            : {
                target: "sendingWelcomePacket",
                context: { docsRejections: context.docsRejections + 1 },
              },
        ESCALATE: ({ event }) => ({
          target: "escalated",
          context: { escalation: event.note },
        }),
      },
    },
    provisioningIt: {
      invoke: {
        src: "provisionIt",
        input: ({ context }) => context.employee,
        onDone: ({ output }) => ({
          target: "waitingForHardware",
          context: { accounts: output },
        }),
        onError: ({ event }) => ({
          target: "escalated",
          context: { escalation: `IT provisioning failed: ${String(event.error)}` },
        }),
      },
    },
    waitingForHardware: {
      meta: {
        interaction: {
          // The provisioning note is derived here rather than stored in
          // context: the simulated identifiers are labelled as such wherever
          // they are shown.
          label: ({ context }) =>
            `Simulated IT provisioning done (ticket ${context.accounts?.ticketId}): placeholder ` +
            `mailbox ${context.accounts?.email} and Slack handle ${context.accounts?.slack} were ` +
            `derived from the employee's name; no real accounts exist. Waiting on hardware delivery.`,
          events: {
            HARDWARE_DELIVERED: { label: "Mark laptop delivered", style: "primary" },
            ESCALATE: { label: "Escalate to IT", style: "danger" },
          },
        },
      },
      on: {
        HARDWARE_DELIVERED: ({ event }) => ({
          target: "preparingSchedule",
          context: { hardwareDeliveredAt: event.deliveredAt },
        }),
        ESCALATE: ({ event }) => ({
          target: "escalated",
          context: { escalation: event.note },
        }),
      },
    },
    preparingSchedule: {
      invoke: {
        src: "writeDayOneSchedule",
        input: ({ context }) => ({
          employee: context.employee,
          accounts: context.accounts,
          hardwareStatus: `delivered on ${context.hardwareDeliveredAt} (already received)`,
        }),
        onDone: ({ output }) => ({
          target: "onboarded",
          context: { schedule: output },
        }),
        onError: ({ event }) => ({
          target: "escalated",
          context: { escalation: `Day-one schedule could not be written: ${String(event.error)}` },
        }),
      },
    },
    onboarded: {
      type: "final",
      output: ({ context }) => ({
        employeeId: context.employee.id,
        status: "onboarded" as const,
        welcomePacketId: context.welcomePacketId,
        accounts: context.accounts,
        schedule: context.schedule,
        escalation: null,
      }),
    },
    // The case left the happy path — too many rejected packets, a human
    // escalation, or a failed step. It ends here with the reason, rather than
    // reporting a completed onboarding that never happened.
    escalated: {
      type: "final",
      output: ({ context }) => ({
        employeeId: context.employee.id,
        status: "escalated" as const,
        welcomePacketId: context.welcomePacketId,
        accounts: context.accounts,
        schedule: context.schedule,
        escalation: context.escalation ?? "escalated",
      }),
    },
  },
});

export interface RunLongRunningOnboardingOptions {
  employee?: z.infer<typeof employeeSchema>;
  generateText?: AgentRequestExecutors["generateText"];
  onTransition?: (snapshot: { value: StateValue }) => void;
  /**
   * The human answers, in order, one per idle pause. Defaults to the happy
   * path; a test can hand it a rejection or an escalation instead.
   */
  answers?: OnboardingEvent[];
}

/** What a host sends to unblock one of the machine's waits. */
export type OnboardingEvent =
  | { type: "DOCS_SIGNED"; signedAt: string }
  | { type: "DOCS_REJECTED"; reason: string }
  | { type: "HARDWARE_DELIVERED"; deliveredAt: string }
  | { type: "ESCALATE"; note: string };

const DEFAULT_ANSWERS: OnboardingEvent[] = [
  { type: "DOCS_SIGNED", signedAt: "2026-07-20" },
  { type: "HARDWARE_DELIVERED", deliveredAt: "2026-07-28" },
];

/** Safety cap: a rejected packet re-enters `waitingForSignedDocs`, so the host
 * loop needs its own bound as well as the machine's. */
const MAX_PAUSES = 8;

export interface LongRunningOnboardingResult {
  idleStates: string[];
  idlePrompts: string[];
  idleEventTypes: string[][];
  output: {
    employeeId: string;
    status: "onboarded" | "escalated";
    welcomePacketId: string | null;
    accounts: Accounts | null;
    schedule: string | null;
    escalation: string | null;
  };
}

export async function runLongRunningOnboardingExample(
  options: RunLongRunningOnboardingOptions = {},
): Promise<LongRunningOnboardingResult> {
  const employee = options.employee ?? {
    id: "E-100",
    name: "Ann Lee",
    role: "Product Engineer",
    startDate: "2026-08-03",
    equipment: "MacBook Pro",
  };

  const idleStates: string[] = [];
  const idlePrompts: string[] = [];
  const idleEventTypes: string[][] = [];
  const answers = [...(options.answers ?? DEFAULT_ANSWERS)];

  // One options object, built once: the mock replaces the real executors
  // rather than layering over them.
  const shared: Partial<RunAgentOptions<typeof longRunningOnboardingMachine>> = {
    executors: options.generateText
      ? { generateText: options.generateText }
      : createAiSdkExecutors({ models }),
    ...(options.onTransition ? { onTransition: options.onTransition } : {}),
  };

  let result = await runAgent(longRunningOnboardingMachine, {
    input: { employee },
    ...shared,
  });

  // Days pass between these calls in a real deployment. Each pause persists to
  // JSON and the next call resumes from it.
  for (let pause = 0; pause < MAX_PAUSES && result.status === "idle"; pause++) {
    const interaction = getInteraction(result.snapshot);
    idleStates.push(getStatePath(result.snapshot));
    idlePrompts.push(interaction?.label ?? "");
    idleEventTypes.push(interaction?.events.map(({ type }) => type) ?? []);

    const answer = answers.shift();
    if (!answer)
      throw new Error(`No answer scripted for pause at '${getStatePath(result.snapshot)}'.`);

    result = await runAgent(longRunningOnboardingMachine, {
      snapshot: JSON.parse(JSON.stringify(result.persist())) as Snapshot<unknown>,
      event: answer,
      ...shared,
    });
  }

  if (result.status !== "done") {
    throw new Error(`Onboarding did not reach a final state: ${result.status}`);
  }

  return { idleStates, idlePrompts, idleEventTypes, output: result.output };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runLongRunningOnboardingExample({
      onTransition: (snapshot) => console.log("[state]", getStatePath(snapshot)),
    });

    console.log("Idle states:", result.idleStates.join(" -> "));
    console.log("Idle prompts:", result.idlePrompts.join(" / "));
    console.log("Outcome:", result.output.status);
    console.log("Accounts:", result.output.accounts);
    console.log("Schedule:", result.output.schedule ?? result.output.escalation);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
