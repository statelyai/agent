/**
 * An agent proposes an itinerary; a human approves before reservations begin.
 * If hotel booking fails, compensate the flight reservation. Compensation can
 * fail too: preserve its reference and stop for manual recovery.
 * Pattern: https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction
 * Run: OPENAI_API_KEY=... pnpm tsx examples/booking-compensation/index.ts
 * The planner is a real model call; pass `executors` to swap the model layer
 * (tests script it by request name). All booking actors are explicitly simulated. A real host overrides them and
 * must make operations idempotent by bookingId; snapshots alone cannot provide
 * exactly-once external effects or resolve uncertain provider outcomes.
 */
import { createAsyncLogic } from "xstate";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  interactionMetaSchema,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRuntimeOptions,
  type AgentRunInit,
} from "@statelyai/agent";

const itinerary = z.object({ flight: z.string(), hotel: z.string() });
type HotelResult = { status: "reserved"; reference: string } | { status: "unavailable" };
type CancelResult = { status: "cancelled" } | { status: "pending" };
type BookingInput = { bookingId: string; item: string };
const models = {
  planner: openai("gpt-5.4-mini"),
};
const agent = setupAgent({
  models,
  input: z.object({ bookingId: z.string(), destination: z.string() }),
  context: z.object({
    bookingId: z.string(),
    destination: z.string(),
    itinerary: itinerary.nullable(),
    hotelStatus: z.enum(["reserved", "unavailable"]).nullable(),
    compensationStatus: z.enum(["cancelled"]).nullable(),
    flightReference: z.string().nullable(),
    hotelReference: z.string().nullable(),
  }),
  output: z.object({
    bookingId: z.string(),
    outcome: z.enum(["booked", "cancelled", "compensated", "manualRecovery", "failed"]),
    flightReference: z.string().nullable(),
    hotelReference: z.string().nullable(),
  }),
  meta: interactionMetaSchema,
  events: { APPROVE: z.object({}), CANCEL: z.object({}) },
  actors: {
    reserveFlight: createAsyncLogic<string, BookingInput>({
      run: async ({ input }) => `simulated-flight:${input.bookingId}`,
    }),
    /**
     * The simulated provider refuses a booking whose id ends in `-sold-out`.
     * Without a way to fail, the compensation and reconciliation states this
     * example exists to show are unreachable outside its tests.
     */
    reserveHotel: createAsyncLogic<HotelResult, BookingInput>({
      run: async ({ input }) =>
        input.bookingId.endsWith("-sold-out")
          ? { status: "unavailable" }
          : { status: "reserved", reference: `simulated-hotel:${input.bookingId}` },
    }),
    cancelFlight: createAsyncLogic<CancelResult, { bookingId: string; reference: string }>({
      run: async () => ({ status: "cancelled" }),
    }),
  },
  requests: {
    plan: {
      schemas: { input: z.object({ destination: z.string() }), output: itinerary },
      model: "planner",
      prompt: ({ input }) =>
        `Propose one flight and hotel in ${input.destination}. Do not book anything.`,
    },
  },
});

function normalizeHotelStatus(output: HotelResult) {
  if (output.status === "reserved") return output.reference ? "reserved" : null;
  return output.status === "unavailable" ? "unavailable" : null;
}

