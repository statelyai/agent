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
 *   - event-driven idle states: they wait for DOCS_SIGNED and
 *     HARDWARE_DELIVERED, so no thread polls or stays blocked
 *   - multi-agent delegation: the coordinator invokes a specialized IT actor
 *     and stores its output before waiting again
 *   - pause/resume by persisted JSON snapshots across fresh runAgent calls
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/long-running-onboarding/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { createAsyncLogic } from "xstate";
import {
  getAcceptedEvents,
  getStateMeta,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

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

// The pause's `label`, plus a button `label`/`style` per accepted event so a
// host can render each gate without knowing the state names.
const interactionSchema = z.object({
  label: z.string(),
  events: z
    .record(
      z.string(),
      z.object({
        label: z.string().optional(),
        style: z.enum(["primary", "danger", "default"]).optional(),
      }),
    )
    .optional(),
  textEvent: z.string().optional(),
});

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
  // Plain-language record of what provisioning actually did — shown to whoever
  // is waiting, so the fabricated identifiers are never read as real ones.
  provisioningNote: z.string().nullable(),
  hardwareDeliveredAt: z.string().nullable(),
  schedule: z.string().nullable(),
});

const coordinatorSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ employee: employeeSchema }),
  output: z.object({
    employeeId: z.string(),
    welcomePacketId: z.string(),
    accounts: accountsSchema,
    schedule: z.string(),
  }),
  meta: z.object({ interaction: interactionSchema.optional() }),
  events: {
    DOCS_SIGNED: z.object({ signedAt: z.string() }),
    HARDWARE_DELIVERED: z.object({ deliveredAt: z.string() }),
  },
  // Meta-based wait signal: this machine already annotates every human-wait
  // state with `meta.interaction` (what the host should show), so it reuses that
  // as its suspension signal instead of a separate tag. runAgent settles idle
  // deterministically at any resting state carrying an interaction.
  isIdle: (snapshot) => getStateMeta(snapshot).interaction !== undefined,
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
    provisioningNote: null,
    hardwareDeliveredAt: null,
    schedule: null,
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
      },
    },
    waitingForSignedDocs: {
      // `meta.interaction` is this machine's wait signal (see setupAgent above).
      meta: {
        interaction: {
          // `{employee}` fields resolve against context when the label is shown.
          label: "Waiting for the signed onboarding documents. Mark them signed to continue.",
          events: { DOCS_SIGNED: { label: "Mark documents signed", style: "primary" } },
        },
      },
      on: {
        DOCS_SIGNED: ({ event }) => ({
          target: "provisioningIt",
          context: { docsSignedAt: event.signedAt },
        }),
      },
    },
    provisioningIt: {
      invoke: {
        src: "provisionIt",
        input: ({ context }) => context.employee,
        onDone: ({ output }) => ({
          target: "waitingForHardware",
          context: {
            accounts: output,
            provisioningNote:
              `Simulated IT provisioning (ticket ${output.ticketId}): placeholder ` +
              `mailbox ${output.email} and Slack handle ${output.slack} were derived ` +
              `from the employee's name. No real accounts were created.`,
          },
        }),
      },
    },
    waitingForHardware: {
      meta: {
        interaction: {
          label: "Waiting on hardware delivery. Mark the laptop delivered to continue.",
          events: { HARDWARE_DELIVERED: { label: "Mark laptop delivered", style: "primary" } },
        },
      },
      on: {
        HARDWARE_DELIVERED: ({ event }) => ({
          target: "preparingSchedule",
          context: { hardwareDeliveredAt: event.deliveredAt },
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
      },
    },
    onboarded: {
      type: "final",
      output: ({ context }) => ({
        employeeId: context.employee.id,
        welcomePacketId: context.welcomePacketId,
        accounts: context.accounts,
        schedule: context.schedule,
      }),
    },
  },
});

export interface RunLongRunningOnboardingOptions {
  employee?: z.infer<typeof employeeSchema>;
  generateText?: AgentRequestExecutors["generateText"];
  onTransition?: (snapshot: { value: unknown }) => void;
}

export interface LongRunningOnboardingResult {
  idleStates: string[];
  idlePrompts: string[];
  idleEventTypes: string[][];
  output: {
    employeeId: string;
    welcomePacketId: string;
    accounts: Accounts;
    schedule: string;
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

  const first = await runAgent(longRunningOnboardingMachine, {
    input: { employee },
    ...(options.generateText
      ? { executors: { generateText: options.generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    ...(options.onTransition ? { onTransition: options.onTransition } : {}),
  });
  if (first.status !== "idle") {
    throw new Error(`Expected waiting for signed docs, got '${first.status}'.`);
  }
  idleStates.push(String(first.snapshot.value));
  idlePrompts.push(getStateMeta(first.snapshot).interaction?.label ?? "");
  idleEventTypes.push(getAcceptedEvents(first.snapshot).map((event) => event.type));

  const persistedAfterWelcome = first.persist();
  const second = await runAgent(longRunningOnboardingMachine, {
    snapshot: persistedAfterWelcome,
    event: { type: "DOCS_SIGNED", signedAt: "2026-07-20" },
    ...(options.generateText
      ? { executors: { generateText: options.generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    ...(options.onTransition ? { onTransition: options.onTransition } : {}),
  });
  if (second.status !== "idle") {
    throw new Error(`Expected waiting for hardware, got '${second.status}'.`);
  }
  idleStates.push(String(second.snapshot.value));
  idlePrompts.push(getStateMeta(second.snapshot).interaction?.label ?? "");
  idleEventTypes.push(getAcceptedEvents(second.snapshot).map((event) => event.type));

  const persistedAfterProvisioning = second.persist();
  const third = await runAgent(longRunningOnboardingMachine, {
    snapshot: persistedAfterProvisioning,
    event: { type: "HARDWARE_DELIVERED", deliveredAt: "2026-07-28" },
    ...(options.generateText
      ? { executors: { generateText: options.generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    ...(options.onTransition ? { onTransition: options.onTransition } : {}),
  });
  if (third.status !== "done") {
    throw new Error(`Expected onboarding done, got '${third.status}'.`);
  }

  return { idleStates, idlePrompts, idleEventTypes, output: third.output };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runLongRunningOnboardingExample({
      onTransition: ({ value }) => console.log("[state]", JSON.stringify(value)),
    });

    console.log("Idle states:", result.idleStates.join(" -> "));
    console.log("Idle prompts:", result.idlePrompts.join(" / "));
    console.log("Accounts:", result.output.accounts);
    console.log("Schedule:", result.output.schedule);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
