/**
 * An agent proposes an itinerary; a human approves before reservations begin.
 * If hotel booking fails, compensate the flight reservation. Compensation can
 * fail too: preserve its reference and stop for manual recovery.
 * Pattern: https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction
 * Run without credentials: pnpm tsx examples/booking-compensation/index.ts
 * All booking actors are explicitly simulated. A real host overrides them and
 * must make operations idempotent by bookingId; snapshots alone cannot provide
 * exactly-once external effects or resolve uncertain provider outcomes.
 */
import { createAsyncLogic } from "xstate";
import { z } from "zod";
import {
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type RunAgentOptions,
} from "@statelyai/agent";

const itinerary = z.object({ flight: z.string(), hotel: z.string() });
type HotelResult = { status: "reserved"; reference: string } | { status: "unavailable" };
type BookingInput = { bookingId: string; item: string };
const agent = setupAgent({
  input: z.object({ bookingId: z.string(), destination: z.string() }),
  context: z.object({
    bookingId: z.string(),
    destination: z.string(),
    itinerary: itinerary.nullable(),
    hotelStatus: z.enum(["reserved", "unavailable"]).nullable(),
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
    reserveHotel: createAsyncLogic<HotelResult, BookingInput>({
      run: async ({ input }) => ({
        status: "reserved",
        reference: `simulated-hotel:${input.bookingId}`,
      }),
    }),
    cancelFlight: createAsyncLogic<{ cancelled: true }, { bookingId: string; reference: string }>({
      run: async () => ({ cancelled: true }),
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

export const bookingCompensationMachine = agent.createMachine({
  id: "booking-compensation",
  context: ({ input }) => ({
    ...input,
    itinerary: null,
    hotelStatus: null,
    flightReference: null,
    hotelReference: null,
  }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        src: "plan",
        input: ({ context }) => ({ destination: context.destination }),
        onDone: ({ output }) => ({ target: "approval", context: { itinerary: output } }),
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
        onDone: ({ output }) => ({
          target: "hotelResult",
          context: {
            hotelStatus: output.status,
            hotelReference: output.status === "reserved" ? output.reference : null,
          },
        }),
        // An exception is an uncertain outcome. Reconcile before compensating.
        onError: { target: "manualRecovery" },
      },
    },
    hotelResult: {
      type: "choice",
      choice: ({ context }) =>
        context.hotelStatus === "reserved" ? { target: "booked" } : { target: "compensating" },
    },
    compensating: {
      invoke: {
        src: "cancelFlight",
        input: ({ context }) => {
          if (context.flightReference === null)
            throw new Error("Missing flight reservation to compensate");
          return { bookingId: context.bookingId, reference: context.flightReference };
        },
        onDone: { target: "compensated" },
        onError: { target: "manualRecovery" },
      },
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

export function runBookingCompensationExample(
  options?: RunAgentOptions<typeof bookingCompensationMachine>,
) {
  return runAgent(bookingCompensationMachine, {
    input: { bookingId: "trip-1", destination: "Lisbon" },
    executors: {
      generateText: async () => ({ output: { flight: "Flight to Lisbon", hotel: "Lisbon hotel" } }),
    },
    ...options,
  });
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
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