export const bookingCompensationMachine = agent.createMachine({
  id: "booking-compensation",
  context: ({ input }) => ({
    ...input,
    itinerary: null,
    hotelStatus: null,
    compensationStatus: null,
    flightReference: null,
    hotelReference: null,
  }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        src: "plan",
        input: ({ context }) => ({ destination: context.destination }),
        onDone: ({ output }) => ({ target: "approval", context: { itinerary: output.result } }),
        onError: { target: "failed" },
      },
    },
    approval: {
      meta: {
        interaction: {
          label: "Approve the itinerary before reserving anything.",
          events: { APPROVE: { label: "Book itinerary" }, CANCEL: { label: "Cancel" } },
        },
      },
      on: { APPROVE: { target: "flight" }, CANCEL: { target: "cancelled" } },
    },
    flight: {
      invoke: {
        src: "reserveFlight",
        input: ({ context }) => {
          if (!context.itinerary) throw new Error("Missing approved itinerary");
          return { bookingId: context.bookingId, item: context.itinerary.flight };
        },
        onDone: ({ output }) => ({ target: "hotel", context: { flightReference: output } }),
        // An exception may mean the remote reservation succeeded but its reply
        // was lost. Reconcile by bookingId; never report this as clean failure.
        onError: { target: "manualRecovery" },
      },
    },
    hotel: {
      invoke: {
        src: "reserveHotel",
        input: ({ context }) => {
          if (!context.itinerary) throw new Error("Missing approved itinerary");
          return { bookingId: context.bookingId, item: context.itinerary.hotel };
        },
        // A result is only believed when it carries everything a reservation
        // needs. "reserved" without a provider reference cannot be confirmed
        // or later cancelled, so it stays unknown (`null`) and reconciles.
        onDone: ({ output }) => ({
          target: "hotelResult",
          context: {
            hotelStatus: normalizeHotelStatus(output),
            hotelReference: output.status === "reserved" ? (output.reference ?? null) : null,
          },
        }),
        // An exception is an uncertain outcome. Reconcile before compensating.
        onError: { target: "manualRecovery" },
      },
    },
    hotelResult: {
      type: "choice",
      choice: ({ context }) => {
        if (context.hotelStatus === "reserved") return { target: "booked" };
        if (context.hotelStatus === "unavailable") return { target: "compensating" };
        return { target: "manualRecovery" };
      },
    },
    compensating: {
      invoke: {
        src: "cancelFlight",
        input: ({ context }) => {
          if (context.flightReference === null)
            throw new Error("Missing flight reservation to compensate");
          return { bookingId: context.bookingId, reference: context.flightReference };
        },
        // An unconfirmed cancellation is not a compensation.
        onDone: ({ output }) => ({
          target: "compensationResult",
          context: { compensationStatus: output.status === "cancelled" ? "cancelled" : null },
        }),
        onError: { target: "manualRecovery" },
      },
    },
    compensationResult: {
      type: "choice",
      choice: ({ context }) =>
        context.compensationStatus === "cancelled"
          ? { target: "compensated" }
          : { target: "manualRecovery" },
    },
    booked: {
      type: "final",
      output: ({ context }) => ({
        bookingId: context.bookingId,
        outcome: "booked",
        flightReference: context.flightReference,
        hotelReference: context.hotelReference,
      }),
    },
    cancelled: {
      type: "final",
      output: ({ context }) => ({
        bookingId: context.bookingId,
        outcome: "cancelled",
        flightReference: context.flightReference,
        hotelReference: context.hotelReference,
      }),
    },
    compensated: {
      type: "final",
      output: ({ context }) => ({
        bookingId: context.bookingId,
        outcome: "compensated",
        flightReference: context.flightReference,
        hotelReference: context.hotelReference,
      }),
    },
    manualRecovery: {
      type: "final",
      output: ({ context }) => ({
        bookingId: context.bookingId,
        outcome: "manualRecovery",
        flightReference: context.flightReference,
        hotelReference: context.hotelReference,
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        bookingId: context.bookingId,
        outcome: "failed",
        flightReference: context.flightReference,
        hotelReference: context.hotelReference,
      }),
    },
  },
});

/** The host's real executors: one OpenAI model behind the `planner` ref. */
function liveExecutors() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY to run the booking-compensation example.");
  }
  return createAiSdkExecutors({ models });
}

export async function runBookingCompensationExample(
  options?: AgentRuntimeOptions<typeof bookingCompensationMachine> &
    AgentRunInit<typeof bookingCompensationMachine>,
) {
  const { executors = liveExecutors(), ...runOptions } = options ?? {};
  return runToQuiescence(
    createAgentRuntime(bookingCompensationMachine, {
      ...runOptions,
      executors,
    }),
    {
      input: { bookingId: "trip-1", destination: "Lisbon" },
      ...runOptions,
    },
  );
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const pending = await runBookingCompensationExample();
    if (pending.status !== "idle") throw new Error(`Expected approval wait, got ${pending.status}`);
    const result = await runBookingCompensationExample({
      snapshot: JSON.parse(JSON.stringify(pending.persist())),
      event: { type: "APPROVE" },
      actors: {
        reserveHotel: createAsyncLogic<HotelResult, BookingInput>({
          run: async () => ({ status: "unavailable" }),
        }),
      },
    });
    console.log(result.status === "done" ? result.output : result.status);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
