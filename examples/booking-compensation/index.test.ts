import { expect, test } from "vitest";
import { createAsyncLogic } from "xstate";
import { lintAgentMachine } from "@statelyai/agent";
import { bookingCompensationMachine, runBookingCompensationExample } from "./index.js";

test("approval gates reservations and a confirmed unavailable hotel compensates the flight", async () => {
  const calls: string[] = [];
  const actors = {
    reserveFlight: createAsyncLogic<string, { bookingId: string; item: string }>({
      run: async ({ input }) => {
        calls.push(`flight:${input.bookingId}`);
        return "flight-42";
      },
    }),
    reserveHotel: createAsyncLogic<{ status: "unavailable" }, { bookingId: string; item: string }>({
      run: async () => {
        calls.push("hotel");
        return { status: "unavailable" };
      },
    }),
    cancelFlight: createAsyncLogic<{ cancelled: true }, { bookingId: string; reference: string }>({
      run: async ({ input }) => {
        calls.push(`cancel:${input.reference}`);
        return { cancelled: true };
      },
    }),
  };
  const pending = await runBookingCompensationExample({ actors });
  expect(pending.status).toBe("idle");
  expect(calls).toEqual([]);
  const result = await runBookingCompensationExample({
    snapshot: JSON.parse(JSON.stringify(pending.persist())),
    event: { type: "APPROVE" },
    actors,
  });
  expect(calls).toEqual(["flight:trip-1", "hotel", "cancel:flight-42"]);
  expect(result.status).toBe("done");
  if (result.status === "done")
    expect(result.output).toMatchObject({
      outcome: "compensated",
      flightReference: "flight-42",
      hotelReference: null,
    });
});

test("failed compensation preserves the reservation reference for manual recovery", async () => {
  const pending = await runBookingCompensationExample();
  const result = await runBookingCompensationExample({
    snapshot: pending.persist(),
    event: { type: "APPROVE" },
    actors: {
      reserveHotel: createAsyncLogic<
        { status: "unavailable" },
        { bookingId: string; item: string }
      >({ run: async () => ({ status: "unavailable" }) }),
      cancelFlight: createAsyncLogic<{ cancelled: true }, { bookingId: string; reference: string }>(
        {
          run: async () => {
            throw new Error("Cancellation unavailable");
          },
        },
      ),
    },
  });
  expect(result.status).toBe("done");
  if (result.status === "done")
    expect(result.output).toMatchObject({
      outcome: "manualRecovery",
      flightReference: "simulated-flight:trip-1",
    });
});

test("uncertain hotel outcome requires reconciliation, not blind compensation", async () => {
  let compensations = 0;
  const pending = await runBookingCompensationExample();
  const result = await runBookingCompensationExample({
    snapshot: pending.persist(),
    event: { type: "APPROVE" },
    actors: {
      reserveHotel: createAsyncLogic<
        { status: "unavailable" },
        { bookingId: string; item: string }
      >({
        run: async () => {
          throw new Error("Reply lost; booking may exist");
        },
      }),
      cancelFlight: createAsyncLogic<{ cancelled: true }, { bookingId: string; reference: string }>(
        {
          run: async () => {
            compensations++;
            return { cancelled: true };
          },
        },
      ),
    },
  });
  expect(compensations).toBe(0);
  expect(result.status).toBe("done");
  if (result.status === "done") expect(result.output.outcome).toBe("manualRecovery");
});

test.each(["APPROVE", "CANCEL"] as const)(
  "%s completes the happy or cancellation path",
  async (type) => {
    const pending = await runBookingCompensationExample();
    const result = await runBookingCompensationExample({
      snapshot: pending.persist(),
      event: { type },
    });
    expect(result.status).toBe("done");
    if (result.status === "done")
      expect(result.output.outcome).toBe(type === "APPROVE" ? "booked" : "cancelled");
    expect(
      lintAgentMachine(bookingCompensationMachine).filter((d) => d.severity === "error"),
    ).toEqual([]);
  },
);

test("uncertain flight outcome retains the booking identity even without provider references", async () => {
  const pending = await runBookingCompensationExample();
  const result = await runBookingCompensationExample({
    snapshot: pending.persist(),
    event: { type: "APPROVE" },
    actors: {
      reserveFlight: createAsyncLogic<string, { bookingId: string; item: string }>({
        run: async () => {
          throw new Error("Reply lost");
        },
      }),
    },
  });
  expect(result.status).toBe("done");
  if (result.status === "done")
    expect(result.output).toEqual({
      bookingId: "trip-1",
      outcome: "manualRecovery",
      flightReference: null,
      hotelReference: null,
    });
});
