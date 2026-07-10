/**
 * Long-running onboarding coordinator.
 *
 * Ported from the Google Cloud Tech ADK article shape: onboarding spans days,
 * not one chat turn. The machine sends a welcome packet, pauses while docs are
 * signed, delegates IT provisioning to a typed actor, pauses while hardware
 * ships, then writes a day-one schedule.
 *
 * Demonstrates:
 *   - durable memory as typed machine context, not raw chat history
 *   - event-driven dormancy gates: idle states wait for DOCS_SIGNED and
 *     HARDWARE_DELIVERED, so no thread polls or stays blocked
 *   - multi-agent delegation: the coordinator invokes a specialized IT actor
 *     and stores its output before waiting again
 *   - pause/resume by persisted JSON snapshots across fresh runAgent calls
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/long-running-onboarding/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { type LanguageModel } from "ai";
import { createAsyncLogic } from "xstate";
import {
  getAcceptedEvents,
  getStateMeta,
  persistSnapshot,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "../../src/index.js";

export const models: Record<"scheduler", LanguageModel> = {
  scheduler: openai("gpt-5.4-mini"),
} as const;

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

const interactionSchema = z.object({
  label: z.string(),
});

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

const coordinatorSetup = setupAgent({
  models,
  context: z.object({
    employee: employeeSchema,
    welcomePacketId: z.string().nullable(),
    docsSignedAt: z.string().nullable(),
    accounts: accountsSchema.nullable(),
    hardwareDeliveredAt: z.string().nullable(),
    schedule: z.string().nullable(),
  }),
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
  actorSources: {
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
          hardwareDeliveredAt: z.string(),
        }),
        output: z.string(),
      },
      model: "scheduler",
      system:
        "Write a concise day-one schedule for a new hire. Mention the role, " +
        "account setup, and hardware readiness. Return only the schedule.",
      prompt: ({ input }) =>
        [
          `Employee: ${input.employee.name}`,
          `Role: ${input.employee.role}`,
          `Start date: ${input.employee.startDate}`,
          `Email: ${input.accounts.email}`,
          `Slack: ${input.accounts.slack}`,
          `Hardware delivered: ${input.hardwareDeliveredAt}`,
        ].join("\n"),
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
      meta: {
        interaction: {
          label: "Wait until the employee signs onboarding documents.",
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
          context: { accounts: output },
        }),
      },
    },
    waitingForHardware: {
      meta: {
        interaction: {
          label: "Wait until the laptop is delivered.",
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
          accounts: context.accounts ?? { email: "", slack: "", ticketId: "" },
          hardwareDeliveredAt: context.hardwareDeliveredAt ?? "",
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
        welcomePacketId: context.welcomePacketId ?? "",
        accounts: context.accounts ?? { email: "", slack: "", ticketId: "" },
        schedule: context.schedule ?? "",
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
    ...(options.generateText ? { generateText: options.generateText } : {}),
    ...(options.onTransition ? { onTransition: options.onTransition } : {}),
  });
  if (first.status !== "idle") {
    throw new Error(`Expected waiting for signed docs, got '${first.status}'.`);
  }
  idleStates.push(String(first.snapshot.value));
  idlePrompts.push(getStateMeta(first.snapshot).interaction?.label ?? "");
  idleEventTypes.push(getAcceptedEvents(first.snapshot).map((event) => event.type));

  const persistedAfterWelcome = persistSnapshot(first.snapshot);
  const second = await runAgent(longRunningOnboardingMachine, {
    snapshot: persistedAfterWelcome,
    event: { type: "DOCS_SIGNED", signedAt: "2026-07-20" },
    ...(options.generateText ? { generateText: options.generateText } : {}),
    ...(options.onTransition ? { onTransition: options.onTransition } : {}),
  });
  if (second.status !== "idle") {
    throw new Error(`Expected waiting for hardware, got '${second.status}'.`);
  }
  idleStates.push(String(second.snapshot.value));
  idlePrompts.push(getStateMeta(second.snapshot).interaction?.label ?? "");
  idleEventTypes.push(getAcceptedEvents(second.snapshot).map((event) => event.type));

  const persistedAfterProvisioning = persistSnapshot(second.snapshot);
  const third = await runAgent(longRunningOnboardingMachine, {
    snapshot: persistedAfterProvisioning,
    event: { type: "HARDWARE_DELIVERED", deliveredAt: "2026-07-28" },
    ...(options.generateText ? { generateText: options.generateText } : {}),
    ...(options.onTransition ? { onTransition: options.onTransition } : {}),
  });
  if (third.status !== "done") {
    throw new Error(`Expected onboarding done, got '${third.status}'.`);
  }

  return { idleStates, idlePrompts, idleEventTypes, output: third.output };
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  const { createAiSdkExecutors } = await import("../../src/ai-sdk/index.js");
  const { generateText } = createAiSdkExecutors({ models });

  const result = await runLongRunningOnboardingExample({
    generateText,
    onTransition: ({ value }) => console.log("[state]", JSON.stringify(value)),
  });

  console.log("Idle states:", result.idleStates.join(" -> "));
  console.log("Idle prompts:", result.idlePrompts.join(" / "));
  console.log("Accounts:", result.output.accounts);
  console.log("Schedule:", result.output.schedule);
}
